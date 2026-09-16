import { Amount, EmptyState, LedgerScroll, MockTxRef, Panel, Stat } from '@/components/primitives';
import { fromBaseUnits } from '@/core/money';
import type { SerialEventRow } from '@/db/read';

function describeIntent(intent: Record<string, unknown>): string {
  return Object.entries(intent)
    .filter(([key]) => key !== 'kind')
    .map(([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

export function ExplorerLogPanel({
  events,
  bookDrift,
  worldDate,
  epoch,
}: {
  events: readonly SerialEventRow[];
  bookDrift: number;
  worldDate: string;
  epoch: string;
}) {
  const onChain = events.filter((e) => e.txHash !== null).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Events recorded" value={events.length} />
        <Stat label="With a receipt" value={onChain} hint="chain-relevant actions" />
        <Stat label="World date" value={worldDate} hint={`epoch ${epoch}`} />
        <Stat
          label="Books"
          value={bookDrift === 0 ? 'Balanced' : `${bookDrift} adrift`}
          tone={bookDrift === 0 ? 'positive' : 'critical'}
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
                  <th>Command</th>
                  <th>Payable</th>
                  <th>Actor</th>
                  <th>Funding</th>
                  <th className="num">Source debit</th>
                  <th>Chain reference</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const command = describeIntent(e.intent);
                  return (
                  <tr key={e.entryId}>
                    <td className="num text-ink-faint">{e.seq}</td>
                    <td className="num">{e.worldDate}</td>
                    <td className="font-medium">{e.kind.replace(/_/g, ' ')}</td>
                    <td className="max-w-[28ch] truncate text-[11px] text-ink-faint" title={command}>
                      {command || '—'}
                    </td>
                    <td className="text-ink-muted">{e.payableRef ?? '—'}</td>
                    <td className="text-ink-muted">{e.actorName}</td>
                    <td>{e.fundingAsset ?? '—'}</td>
                    <td>
                      {e.sourceAmountBase === null ? (
                        '—'
                      ) : (
                        <Amount value={fromBaseUnits(e.sourceAmountBase)} decimals={4} />
                      )}
                    </td>
                    <td>
                      {e.txHash ? (
                        <MockTxRef hash={e.txHash} block={e.blockNumber ? Number(e.blockNumber) : undefined} />
                      ) : (
                        <span className="text-[11px] text-ink-faint">audit event, no chain receipt</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </LedgerScroll>
        )}
      </Panel>
    </div>
  );
}
