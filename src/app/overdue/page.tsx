import Link from 'next/link';

import { Address, Amount, Field, LedgerScroll, Notice, Panel, StatusChip } from '@/components/primitives';
import { readAllPayables, readEvents, readHolders, readWorld } from '@/db/read';

/**
 * PRD §11's "Trigger overdue" control, and the recovery case from §7 and §8
 * screen 16.
 *
 * §7 is explicit that "Recovery is a read-only scenario, not an operational
 * workflow", so triggering overdue opens the seeded case rather than
 * manufacturing a default. The seeded payable is already past its due date at
 * T0, which means the presenter can reach this screen at any point in the demo
 * without moving the clock and disturbing everything else on screen.
 */
export default async function OverduePage() {
  const world = await readWorld();
  const payables = await readAllPayables(world);
  const overdue = payables.filter((p) => p.status === 'overdue');

  if (overdue.length === 0) {
    return (
      <div className="mx-auto max-w-3xl pt-6">
        <Panel title="Overdue">
          <Notice tone="info">
            Nothing is overdue right now. The seeded recovery case is TP-2026-0119, which is past
            due at T0. Reset the world to restore it.
          </Notice>
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Overdue and recovery</h1>
        <p className="text-[11.5px] text-ink-muted">
          An unpaid obligation that has passed its due date.
        </p>
      </div>

      <Notice tone="caution">
        Read-only scenario. Invoice disputes, cancellation, and live default or recovery processing
        are out of scope for this demo. Nothing on this screen can be actioned, and every name and
        figure here is invented.
      </Notice>

      {await Promise.all(
        overdue.map(async (p) => {
          const [holders, events] = await Promise.all([
            readHolders(p.id),
            readEvents({ payableId: p.id, limit: 20 }),
          ]);
          const daysPastDue = Math.abs(p.daysRemaining);

          return (
            <Panel
              key={p.id}
              title={
                <span className="flex items-center gap-2">
                  {p.ref}
                  <StatusChip status={p.status} />
                </span>
              }
            >
              <div className="grid gap-4 md:grid-cols-2">
                <dl>
                  <Field label="Anchor obligor">{p.anchorName}</Field>
                  <Field label="Original supplier">{p.supplierName}</Field>
                  <Field label="Invoice">{p.invoiceRef}</Field>
                  <Field label="Face">
                    <Amount value={p.faceBase} decimals={2} showAsset asset="XUSD" />
                  </Field>
                  <Field label="Outstanding">
                    <Amount value={p.outstandingBase} decimals={2} showAsset asset="XUSD" />
                  </Field>
                  <Field label="Due date">{p.maturityDate}</Field>
                  <Field label="Days past due">
                    <span className="text-critical">{daysPastDue}</span>
                  </Field>
                </dl>

                <dl>
                  <Field label="Grace period">Expired</Field>
                  <Field label="Recovery status">Referred to appointed liquidator</Field>
                  <Field label="Appointed liquidator">
                    Tseng &amp; Partners Restructuring
                  </Field>
                  <Field label="First demand issued">{p.maturityDate}</Field>
                  <Field label="Expected recovery">Not estimated in this demo</Field>
                  <Field label="Holders affected">{holders.length}</Field>
                </dl>
              </div>

              <div className="mt-3">
                <h3 className="mb-1 text-[10.5px] tracking-wide text-ink-muted uppercase">
                  Current holders, still owed
                </h3>
                <LedgerScroll label="Current holders">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Holder</th>
                      <th>Wallet</th>
                      <th className="num">Quantity</th>
                      <th className="num">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holders.map((h) => (
                      <tr key={h.wallet}>
                        <td>{h.entityName}</td>
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
                </LedgerScroll>
              </div>

              <div className="mt-3">
                <h3 className="mb-1 text-[10.5px] tracking-wide text-ink-muted uppercase">
                  Event history
                </h3>
                <ul className="space-y-0.5">
                  {events.map((e) => (
                    <li key={e.entryId} className="text-[11.5px] text-ink-muted">
                      <span className="num">{e.worldDate}</span> · {e.kind.replace(/_/g, ' ')} ·{' '}
                      <span className="text-ink">{e.actorName}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          );
        }),
      )}

      <Link href="/" className="inline-block text-[12px] text-accent hover:underline">
        ← Back
      </Link>
    </div>
  );
}
