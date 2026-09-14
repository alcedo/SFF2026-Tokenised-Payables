import Link from 'next/link';

import {
  Amount,
  DaysRemaining,
  EmptyState,
  GradeBadge,
  LedgerScroll,
  MarketChip,
  Panel,
  Percent,
  Stat,
  StatusChip,
} from '@/components/primitives';
import { currentPersona } from '@/app/session';
import { type BaseUnits, formatUnits } from '@/core/money';
import { quote } from '@/core/pricing';
import { readBalances, readHoldings, readPayables, readWorld } from '@/db/read';

/**
 * PRD §8 screen 12. Portfolio.
 *
 * "Current holdings by quantity, purchase price for that quantity, invoice
 * face, remaining days, maturity ladder, purchase-price-weighted entry yield,
 * realised gross returns, and the overdue position."
 *
 * The entry yield is weighted by purchase price rather than by face, because
 * that is what the money actually earned: a position bought cheap contributes
 * its own cash-on-cash return in proportion to the cash deployed.
 */
export default async function PortfolioPage() {
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const [holdings, balances, allPayables] = await Promise.all([
    readHoldings(persona.wallet, world),
    readBalances(persona.wallet),
    readPayables(world),
  ]);

  const priced = holdings.map((h) => ({
    ...h,
    quoted:
      h.costBase !== null && h.payable.daysRemaining > 0
        ? quote(h.quantityBase, h.costBase, h.payable.daysRemaining)
        : null,
  }));

  const deployed = priced.reduce<bigint>((acc, h) => acc + (h.costBase ?? 0n), 0n);
  const faceHeld = priced.reduce<bigint>((acc, h) => acc + h.quantityBase, 0n);

  // Purchase-price-weighted entry yield. Weighting by cost, not by face.
  const weighted =
    deployed > 0n
      ? priced.reduce(
          (acc, h) =>
            acc + (h.quoted?.lenderYieldPercent ?? 0) * (Number(h.costBase ?? 0n) / Number(deployed)),
          0,
        )
      : null;

  // Realised: settled payables this wallet bought and was paid face on.
  const settled = allPayables.filter((p) => p.status === 'settled');
  const overdue = priced.filter((h) => h.payable.status === 'overdue');

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Portfolio</h1>
        <p className="text-[11.5px] text-ink-muted">
          {persona.entityName}. Every position is an ADATA obligation maturing on a fixed date.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Positions" value={priced.length} />
        <Stat label="Face held" value={formatUnits(faceHeld as BaseUnits, 2)} hint="XUSD at maturity" />
        <Stat label="Cash deployed" value={formatUnits(deployed as BaseUnits, 2)} hint="purchase price" />
        <Stat
          label="Entry yield"
          value={weighted === null ? '—' : `${weighted.toFixed(1)}%`}
          hint="weighted by purchase price"
        />
        <Stat label="XUSD balance" value={formatUnits(balances.XUSD, 2)} />
      </div>

      <Panel title="Holdings" dense>
        {priced.length === 0 ? (
          <EmptyState
            title="No positions yet."
            hint="Buy a payable from the marketplace to build a portfolio."
          />
        ) : (
          <LedgerScroll label="Holdings">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Anchor</th>
                  <th>Grade</th>
                  <th className="num">Quantity</th>
                  <th className="num">Invoice face</th>
                  <th className="num">Purchase price</th>
                  <th className="num">Days</th>
                  <th className="num">Entry yield</th>
                  <th>Maturity</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {priced.map((h) => (
                  <tr key={h.payable.id}>
                    <td className="font-medium">{h.payable.ref}</td>
                    <td className="text-ink-muted">{h.payable.anchorName}</td>
                    <td>{h.payable.grade ? <GradeBadge grade={h.payable.grade} /> : '—'}</td>
                    <td>
                      <Amount value={h.quantityBase} decimals={4} />
                    </td>
                    <td className="text-ink-faint">
                      <Amount value={h.payable.faceBase} decimals={2} />
                    </td>
                    <td>{h.costBase === null ? '—' : <Amount value={h.costBase} decimals={2} />}</td>
                    <td>
                      <DaysRemaining days={h.payable.daysRemaining} />
                    </td>
                    <td>
                      <Percent value={h.quoted?.lenderYieldPercent ?? null} decimals={1} />
                    </td>
                    <td className="num">{h.payable.maturityDate}</td>
                    <td className="whitespace-nowrap">
                      <StatusChip status={h.payable.status} />
                      <MarketChip listed={h.listedBase > 0n} />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {h.freeBase > 0n && h.payable.daysRemaining > 0 ? (
                        <>
                          <Link
                            href={`/supplier/finance/${h.payable.id}`}
                            className="text-[11.5px] text-accent hover:underline"
                          >
                            Relist
                          </Link>
                          <span className="mx-1 text-ink-faint">·</span>
                          <Link
                            href={`/transfer?payable=${h.payable.id}`}
                            className="text-[11.5px] text-accent hover:underline"
                          >
                            Send
                          </Link>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </LedgerScroll>
        )}
      </Panel>

      {/* PRD §8 screen 12 asks for the maturity ladder explicitly. */}
      {priced.length > 0 ? (
        <Panel title="Maturity ladder" dense>
          <LedgerScroll label="Maturity ladder">
          <table className="ledger">
            <thead>
              <tr>
                <th>Maturity</th>
                <th className="num">Days</th>
                <th className="num">Face falling due</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(
                priced.reduce<Record<string, { face: bigint; refs: string[]; days: number }>>(
                  (acc, h) => {
                    const key = h.payable.maturityDate;
                    acc[key] ??= { face: 0n, refs: [], days: h.payable.daysRemaining };
                    acc[key].face += h.quantityBase;
                    acc[key].refs.push(h.payable.ref);
                    return acc;
                  },
                  {},
                ),
              )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, row]) => (
                  <tr key={date}>
                    <td className="num">{date}</td>
                    <td>
                      <DaysRemaining days={row.days} />
                    </td>
                    <td>
                      <Amount value={row.face as BaseUnits} decimals={2} />
                    </td>
                    <td className="text-ink-muted">{row.refs.join(', ')}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          </LedgerScroll>
        </Panel>
      ) : null}

      {overdue.length > 0 ? (
        <Panel title="Overdue position">
          <p className="text-[12px] text-ink-muted">
            {overdue[0]!.payable.ref} passed its due date on {overdue[0]!.payable.maturityDate} and
            remains unpaid. This is a read-only showcase scenario; there is no recovery workflow
            behind it.
          </p>
        </Panel>
      ) : null}

      {settled.length > 0 ? (
        <Panel title="Realised" dense>
          <LedgerScroll label="Realised">
          <table className="ledger">
            <thead>
              <tr>
                <th>Reference</th>
                <th className="num">Face received</th>
                <th>Settled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {settled.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.ref}</td>
                  <td>
                    <Amount value={p.faceBase} decimals={2} />
                  </td>
                  <td className="num">{p.maturityDate}</td>
                  <td>
                    <StatusChip status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </LedgerScroll>
        </Panel>
      ) : null}
    </div>
  );
}
