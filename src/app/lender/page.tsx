import Link from 'next/link';

import {
  Amount,
  DaysRemaining,
  EmptyState,
  GradeBadge,
  LedgerScroll,
  Panel,
  Percent,
  Stat,
} from '@/components/primitives';
import { MarketFilters } from './MarketFilters';
import { NextActionStrip } from '@/components/NextActionStrip';
import { currentPersona } from '@/app/session';
import { deriveNextAction } from '@/core/next-action';
import { formatUnits } from '@/core/money';
import { applyFilter, isFiltered, parseFilter } from '@/core/market';
import { readMarketplace, readWorld } from '@/db/read';

/**
 * PRD §8 screen 9. Institutional marketplace.
 *
 * The default sort is yield, per §9. Listed quantity is shown alongside the
 * original invoice face wherever they differ, because a lender comparing two
 * rows needs to know whether they are looking at a whole invoice or a slice.
 *
 * The filter lives in the URL and is applied by `src/core/market.ts`, which
 * explains why the filtering is here and not in SQL. The summary figures above
 * the table describe the filtered view, not the whole book: a lender who has
 * narrowed to 30-day AAA paper wants the best yield among those, and a
 * headline number that ignored the filter would be answering a question
 * nobody asked.
 */
export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [world, params, persona] = await Promise.all([readWorld(), searchParams, currentPersona()]);
  const all = await readMarketplace(world);
  const filter = parseFilter(params);
  const listings = applyFilter(all, filter);
  const next = deriveNextAction({
    actor: { role: persona.role, name: persona.name, wallet: persona.wallet },
    payables: [],
    holdings: [],
    listings: all.map((l) => ({
      id: l.id,
      targetRef: l.targetRef,
      sellerWallet: l.sellerWallet,
      bidCount: l.bidCount,
    })),
  });

  const totalFace = listings.reduce<bigint>((acc, l) => acc + l.listedFaceBase, 0n);
  const bestYield = listings.reduce((best, l) => Math.max(best, l.quote.lenderYieldPercent ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold">Marketplace</h1>
          <p className="text-[11.5px] text-ink-muted">
            Institutional lenders only. Access is a demo permission, not real accreditation.
          </p>
        </div>
      </div>

      <NextActionStrip action={next} />

      <MarketFilters shown={listings.length} total={all.length} />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat
          label={isFiltered(filter) ? 'Lots matching' : 'Open lots'}
          value={listings.length}
          hint={isFiltered(filter) ? `of ${all.length} open` : undefined}
        />
        <Stat label="Face on offer" value={formatUnits(totalFace as never, 2)} hint="XUSD" />
        <Stat label="Best yield" value={`${bestYield.toFixed(1)}%`} hint="annualised, Actual/365" />
        <Stat label="Anchor obligor" value="ADATA" hint="every lot in this programme" />
      </div>

      <Panel title="Open listings" dense>
        {listings.length === 0 ? (
          isFiltered(filter) ? (
            <EmptyState
              title="No lot matches these filters."
              hint={`${all.length} lots are open. Clear a filter to widen the search.`}
            />
          ) : (
            <EmptyState
              title="Nothing is listed right now."
              hint="A supplier lists a payable from Request financing. Reset the world to restore the seeded listings."
            />
          )
        ) : (
          <LedgerScroll label="Open listings">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Anchor obligor</th>
                  <th>Original supplier</th>
                  <th>Grade</th>
                  <th className="num">Listed face</th>
                  <th className="num">Invoice face</th>
                  <th className="num">Ask</th>
                  <th className="num">Price</th>
                  <th className="num">Days</th>
                  <th className="num">Yield</th>
                  <th className="num">Bids</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => {
                  const partial = l.listedFaceBase !== l.invoiceFaceBase;
                  return (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/lender/${l.id}`} className="font-medium text-accent hover:underline">
                          {l.targetRef}
                        </Link>
                        {l.targetKind === 'series' ? (
                          <span className="ml-1.5 rounded-[3px] border border-rule-strong bg-surface-raised px-1 py-px text-[10px] text-ink-muted">
                            {l.memberCount} invoices
                          </span>
                        ) : null}
                      </td>
                      <td className="font-medium">{l.anchorName}</td>
                      <td className="text-ink-muted">{l.sellerName}</td>
                      <td>{l.grade ? <GradeBadge grade={l.grade} /> : '—'}</td>
                      <td>
                        <Amount value={l.listedFaceBase} decimals={2} />
                      </td>
                      <td className={partial ? '' : 'text-ink-faint'}>
                        <Amount value={l.invoiceFaceBase} decimals={2} />
                      </td>
                      <td>
                        <Amount value={l.askBase} decimals={2} />
                      </td>
                      <td>
                        <span className="num">{l.quote.pricePercent.toFixed(2)}%</span>
                      </td>
                      <td>
                        <DaysRemaining days={l.quote.daysRemaining} />
                      </td>
                      <td className="font-medium">
                        <Percent value={l.quote.lenderYieldPercent} decimals={1} />
                      </td>
                      <td>
                        <span className="num">{l.bidCount || '—'}</span>
                      </td>
                      <td className="text-right">
                        <Link
                          href={`/lender/${l.id}`}
                          className="rounded-[3px] bg-accent px-2 py-1 text-[11.5px] font-medium text-white hover:bg-accent-hover"
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </LedgerScroll>
        )}
      </Panel>

      <p className="text-[11px] text-ink-faint">
        Yield is the lender&apos;s implied annualised return on purchase price, Actual/365, with no
        compounding or fees. Grades are sample values assigned by StraitsX for this demo and are not
        external ratings or guarantees.
      </p>
    </div>
  );
}
