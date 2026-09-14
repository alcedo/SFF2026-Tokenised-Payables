import {
  Amount,
  EmptyState,
  LedgerScroll,
  MockTxRef,
  Panel,
  Stat,
} from '@/components/primitives';
import { readEvents, readProgrammeTotals, readWorld } from '@/db/read';

/**
 * The mock explorer and the audit trail, on one screen because PRD §10 makes
 * them the same thing: "The same receipt must be reopenable from event history
 * and the mock explorer."
 *
 * Rows without a receipt are not omitted. §10 draws a firm line between
 * chain-relevant actions, which mint a receipt, and application events such as
 * approval or listing, which do not. Showing both, labelled, is what makes that
 * line legible instead of a silent gap in the history.
 */
export default async function ExplorerPage() {
  const world = await readWorld();
  const [events, totals] = await Promise.all([readEvents({ limit: 200 }), readProgrammeTotals(world)]);

  const onChain = events.filter((e) => e.txHash !== null);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Explorer</h1>
        <p className="text-[11.5px] text-ink-muted">
          Every action in the demo world, newest first. Hashes, block numbers and receipts are
          simulated; no transaction has touched a blockchain.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Events recorded" value={events.length} />
        <Stat label="With a receipt" value={onChain.length} hint="chain-relevant actions" />
        <Stat label="World date" value={world.today} hint={`epoch ${world.epoch}`} />
        <Stat
          label="Books"
          value={totals.bookDrift === 0 ? 'Balanced' : `${totals.bookDrift} adrift`}
          tone={totals.bookDrift === 0 ? 'positive' : 'critical'}
          hint="projection vs journal"
        />
      </div>

      <Panel title="Transaction log" dense>
        {events.length === 0 ? (
          <EmptyState title="Nothing has happened yet." />
        ) : (
          <LedgerScroll label="Transaction log">
            <table className="ledger">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Payable</th>
                  <th>Actor</th>
                  <th>Funding</th>
                  <th className="num">Source debit</th>
                  <th>Chain reference</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.entryId}>
                    <td className="num text-ink-faint">{String(e.seq)}</td>
                    <td className="num">{e.worldDate}</td>
                    <td className="font-medium">{e.kind.replace(/_/g, ' ')}</td>
                    <td className="text-ink-muted">{e.payableRef ?? '—'}</td>
                    <td className="text-ink-muted">{e.actorName}</td>
                    <td>{e.fundingAsset ?? '—'}</td>
                    <td>
                      {e.sourceAmountBase === null ? (
                        '—'
                      ) : (
                        <Amount value={e.sourceAmountBase} decimals={4} />
                      )}
                    </td>
                    <td>
                      {e.txHash ? (
                        <MockTxRef hash={e.txHash} block={Number(e.blockNumber)} />
                      ) : (
                        <span className="text-[11px] text-ink-faint">
                          audit event, no chain receipt
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </LedgerScroll>
        )}
      </Panel>
    </div>
  );
}
