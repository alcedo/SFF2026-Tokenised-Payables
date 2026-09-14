/**
 * Marketplace filtering and sorting. PRD §8 screen 9.
 *
 *   "filter by maturity, tenor, sample grade, ticket size, and yield.
 *    Default sort is yield."
 *
 * Filtering happens here, in TypeScript, rather than in the SQL that fetches
 * listings. Three of the five criteria — tenor, yield, and the maturity cutoff
 * — are derived from the demo clock and the §6 pricing formulas, which live in
 * `src/core/pricing.ts`. Pushing them into SQL would mean a second
 * implementation of the yield formula that has to agree with the first
 * forever, and the two would drift the first time §6 was revisited. The
 * marketplace is a demo order book of tens of lots, so the cost of filtering
 * in memory is nothing and the cost of a duplicate formula is real.
 *
 * The filter is a plain object parsed from the URL query, so a filtered view is
 * a shareable link and the back button behaves. Nothing here touches React or
 * the database.
 */

import { type BaseUnits, BASE_UNITS_PER_UNIT } from './money';
import type { IsoDate } from './clock';

export const GRADES = ['AAA', 'AA', 'A'] as const;
export type Grade = (typeof GRADES)[number];

export const SORTS = ['yield', 'maturity', 'tenor', 'size', 'price'] as const;
export type Sort = (typeof SORTS)[number];

export const SORT_LABEL: Record<Sort, string> = {
  yield: 'Yield, highest first',
  maturity: 'Maturity, soonest first',
  tenor: 'Tenor, shortest first',
  size: 'Ticket size, largest first',
  price: 'Price, cheapest first',
};

export interface MarketFilter {
  /** Only lots maturing on or before this date. */
  maturityBy: IsoDate | null;
  /** Days remaining, inclusive on both ends. */
  tenorMin: number | null;
  tenorMax: number | null;
  /** Empty means every grade, which is not the same as none of them. */
  grades: readonly Grade[];
  /** Listed face, in base units. */
  sizeMin: BaseUnits | null;
  sizeMax: BaseUnits | null;
  /** Annualised lender yield, in percent. */
  yieldMin: number | null;
  sort: Sort;
}

export const NO_FILTER: MarketFilter = {
  maturityBy: null,
  tenorMin: null,
  tenorMax: null,
  grades: [],
  sizeMin: null,
  sizeMax: null,
  yieldMin: null,
  sort: 'yield',
};

/** The shape a listing has to have to be filtered. Narrower than `Listing`. */
export interface Filterable {
  grade: string | null;
  listedFaceBase: BaseUnits;
  maturityDate: IsoDate;
  quote: { daysRemaining: number; lenderYieldPercent: number | null; pricePercent: number };
}

export function applyFilter<T extends Filterable>(
  listings: readonly T[],
  filter: MarketFilter,
): T[] {
  const kept = listings.filter((l) => {
    if (filter.maturityBy !== null && l.maturityDate > filter.maturityBy) return false;
    if (filter.tenorMin !== null && l.quote.daysRemaining < filter.tenorMin) return false;
    if (filter.tenorMax !== null && l.quote.daysRemaining > filter.tenorMax) return false;
    if (filter.grades.length > 0 && !filter.grades.includes(l.grade as Grade)) return false;
    if (filter.sizeMin !== null && l.listedFaceBase < filter.sizeMin) return false;
    if (filter.sizeMax !== null && l.listedFaceBase > filter.sizeMax) return false;
    // A matured lot has no forward yield (§6 shows "Due" instead), so a yield
    // floor excludes it rather than treating a missing yield as zero.
    if (filter.yieldMin !== null) {
      if (l.quote.lenderYieldPercent === null) return false;
      if (l.quote.lenderYieldPercent < filter.yieldMin) return false;
    }
    return true;
  });
  return sortListings(kept, filter.sort);
}

function sortListings<T extends Filterable>(listings: T[], sort: Sort): T[] {
  const by: Record<Sort, (a: T, b: T) => number> = {
    yield: (a, b) => (b.quote.lenderYieldPercent ?? -1) - (a.quote.lenderYieldPercent ?? -1),
    maturity: (a, b) => a.maturityDate.localeCompare(b.maturityDate),
    tenor: (a, b) => a.quote.daysRemaining - b.quote.daysRemaining,
    size: (a, b) => (a.listedFaceBase < b.listedFaceBase ? 1 : a.listedFaceBase > b.listedFaceBase ? -1 : 0),
    price: (a, b) => a.quote.pricePercent - b.quote.pricePercent,
  };
  return [...listings].sort(by[sort]);
}

/** True when the filter would change what a lender sees. Drives the Clear control. */
export function isFiltered(filter: MarketFilter): boolean {
  return (
    filter.maturityBy !== null ||
    filter.tenorMin !== null ||
    filter.tenorMax !== null ||
    filter.grades.length > 0 ||
    filter.sizeMin !== null ||
    filter.sizeMax !== null ||
    filter.yieldMin !== null
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a filter out of a URL query.
 *
 * Anything unparseable is dropped rather than rejected. A hand-edited or stale
 * link should show the marketplace, not an error page: this is a browse
 * control, and the worst outcome of ignoring a bad value is that the lender
 * sees more lots than they asked for and can see why from the controls.
 */
export function parseFilter(params: Record<string, string | string[] | undefined>): MarketFilter {
  const one = (key: string): string | null => {
    const v = params[key];
    const s = Array.isArray(v) ? v[0] : v;
    return s === undefined || s === '' ? null : s;
  };

  const int = (key: string): number | null => {
    const s = one(key);
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  const num = (key: string): number | null => {
    const s = one(key);
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  /** Display units in the URL, base units in the filter. `250000` reads as 250,000 XUSD. */
  const units = (key: string): BaseUnits | null => {
    const n = num(key);
    if (n === null || n < 0) return null;
    return (BigInt(Math.round(n * Number(BASE_UNITS_PER_UNIT))) as BaseUnits);
  };

  const maturityRaw = one('by');
  const gradesRaw = one('grade');
  const sortRaw = one('sort');

  return {
    maturityBy: maturityRaw !== null && ISO_DATE.test(maturityRaw) ? (maturityRaw as IsoDate) : null,
    tenorMin: int('tmin'),
    tenorMax: int('tmax'),
    grades:
      gradesRaw === null
        ? []
        : gradesRaw.split(',').filter((g): g is Grade => (GRADES as readonly string[]).includes(g)),
    sizeMin: units('smin'),
    sizeMax: units('smax'),
    yieldMin: num('ymin'),
    sort: (SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as Sort) : 'yield',
  };
}
