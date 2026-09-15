import { ExplorerLogPanel } from '@/components/explorer/ExplorerLogPanel';
import { readEvents, readProgrammeTotals, readWorld, serializeEvent } from '@/db/read';

/**
 * Standalone explorer for the runbook and deep links. The same panel opens as
 * an overlay from the header Explorer control and from a hash click.
 */
export default async function ExplorerPage() {
  const world = await readWorld();
  const [events, totals] = await Promise.all([readEvents({ limit: 200 }), readProgrammeTotals(world)]);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Explorer</h1>
        <p className="text-[11.5px] text-ink-muted">
          Every action in the demo world, newest first. Hashes, block numbers and receipts are
          simulated; no transaction has touched a blockchain. Click a hash to open the receipt.
        </p>
      </div>
      <ExplorerLogPanel
        events={events.map(serializeEvent)}
        bookDrift={totals.bookDrift}
        worldDate={world.today}
        epoch={String(world.epoch)}
      />
    </div>
  );
}
