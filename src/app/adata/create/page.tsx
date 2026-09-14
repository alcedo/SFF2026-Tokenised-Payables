import { ErpPicker } from './ErpPicker';
import { Panel } from '@/components/primitives';
import { readErpInbox, readPayables, readWorld } from '@/db/read';

/**
 * PRD §8 screen 2. Create payable.
 *
 * "Manual entry or Import from ERP. The import uses a clearly simulated
 * SAP-style picker and select from a list of 10 different sample invoice
 * pre-generated for the demo."
 *
 * The picker is the primary path because it is the one the runbook uses and the
 * one that looks like the real thing. Everything about it is labelled simulated.
 */
export default async function CreatePayablePage() {
  const world = await readWorld();
  const [inbox, payables] = await Promise.all([readErpInbox(), readPayables(world)]);

  // References are sequential within the year, continuing the seeded series.
  const highest = payables
    .map((p) => Number(p.ref.match(/TP-2026-(\d+)$/)?.[1] ?? 0))
    .reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Create payable</h1>
        <p className="text-[11.5px] text-ink-muted">
          Import an approved invoice from the ERP. Creating a payable puts it in the approval queue
          as a draft; it is not issued until a checker approves and StraitsX certifies it.
        </p>
      </div>

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
    </div>
  );
}
