import { Panel, Stat } from '@/components/primitives';
import { clockAt, formatClock, parseIsoDate } from '@/core/clock';
import { fromWholeUnits } from '@/core/money';
import { priceFromPercent, quote } from '@/core/pricing';

/**
 * Placeholder home. Replaced by the persona-routed dashboards once the data
 * layer lands; kept now so the shell builds and deploys end to end.
 */
export default function Home() {
  const clock = clockAt(parseIsoDate('2026-10-01'));
  const face = fromWholeUnits(250_000);
  const q = quote(face, priceFromPercent(face, 9785), 90);

  return (
    <main className="mx-auto max-w-5xl p-4">
      <h1 className="mb-3 text-[15px] font-semibold">ADATA Tokenised Payables</h1>
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Demo clock" value={formatClock(clock)} />
        <Stat label="Worked example face" value="250,000.00" hint="XUSD" />
        <Stat label="Proceeds at 97.85%" value="244,625.00" hint="XUSD" />
        <Stat label="Lender yield" value={`${q.lenderYieldPercent?.toFixed(1)}%`} hint="90 days" />
      </div>
      <Panel title="Build status">
        <p className="text-ink-muted">
          Core pricing, lifecycle and clock are in place and tested against the PRD. Screens follow.
        </p>
      </Panel>
    </main>
  );
}
