import Link from 'next/link';

import { DemoControls } from './DemoControls';
import { ExplorerHost } from './explorer/ExplorerHost';
import { ExplorerOpenButton } from './explorer/ExplorerOpenButton';
import { NextActionStrip } from './NextActionStrip';
import { Address } from './primitives';
import { loadNextActionSnapshot } from '@/app/next-action-data';
import { currentPersona, navFor } from '@/app/session';
import { formatClock } from '@/core/clock';
import { formatUnits } from '@/core/money';
import { deriveNextAction } from '@/core/next-action';
import { deriveTabCounts, tabCount } from '@/core/tab-badges';
import { readBalances, readPersonas, readWorld } from '@/db/read';

/**
 * The next-step strip is derived here so it follows the acting persona, not the
 * route. Balances stay in the header because PRD §10 wants them visible
 * whenever a payment is possible.
 */
export async function Shell({ children }: { children: React.ReactNode }) {
  const [persona, personas, world] = await Promise.all([
    currentPersona(),
    readPersonas(),
    readWorld(),
  ]);
  const [balances, snapshot] = await Promise.all([
    readBalances(persona.wallet),
    loadNextActionSnapshot(persona, world),
  ]);
  const next = deriveNextAction(snapshot);
  const counts = deriveTabCounts(snapshot);
  const nav = navFor(persona);

  return (
    <div className="shell-root min-h-screen">
      <DemoControls
        personas={personas.map((p) => ({
          userId: p.userId,
          name: p.name,
          role: p.role,
          entityName: p.entityName,
          wallet: p.wallet,
        }))}
        current={{
          userId: persona.userId,
          name: persona.name,
          role: persona.role,
          entityName: persona.entityName,
          wallet: persona.wallet,
        }}
        worldDate={formatClock(world.clock).replace(/ \(.*\)$/, '')}
        offsetDays={world.clock.offsetDays}
      />

      <header className="border-b border-rule bg-surface">
        <div className="chrome-primary mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-baseline gap-3">
            <Link href="/" className="text-[13px] font-semibold tracking-tight text-ink">
              ADATA Tokenised Payables
            </Link>
            <span className="text-[11px] text-ink-faint">Project BLOOM · StraitsX</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-[12px] font-medium text-ink">{persona.entityName}</div>
              <Address value={persona.wallet} />
            </div>
          </div>
        </div>

        <div className="chrome-secondary mx-auto max-w-[1600px] px-3">
          <nav className="chrome-nav gap-0.5">
            {nav.map((item) => {
              const count = tabCount(counts, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="inline-flex items-baseline gap-1 border-b-2 border-transparent px-2.5 py-1.5 text-[12.5px] text-ink-muted hover:border-rule-strong hover:text-ink"
                  aria-label={count != null ? `${item.label}, ${count} waiting` : undefined}
                >
                  {item.label}
                  {count != null ? (
                    <span className="num chrome-nav-count" aria-hidden="true">
                      {count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <div className="chrome-meta">
            <ExplorerOpenButton />
            <dl className="chrome-balances pb-1.5">
            {(['XUSD', 'USDC', 'USDT', 'XSGD'] as const).map((asset) => (
              <div key={asset} className="text-right">
                <dt className="text-[10px] tracking-wide text-ink-faint uppercase">{asset}</dt>
                <dd className="num text-[12px] font-medium text-ink">
                  {formatUnits(balances[asset], 2)}
                </dd>
              </div>
            ))}
            </dl>
          </div>
        </div>
      </header>

      <main className="mx-auto min-w-0 max-w-[1600px] space-y-3 p-3">
        <NextActionStrip action={next} />
        {children}
      </main>
      <ExplorerHost />
    </div>
  );
}
