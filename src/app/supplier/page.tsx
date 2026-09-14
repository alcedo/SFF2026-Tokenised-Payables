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
import { ActionButton } from '@/components/ActionButton';
import { acceptReceipt, rejectReceipt } from '@/app/actions';
import { currentPersona } from '@/app/session';
import { formatUnits } from '@/core/money';
import { priceFromPercent, quote } from '@/core/pricing';
import { readBalances, readHoldings, readWorld } from '@/db/read';

/**
 * PRD §8 screen 6. The supplier's inbox and holdings.
 *
 * PRD §2 makes one thing an acceptance criterion: "The supplier dashboard shows
 * sale proceeds, annualised financing cost, and the indicative 18% bank
 * benchmark without opening another screen." So the comparison is on this page,
 * per holding, computed at the indicative price rather than hidden behind a
 * financing flow the viewer has to go and find.
 */

/** PRD §12 keeps these labelled as scenario assumptions, not quotes. */
const BANK_BENCHMARK_PERCENT = 18;
const INDICATIVE_ASK_BPS = 9785; // 97.85%, the PRD's worked example

export default async function SupplierPage() {
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const [holdings, balances] = await Promise.all([
    readHoldings(persona.wallet, world),
    readBalances(persona.wallet),
  ]);

  const totalFace = holdings.reduce<bigint>((acc, h) => acc + h.quantityBase, 0n);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">My tokenised payables</h1>
        <p className="text-[11.5px] text-ink-muted">
          {persona.entityName}. Each row is an approved ADATA invoice you hold as a token. Sell all
          or part of one for early payment, or hold it to maturity.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Payables held" value={holdings.length} />
        <Stat label="Face held" value={formatUnits(totalFace as never, 2)} hint="XUSD" />
        <Stat label="XUSD balance" value={formatUnits(balances.XUSD, 2)} hint="proceeds received" />
        <Stat
          label="Bank benchmark"
          value={`${BANK_BENCHMARK_PERCENT}%`}
          hint="scenario assumption"
        />
      </div>

      {holdings.length === 0 ? (
        <Panel dense>
          <EmptyState
            title="No payables yet."
            hint="ADATA issues a payable to your wallet once an invoice is approved and certified."
          />
        </Panel>
      ) : (
        holdings.map((h) => {
          const live = h.payable.daysRemaining > 0;
          const indicativePrice = priceFromPercent(h.quantityBase, INDICATIVE_ASK_BPS);
          const q = live
            ? quote(h.quantityBase, indicativePrice, h.payable.daysRemaining)
            : null;
          const saving = q?.annualisedDiscountCostPercent
            ? BANK_BENCHMARK_PERCENT - q.annualisedDiscountCostPercent
            : null;

          return (
            <Panel
              key={h.payable.id}
              title={
                <span className="flex items-center gap-2">
                  {h.payable.ref}
                  <StatusChip status={h.payable.status} />
                  <MarketChip listed={h.listedBase > 0n} />
                </span>
              }
              action={
                h.receipt === 'pending' ? null : live && h.freeBase > 0n ? (
                  <Link
                    href={`/supplier/finance/${h.payable.id}`}
                    className="rounded-[3px] bg-accent px-2 py-1 text-[11.5px] font-medium text-white hover:bg-accent-hover"
                  >
                    Request financing
                  </Link>
                ) : null
              }
            >
              {/* PRD §3 question 7 and §8 screen 6: the inbox. A payable the
                  supplier has not taken delivery of is visible but not yet
                  actionable, and they may decline it. */}
              {h.receipt === 'pending' ? (
                <div className="mb-3 rounded-[4px] border border-caution/30 bg-caution-soft p-3">
                  <h3 className="text-[12.5px] font-semibold text-caution">
                    Awaiting your acceptance
                  </h3>
                  <p className="mt-0.5 mb-2 text-[12px] text-ink">
                    {h.payable.anchorName} has issued this payable to your wallet. Accept it to hold
                    or finance it. Declining returns the full quantity to {h.payable.anchorName};
                    the obligation itself does not go away.
                  </p>
                  <div className="flex flex-wrap items-start gap-3">
                    <ActionButton label="Accept" action={acceptReceipt} args={[h.payable.id]} />
                    <ActionButton
                      label="Decline"
                      variant="secondary"
                      confirm={`Returns all ${formatUnits(h.quantityBase, 2)} XUSD of face to ${h.payable.anchorName}. You cannot undo this.`}
                      action={rejectReceipt}
                      args={[h.payable.id, persona.wallet]}
                    />
                  </div>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                <div className="min-w-0">
                  <LedgerScroll label="Holding facts">
                  <table className="ledger">
                    <tbody>
                      <tr>
                        <td className="text-ink-muted">Anchor obligor</td>
                        <td className="font-medium">{h.payable.anchorName}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Invoice</td>
                        <td>{h.payable.invoiceRef}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Invoice face</td>
                        <td>
                          <Amount value={h.payable.faceBase} decimals={4} showAsset asset="XUSD" />
                        </td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">You hold</td>
                        <td>
                          <Amount value={h.quantityBase} decimals={4} showAsset asset="XUSD" />
                        </td>
                      </tr>
                      {h.listedBase > 0n ? (
                        <tr>
                          <td className="text-ink-muted">Listed (locked)</td>
                          <td>
                            <Amount value={h.listedBase} decimals={4} />
                          </td>
                        </tr>
                      ) : null}
                      <tr>
                        <td className="text-ink-muted">Grade</td>
                        <td>{h.payable.grade ? <GradeBadge grade={h.payable.grade} /> : '—'}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Maturity</td>
                        <td className="num">{h.payable.maturityDate}</td>
                      </tr>
                      <tr>
                        <td className="text-ink-muted">Days remaining</td>
                        <td>
                          <DaysRemaining days={h.payable.daysRemaining} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  </LedgerScroll>
                </div>

                {/* The financing comparison PRD §2 requires on this screen. */}
                <div className="rounded-[4px] border border-rule bg-surface-sunken p-3">
                  <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                    Sell now, or hold to maturity
                  </h3>
                  {q ? (
                    <>
                      <dl className="space-y-1.5">
                        <Row label={`Sale proceeds at ${(INDICATIVE_ASK_BPS / 100).toFixed(2)}%`}>
                          <Amount value={q.price} decimals={2} showAsset asset="XUSD" />
                        </Row>
                        <Row label="You give up">
                          <Amount value={q.discount} decimals={2} showAsset asset="XUSD" />
                        </Row>
                        <Row label="Annualised financing cost">
                          <span className="font-semibold text-positive">
                            <Percent value={q.annualisedDiscountCostPercent} decimals={1} />
                          </span>
                        </Row>
                        <Row label="Your bank quotes">
                          <span className="num text-critical">{BANK_BENCHMARK_PERCENT}.0%</span>
                        </Row>
                        <Row label="At maturity instead">
                          <Amount value={h.quantityBase} decimals={2} showAsset asset="XUSD" />
                        </Row>
                      </dl>
                      {saving !== null ? (
                        <p className="mt-2 border-t border-rule pt-2 text-[12px] text-ink">
                          Financing here costs{' '}
                          <strong className="text-positive">{saving.toFixed(1)} points less</strong>{' '}
                          per year than the bank benchmark, and pays out{' '}
                          {h.payable.daysRemaining} days early.
                        </p>
                      ) : null}
                      <p className="mt-1.5 text-[10.5px] text-ink-faint">
                        Indicative only, at the suggested price. The 18% bank rate is a scenario
                        assumption. Actual cost follows the price you set and the days remaining.
                      </p>
                    </>
                  ) : (
                    <p className="text-[12px] text-ink-muted">
                      {h.payable.status === 'overdue'
                        ? 'Past due. ADATA has not yet settled this obligation.'
                        : 'At maturity. ADATA pays face value for the quantity you hold.'}
                    </p>
                  )}
                </div>
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-ink-muted">{label}</dt>
      <dd className="text-[12.5px]">{children}</dd>
    </div>
  );
}
