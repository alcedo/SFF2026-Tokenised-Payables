import Link from 'next/link';

import { ErpPicker } from './ErpPicker';
import { ManualEntry } from './ManualEntry';
import { Panel } from '@/components/primitives';
import { readEntities, readErpInbox, readPayables, readWorld } from '@/db/read';

/**
 * PRD §8 screen 2. Create payable.
 *
 * "Manual entry or Import from ERP. The import uses a clearly simulated
 * SAP-style picker and select from a list of 10 different sample invoice
 * pre-generated for the demo."
 *
 * The picker is the default because it is the one the runbook uses and the one
 * that looks like the real thing. Everything about it is labelled simulated.
 * Manual entry is for the invoice the register does not have, and both produce
 * the same draft through the same `create_payable` intent, so the approval
 * queue cannot tell them apart and neither can the audit trail.
 *
 * Which path is showing lives in the URL rather than in component state, so the
 * page stays a server component and a presenter can link straight to either.
 */
export default async function CreatePayablePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const [world, { mode }] = await Promise.all([readWorld(), searchParams]);
  const [inbox, payables, suppliers] = await Promise.all([
    readErpInbox(),
    readPayables(world),
    readEntities('supplier'),
  ]);

  const manual = mode === 'manual';

  // A payable issues to its supplier's wallet and waits for that supplier to
  // accept delivery, so only suppliers with a live account can be offered.
  // The seed includes tier-2 counterparties who sold everything and no longer
  // have one; they are real history, not candidates for a new payable.
  const onboarded = suppliers.filter((s) => s.userCount > 0);

  // References are sequential within the year, continuing the seeded series.
  const highest = payables
    .map((p) => Number(p.ref.match(/TP-2026-(\d+)$/)?.[1] ?? 0))
    .reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Create payable</h1>
        <p className="text-[11.5px] text-ink-muted">
          Import an approved invoice from the ERP, or enter one by hand. Creating a payable puts it
          in the approval queue as a draft; it is not issued until a checker approves and StraitsX
          certifies it.
        </p>
      </div>

      <div className="flex gap-1">
        <Tab href="/adata/create" active={!manual}>
          Import from ERP
        </Tab>
        <Tab href="/adata/create?mode=manual" active={manual}>
          Manual entry
        </Tab>
      </div>

      {manual ? (
        <Panel title="Manual entry" dense>
          <ManualEntry
            worldDate={world.today}
            nextSequence={highest + 1}
            suppliers={onboarded.map((s) => ({
              id: s.id,
              name: s.name,
              certification: s.certification,
            }))}
          />
        </Panel>
      ) : (
        <Panel title="Import from ERP" dense>
          <ErpPicker
            worldDate={world.today}
            nextSequence={highest + 1}
            invoices={inbox.map((i) => ({
              id: i.id,
              docNo: i.docNo,
              supplierName: i.supplierName,
              invoiceRef: i.invoiceRef,
              amountBase: i.amountBase.toString(),
              termsDays: i.termsDays,
              approvedOn: i.approvedOn,
              costCentre: i.costCentre,
              consumed: i.consumed,
            }))}
          />
        </Panel>
      )}
    </div>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-[3px] border px-2.5 py-1.5 text-[12px] font-medium ${
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-rule-strong bg-surface text-ink-muted hover:bg-surface-sunken'
      }`}
    >
      {children}
    </Link>
  );
}
