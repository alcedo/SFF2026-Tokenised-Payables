import { FundingPanel } from './FundingPanel';
import {
  Address,
  Amount,
  DaysRemaining,
  EmptyState,
  Field,
  LedgerScroll,
  Panel,
  StatusChip,
} from '@/components/primitives';
import { readAllPayables, readBalances, readHolders, readWorld, serializeBalances } from '@/db/read';
import { currentPersona } from '@/app/session';

/**
 * PRD §8 screen 4. Settlement.
 *
 * The screen exists to make two things legible before ADATA commits: who is
 * owed, and how much each of them gets; and what leaves ADATA's wallet, in the
 * asset it chooses to pay with. A payable that was sold in slices has several
 * current holders, and §7 requires each to be credited in proportion to the
 * quantity they hold, against a single debit from ADATA.
 */
export default async function SettlementPage() {
  const world = await readWorld();
  const persona = await currentPersona();
  const payables = await readAllPayables(world);

  const due = payables.filter((p) => p.status === 'matured' || p.status === 'overdue');
  const anchorWallet = '0xada7a0000000000000000000000000000000c21d';
  const balances = await readBalances(anchorWallet);
  const cashBalances = serializeBalances(balances);

  const withHolders = await Promise.all(
    due.map(async (p) => ({ payable: p, holders: await readHolders(p.id) })),
  );

  const totalDue = due.reduce<bigint>((acc, p) => acc + p.outstandingBase, 0n);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Settlement</h1>
        <p className="text-[11.5px] text-ink-muted">
          ADATA pays face value for the quantity each current holder still owns. Advancing the clock
          does not fund an obligation; settlement is always an explicit act.
        </p>
      </div>

      {withHolders.length === 0 ? (
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
              <Field label="Payables due">{due.length}</Field>
              <Field label="Total obligation">
                <Amount value={totalDue as never} decimals={2} showAsset asset="XUSD" />
              </Field>
              <Field label="ADATA XUSD balance">
                <Amount value={balances.XUSD} decimals={2} showAsset asset="XUSD" />
              </Field>
            </Panel>
          </div>

          {withHolders.map(({ payable, holders }) => (
            <Panel
              key={payable.id}
              title={
                <span className="flex items-center gap-2">
                  {payable.ref}
                  <StatusChip status={payable.status} />
                </span>
              }
            >
              <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
                <div>
                  <p className="mb-2 text-[11.5px] text-ink-muted">
                    {holders.length === 1
                      ? 'One current holder.'
                      : `${holders.length} current holders. Each is credited the face of the quantity they hold.`}
                  </p>
                  <LedgerScroll label="Holders">
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
                      {holders.map((h) => (
                        <tr key={h.wallet}>
                          <td className="font-medium">{h.entityName}</td>
                          <td>
                            <Address value={h.wallet} />
                          </td>
                          <td>
                            <Amount value={h.quantityBase} decimals={4} />
                          </td>
                          <td>
                            {/* Face and quantity are the same base units, so a
                                holder's credit IS their quantity. No pro-rata
                                rounding is possible. */}
                            <Amount value={h.quantityBase} decimals={2} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </LedgerScroll>
                </div>

                <div className="space-y-2">
                  <Field label="Invoice face">
                    <Amount value={payable.faceBase} decimals={2} />
                  </Field>
                  <Field label="Outstanding">
                    <Amount value={payable.outstandingBase} decimals={2} />
                  </Field>
                  <Field label="Maturity">{payable.maturityDate}</Field>
                  <Field label="Status">
                    <DaysRemaining days={payable.daysRemaining} />
                  </Field>
                  <FundingPanel
                    actorRole={persona.role}
                    payableId={payable.id}
                    outstandingBase={payable.outstandingBase.toString()}
                    holderCount={holders.length}
                    balances={cashBalances}
                    xsgdPerXusdE6={world.xsgdPerXusdE6.toString()}
                  />
                </div>
              </div>
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}
