import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, parseIsoDate } from '../clock';
import { convert, DEFAULT_XSGD_PER_XUSD, RATE_SCALE } from '../fx';
import {
  add,
  allocateProRata,
  type BaseUnits,
  eq,
  formatUnits,
  fromBaseUnits,
  mulDivRound,
  parseUnits,
  sum,
} from '../money';
import { quote } from '../pricing';

const RUNS = 200;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function int(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function units(rand: () => number, min = 1, max = 50_000_000): BaseUnits {
  return fromBaseUnits(BigInt(int(rand, min, max)));
}

function times(n: number, seed: number, body: (rand: () => number, i: number) => void) {
  const rand = rng(seed);
  for (let i = 0; i < n; i += 1) body(rand, i);
}

describe('conservation properties', () => {
  it('pro-rata parts always sum to the obligation', () => {
    times(RUNS, 1, (rand) => {
      const total = units(rand, 1, 10_000_000);
      const n = int(rand, 1, 9);
      const weights = Array.from({ length: n }, () => units(rand, 1, 1_000_000));
      const parts = allocateProRata(total, weights);
      expect(sum(parts)).toBe(total);
      expect(parts).toHaveLength(n);
    });
  });

  it('pro-rata is deterministic for the same inputs', () => {
    times(80, 2, (rand) => {
      const total = units(rand, 10, 1_000_000);
      const weights = Array.from({ length: int(rand, 2, 6) }, () => units(rand, 1, 50_000));
      expect(allocateProRata(total, weights)).toEqual(allocateProRata(total, weights));
    });
  });

  it('format then parse returns the same non-negative amount', () => {
    times(RUNS, 3, (rand) => {
      const value = units(rand, 0, 9_999_999_999);
      const shown = formatUnits(value, 4).replace(/,/g, '');
      expect(parseUnits(shown)).toBe(value);
    });
  });
});

describe('pricing properties', () => {
  it('discount is face minus price', () => {
    times(RUNS, 4, (rand) => {
      const face = units(rand, 10_000, 5_000_000);
      const price = fromBaseUnits(BigInt(int(rand, 1, Number(face))));
      const q = quote(face, price, int(rand, 1, 180));
      expect(q.discount).toBe(face - price);
    });
  });

  it('live quotes have both annualised measures; due quotes have neither', () => {
    const face = fromBaseUnits(1_000_000n);
    const price = fromBaseUnits(980_000n);
    expect(quote(face, price, 1).lenderYieldPercent).not.toBeNull();
    expect(quote(face, price, 0).lenderYieldPercent).toBeNull();
    expect(quote(face, price, 0).annualisedDiscountCostPercent).toBeNull();
  });
});

describe('metamorphic relations', () => {
  it('scaling face and price by k scales the discount by k', () => {
    times(RUNS, 5, (rand) => {
      const face = units(rand, 10_000, 2_000_000);
      const price = fromBaseUnits(BigInt(int(rand, 1, Number(face))));
      const k = int(rand, 2, 9);
      const factor = BigInt(k);
      const a = quote(face, price, 90);
      const b = quote(
        fromBaseUnits(face * factor),
        fromBaseUnits(price * factor),
        90,
      );
      expect(b.discount).toBe(a.discount * factor);
      expect(b.pricePercent).toBeCloseTo(a.pricePercent, 10);
    });
  });

  it('doubling days remaining halves both annualised rates', () => {
    times(RUNS, 6, (rand) => {
      const face = units(rand, 100_000, 5_000_000);
      const price = fromBaseUnits(BigInt(int(rand, 1, Number(face) - 1)));
      const days = int(rand, 2, 90) * 2;
      const a = quote(face, price, days);
      const b = quote(face, price, days * 2);
      if (a.lenderYieldPercent === null || b.lenderYieldPercent === null) {
        throw new Error('live quotes must annualise');
      }
      expect(b.lenderYieldPercent).toBeCloseTo(a.lenderYieldPercent / 2, 10);
      expect(b.annualisedDiscountCostPercent).toBeCloseTo(
        (a.annualisedDiscountCostPercent as number) / 2,
        10,
      );
    });
  });

  it('1:1 conversion is identity and additive', () => {
    times(RUNS, 7, (rand) => {
      const a = units(rand);
      const b = units(rand);
      for (const asset of ['XUSD', 'USDC', 'USDT'] as const) {
        expect(convert(a, asset, DEFAULT_XSGD_PER_XUSD).sourceDebit).toBe(a);
        expect(convert(add(a, b), asset, DEFAULT_XSGD_PER_XUSD).sourceDebit).toBe(add(a, b));
      }
    });
  });

  it('XSGD debit is obligation × rate, rounded to a whole base unit', () => {
    times(RUNS, 8, (rand) => {
      const obligation = units(rand, 1, 5_000_000);
      const rate = BigInt(int(rand, 1_000_000, 2_000_000));
      const c = convert(obligation, 'XSGD', rate);
      expect(c.sourceDebit).toBe(mulDivRound(obligation, rate, RATE_SCALE));
      expect(c.obligationXusd).toBe(obligation);
    });
  });

  it('calendar days reverse and compose', () => {
    times(RUNS, 9, (rand) => {
      const start = parseIsoDate(
        `${int(rand, 2024, 2028)}-${String(int(rand, 1, 12)).padStart(2, '0')}-01`,
      );
      const n = int(rand, -40, 40);
      const end = addDays(start, n);
      expect(daysBetween(start, end)).toBe(n);
      expect(daysBetween(end, start)).toBe(n === 0 ? 0 : -n);
      expect(daysBetween(start, start)).toBe(0);
    });
  });
});

describe('equality that a mutant would break', () => {
  it('eq agrees with bigint equality on branded amounts', () => {
    const a = fromBaseUnits(12345n);
    expect(eq(a, fromBaseUnits(12345n))).toBe(true);
    expect(eq(a, fromBaseUnits(12346n))).toBe(false);
  });
});
