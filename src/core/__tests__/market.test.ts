/**
 * PRD §8 screen 9: "filter by maturity, tenor, sample grade, ticket size, and
 * yield. Default sort is yield."
 *
 * Each filter is tested for what it keeps AND what it drops, because a filter
 * that silently keeps everything looks identical to a working one on a page
 * where the lender cannot count the rows.
 */

import { describe, expect, it } from 'vitest';

import { parseIsoDate } from '../clock';
import { fromWholeUnits } from '../money';
import { applyFilter, type Filterable, isFiltered, NO_FILTER, parseFilter } from '../market';

function lot(
  ref: string,
  grade: string | null,
  faceWhole: number,
  days: number,
  yieldPercent: number | null,
  maturity = '2026-12-30',
): Filterable & { ref: string } {
  return {
    ref,
    grade,
    listedFaceBase: fromWholeUnits(faceWhole),
    maturityDate: parseIsoDate(maturity),
    quote: { daysRemaining: days, lenderYieldPercent: yieldPercent, pricePercent: 97.85 },
  };
}

const BOOK = [
  lot('small-aaa', 'AAA', 48_000, 20, 6.4, '2026-10-20'),
  lot('mid-aa', 'AA', 250_000, 90, 8.9, '2026-12-30'),
  lot('large-a', 'A', 1_200_000, 150, 12.3, '2027-02-28'),
  lot('ungraded', null, 75_000, 45, 9.1, '2026-11-14'),
  lot('matured', 'AAA', 90_000, 0, null, '2026-09-30'),
];

const refs = (rows: { ref: string }[]) => rows.map((r) => r.ref);

describe('no filter', () => {
  it('keeps every lot and sorts by yield, highest first', () => {
    expect(refs(applyFilter(BOOK, NO_FILTER))).toEqual([
      'large-a',
      'ungraded',
      'mid-aa',
      'small-aaa',
      'matured',
    ]);
  });

  it('is not reported as filtered', () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
  });

  it('does not mutate the input', () => {
    const before = refs(BOOK);
    applyFilter(BOOK, { ...NO_FILTER, sort: 'tenor' });
    expect(refs(BOOK)).toEqual(before);
  });
});

describe('grade', () => {
  it('keeps only the grades asked for', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, grades: ['AAA'] }))).toEqual([
      'small-aaa',
      'matured',
    ]);
  });

  it('treats several grades as a union', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, grades: ['AA', 'A'] }))).toEqual([
      'large-a',
      'mid-aa',
    ]);
  });

  it('drops an ungraded lot when any grade is selected', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, grades: ['AAA', 'AA', 'A'] }))).not.toContain(
      'ungraded',
    );
  });
});

describe('tenor', () => {
  it('bounds days remaining inclusively at both ends', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, tenorMin: 20, tenorMax: 45 }))).toEqual([
      'ungraded',
      'small-aaa',
    ]);
  });

  it('a maximum alone keeps everything shorter, including a matured lot', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, tenorMax: 30 }))).toEqual([
      'small-aaa',
      'matured',
    ]);
  });
});

describe('ticket size', () => {
  it('bounds the listed face, not the invoice face', () => {
    const filter = { ...NO_FILTER, sizeMin: fromWholeUnits(100_000), sizeMax: fromWholeUnits(500_000) };
    expect(refs(applyFilter(BOOK, filter))).toEqual(['mid-aa']);
  });

  it('a floor alone keeps everything larger', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, sizeMin: fromWholeUnits(90_000) }))).toEqual([
      'large-a',
      'mid-aa',
      'matured',
    ]);
  });
});

describe('yield', () => {
  it('keeps lots at or above the floor', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, yieldMin: 8.9 }))).toEqual(['large-a', 'ungraded', 'mid-aa']);
  });

  it('drops a matured lot rather than reading its missing yield as zero', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, yieldMin: 0 }))).not.toContain('matured');
  });
});

describe('maturity', () => {
  it('keeps lots maturing on or before the cutoff', () => {
    const filter = { ...NO_FILTER, maturityBy: parseIsoDate('2026-11-14') };
    expect(refs(applyFilter(BOOK, filter))).toEqual(['ungraded', 'small-aaa', 'matured']);
  });
});

describe('sort', () => {
  it('by maturity, soonest first', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, sort: 'maturity' }))).toEqual([
      'matured',
      'small-aaa',
      'ungraded',
      'mid-aa',
      'large-a',
    ]);
  });

  it('by ticket size, largest first', () => {
    expect(refs(applyFilter(BOOK, { ...NO_FILTER, sort: 'size' }))).toEqual([
      'large-a',
      'mid-aa',
      'matured',
      'ungraded',
      'small-aaa',
    ]);
  });
});

describe('parsing a filter out of the URL', () => {
  it('reads every control', () => {
    const f = parseFilter({
      by: '2026-12-31',
      tmin: '31',
      tmax: '60',
      grade: 'AAA,AA',
      smin: '100000',
      smax: '500000',
      ymin: '8.5',
      sort: 'tenor',
    });
    expect(f.maturityBy).toBe('2026-12-31');
    expect([f.tenorMin, f.tenorMax]).toEqual([31, 60]);
    expect(f.grades).toEqual(['AAA', 'AA']);
    expect(f.sizeMin).toBe(1_000_000_000n);
    expect(f.sizeMax).toBe(5_000_000_000n);
    expect(f.yieldMin).toBe(8.5);
    expect(f.sort).toBe('tenor');
  });

  it('reads ticket size in display units, not base units', () => {
    // 100000 in the URL means 100,000 XUSD, which is 1,000,000,000 base units.
    expect(parseFilter({ smin: '100000' }).sizeMin).toBe(fromWholeUnits(100_000));
  });

  it('ignores junk rather than failing, so a stale link still browses', () => {
    const f = parseFilter({ by: 'yesterday', tmin: 'lots', grade: 'BBB', ymin: '', sort: 'cheapest' });
    expect(f).toEqual(NO_FILTER);
    expect(isFiltered(f)).toBe(false);
  });

  it('defaults to sorting by yield when nothing is given', () => {
    expect(parseFilter({}).sort).toBe('yield');
  });
});
