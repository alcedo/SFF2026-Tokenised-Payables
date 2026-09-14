import { ActionButton } from '@/components/ActionButton';
import {
  Address,
  Amount,
  DaysRemaining,
  EmptyState,
  Field,
  Panel,
  StatusChip,
} from '@/components/primitives';
import { settleMaturity } from '@/app/actions';
import { type BaseUnits, formatUnits } from '@/core/money';
import { type Holder, type PayableRow, readBalances, readHolders, readPayables, readWorld } from '@/db/read';

/**
 * PRD §8 screen 4. Settlement.
 *
 * The screen exists to make one thing legible before ADATA commits: who is
 * owed, and how much each of them gets. A payable that was sold in slices has
 * several current holders, and §7 requires each to be credited in proportion to
 * the quantity they hold, against a single debit from ADATA.
 *
 * A series is one purchase and settlement lot (PRD §6), so its members appear
 * as one panel with one Fund control. Settling any member redeems the rest in
 * the same ledger entry.
 */
interface Lot {
  key: string;
  title: string;
  series: boolean;
  memberCount: number;
  payables: PayableRow[];
  holders: Holder[];
  outstandingBase: BaseUnits;
  settleId: string;
}

function groupDue(due: PayableRow[]): { key: string; title: string; payables: PayableRow[] }[] {
  const lots: { key: string; title: string; payables: PayableRow[] }[] = [];
  const seriesSeen = new Set<string>();
  for (const p of due) {
    if (p.seriesRef) {
      if (seriesSeen.has(p.seriesRef)) continue;
      seriesSeen.add(p.seriesRef);
      const members = due.filter((x) => x.seriesRef === p.seriesRef).sort((a, b) => a.id.localeCompare(b.id));
      lots.push({ key: p.seriesRef, title: p.seriesRef, payables: members });
    } else {
      lots.push({ key: p.id, title: p.ref, payables: [p] });
    }
  }
  return lots;
}

function mergeHolders(rows: Holder[]): Holder[] {
  const byWallet = new Map<string, Holder>();
  for (const h of rows) {
    const prev = byWallet.get(h.wallet);
    if (!prev) {
      byWallet.set(h.wallet, { ...h });
      continue;
    }
    byWallet.set(h.wallet, {
      ...prev,
      quantityBase: (prev.quantityBase + h.quantityBase) as BaseUnits,
      freeBase: (prev.freeBase + h.freeBase) as BaseUnits,
      listedBase: (prev.listedBase + h.listedBase) as BaseUnits,
    });
  }
  return [...byWallet.values()].sort((a, b) => (a.quantityBase < b.quantityBase ? 1 : -1));
}

export default async function SettlementPage() {
  const world = await readWorld();
  const payables = await readPayables(world, { includeSeriesMembers: true });

  const due = payables.filter((p) => p.status === 'matured' || p.status === 'overdue');
  const anchorWallet = '0xada7a0000000000000000000000000000000c21d';
  const balances = await readBalances(anchorWallet);

  const lots: Lot[] = await Promise.all(
    groupDue(due).map(async (g) => {
      const holderRows = (await Promise.all(g.payables.map((p) => readHolders(p.id)))).flat();
      const outstandingBase = g.payables.reduce<bigint>((acc, p) => acc + p.outstandingBase, 0n) as BaseUnits;
      return {
        key: g.key,
        title: g.title,
        series: g.payables.length > 1 || Boolean(g.payables[0]?.seriesRef),
        memberCount: g.payables.length,
        payables: g.payables,
        holders: mergeHolders(holderRows),
        outstandingBase,
        settleId: g.payables[0]!.id,
      };
    }),
  );

  const totalDue = lots.reduce<bigint>((acc, lot) => acc + lot.outstandingBase, 0n);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Settlement</h1>
        <p className="text-[11.5px] text-ink-muted">
          ADATA pays face value for the quantity each current holder still owns. Advancing the clock
          does not fund an obligation; settlement is always an explicit act. A series lot settles in
          one operation.
        </p>
      </div>

      {lots.length === 0 ? (
        <Panel dense>
          <EmptyState
            title="Nothing is due."
            hint="Fast-forward the demo clock to a maturity date, or use Jump to next maturity in the demo controls."
          />
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Panel>
              <Field label="Lots due">{lots.length}</Field>
              <Field label="Total obligation">
                <Amount value={totalDue as never} decimals={2} showAsset asset="XUSD" />
              </Field>
              <Field label="ADATA XUSD balance">
                <Amount value={balances.XUSD} decimals={2} showAsset asset="XUSD" />
              </Field>
            </Panel>
          </div>

          {lots.map((lot) => {
            const head = lot.payables[0]!;
            return (
              <Panel
                key={lot.key}
                title={
                  <span className="flex items-center gap-2">
                    {lot.title}
                    <StatusChip status={head.status} />
                  </span>
                }
              >
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
                  <div>
                    <p className="mb-2 text-[11.5px] text-ink-muted">
                      {lot.series
                        ? `${lot.memberCount} invoices in this lot. Settlement posts one journal that redeems every member together. `
                        : null}
                      {lot.holders.length === 1}
                        ? 'One current holder.'
                        : `${lot.holders.length} current holders. Each is credited the face of the quantity they hold.`}
                    </p>
                    <table className="ledger">
                      <thead>
                        <tr>
                          <th>Holder</th>
                          <th>Wallet</th>
                          <th className="num">Quantity</th>
                          <th className="num">XUSD credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lot.holders.map((h) => (
                          <tr key={h.wallet}>
                            <td className="font-medium">{h.entityName}</td>
                            <td>
                              <Address value={h.wallet} />
                            </td>
                            <td>
                              <Amount value={h.quantityBase} decimals={4} />
                            </td>
                            <td>
                              <Amount value={h.quantityBase} decimals={2} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="space-y-2">
                    <Field label={lot.series ? 'Lot face' : 'Invoice face'}>
                      <Amount value={lot.outstandingBase} decimals={2} />
                    </Field>
                    <Field label="Outstanding">
                      <Amount value={lot.outstandingBase} decimals={2} />
                    </Field>
                    <Field label="Maturity">{head.maturityDate}</Field>
                    <Field label="Status">
                      <DaysRemaining days={head.daysRemaining} />
                    </Field>
                    <Field label="Source debit">
                      <Amount value={lot.outstandingBase} decimals={2} showAsset asset="XUSD" />
                    </Field>

                    <div className="pt-1">
                      <ActionButton
                        label="Fund settlement"
                        confirm={
                          <>
                            Debits ADATA {formatUnits(lot.outstandingBase, 2)} XUSD and credits{' '}
                            {lot.holders.length === 1 ? 'the holder' : `all ${lot.holders.length} holders`}
                            {lot.series ? `, redeeming all ${lot.memberCount} invoices` : ''} in one
                            operation. The lot is then settled and cannot move again.
                          </>
                        }
                        disabled={balances.XUSD < lot.outstandingBase}
                        disabledReason="ADATA does not hold enough XUSD. Use Simulate top-up."
                        action={settleMaturity}
                        args={[lot.settleId]}
                      />
                    </div>
                  </div>
                </div>
              </Panel>
            );
          })}
        </>
      )}
    </div>
  );
}
