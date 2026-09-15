/**
 * Property-based and metamorphic tests over the financial core.
 *
 * Example tests pin the cases someone thought of. The defects that matter in a
 * money system live in the cases nobody thought of: the total that splits four
 * ways with a one-base-unit residue, the amount whose formatted form crosses a
 * thousands boundary, the rate that rounds one way at 1.31 and the other at
 * 1.3100001. So every case here states a law and lets fast-check hunt for a
 * value that breaks it, then shrinks that value to its minimum.
 *
 * The run count and the seed are both fixed. A property that only ever runs on
 * fresh randomness reports a different failure to every reader; with the seed
 * pinned, a counterexample written into a comment here is the counterexample
 * the next reader gets.
 *
 * The database section is metamorphic rather than exhaustive. It asks whether
 * two commands that should agree do agree, which is a question no single
 * example can answer, and it pays a round trip per generated value, so it runs
 * far fewer of them.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';

import * as m from '@/core/money';
import { convert, DEFAULT_XSGD_PER_XUSD, RATE_SCALE } from '@/core/fx';
import {
  addDays,
  advance,
  clockAt,
  daysBetween,
  daysRemaining,
  parseIsoDate,
  reset,
  tenorDays,
  today,
  type DemoClock,
  type IsoDate,
} from '@/core/clock';
import {
  isAbovePar,
  maturityState,
  percentOfFace,
  priceForTargetYield,
  quote,
} from '@/core/pricing';
import {
  applyFilter,
  GRADES,
  NO_FILTER,
  parseFilter,
  SORTS,
  type Filterable,
  type Grade,
  type MarketFilter,
  type Sort,
} from '@/core/market';
import {
  actors,
  freshDatabase,
  HEALTHY,
  ledgerHealth,
  post,
  type Database,
} from '../support/database';

/** Pinned so a shrunk counterexample quoted in a comment reproduces verbatim. */
const SEED = 20260915;
const RUNS = { numRuns: 500, seed: SEED } as const;

/**
 * 1e12 base units is 100,000,000.0000 display units: two orders of magnitude
 * above the programme limit in db/fixtures.sql, and small enough that every
 * `Number()` conversion inside pricing is exact, so a float artefact cannot be
 * mistaken for an arithmetic defect.
 */
const MONEY_MAX = 1_000_000_000_000n;

const baseUnits = (min: bigint, max: bigint) => fc.bigInt({ min, max }).map(m.fromBaseUnits);
const anyMoney = baseUnits(-MONEY_MAX, MONEY_MAX);
const nonNegativeMoney = baseUnits(0n, MONEY_MAX);
const positiveMoney = baseUnits(1n, MONEY_MAX);

const weights = fc
  .array(baseUnits(0n, MONEY_MAX), { minLength: 1, maxLength: 8 })
  .filter((ws) => ws.reduce<bigint>((acc, w) => acc + w, 0n) > 0n);

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

// ----------------------------------------------------------------------------
// money: conservation and rounding
// ----------------------------------------------------------------------------

describe('money conservation', () => {
  // INVARIANT: a split invents nothing and loses nothing. Settlement pays every
  // holder from one debit, so a residue of one base unit is a book that does
  // not balance rather than a rounding detail.
  it('splits a total across weights with no rounding leak', () => {
    fc.assert(
      fc.property(nonNegativeMoney, weights, (total, ws) => {
        expect(m.sum(m.allocateProRata(total, ws))).toBe(total);
      }),
      RUNS,
    );
    expect(m.allocateProRata(m.fromBaseUnits(100n), [1n, 1n, 1n].map(m.fromBaseUnits)))
      .toEqual([34n, 33n, 33n]);
  });

  // Conservation alone would also hold if the residue were dumped on one part.
  // This pins the method: largest remainder, so no holder is off by more than
  // a single base unit from their exact share.
  it('gives every part its floor or its floor plus one base unit', () => {
    fc.assert(
      fc.property(nonNegativeMoney, weights, (total, ws) => {
        const weightTotal = ws.reduce<bigint>((acc, w) => acc + w, 0n);
        const parts = m.allocateProRata(total, ws);
        parts.forEach((part, index) => {
          const floor = (total * ws[index]) / weightTotal;
          expect(part === floor || part === floor + 1n).toBe(true);
        });
      }),
      RUNS,
    );
    expect(m.allocateProRata(m.fromBaseUnits(10n), [7n, 3n].map(m.fromBaseUnits)))
      .toEqual([7n, 3n]);
  });

  it('gives a sole weight the whole total', () => {
    fc.assert(
      fc.property(nonNegativeMoney, positiveMoney, (total, weight) => {
        expect(m.allocateProRata(total, [weight])).toEqual([total]);
      }),
      RUNS,
    );
  });

  /**
   * The guard used to be on the weights summing positive, which a negative
   * weight passes whenever another outweighs it. bigint division truncates
   * toward zero, a ceiling for a negative product, so the parts over-allocated
   * and the residue loop exited on its `residue <= 0n` break without
   * correcting it. total 1n over [-4n, 10n, -1n] returned [0n, 2n, 0n].
   *
   * The guard is per weight now, so the postcondition holds for everything the
   * function admits and the rest is refused by name.
   */
  it('refuses to split across a negative weight rather than over-allocating', () => {
    fc.assert(
      fc.property(
        baseUnits(1n, 1_000n),
        fc.array(baseUnits(-10n, 10n), { minLength: 2, maxLength: 4 })
          .filter((ws) => ws.some((w) => w < 0n))
          .filter((ws) => ws.reduce<bigint>((acc, w) => acc + w, 0n) > 0n),
        (total, ws) => {
          expect(() => m.allocateProRata(total, ws)).toThrow(
            'allocateProRata cannot split across a negative weight',
          );
        },
      ),
      RUNS,
    );
  });
});

describe('money rounding', () => {
  const nonZeroDivisor = fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((d) => d !== 0n);

  // INVARIANT: the rounded quotient is never more than half a denominator away
  // from the exact one. This is what "nearest base unit" has to mean.
  it('never rounds further than half a denominator', () => {
    fc.assert(
      fc.property(anyMoney, fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), nonZeroDivisor,
        (value, numerator, denominator) => {
          const rounded = m.mulDivRound(value, numerator, denominator);
          expect(abs(rounded * denominator - value * numerator) * 2n <= abs(denominator)).toBe(true);
        }),
      RUNS,
    );
    expect(m.mulDivRound(m.fromBaseUnits(5n), 1n, 2n)).toBe(3n);
  });

  // Half away from zero and half up agree on positives and disagree on
  // negatives, so the sign symmetry is the assertion that separates them.
  it('rounds away from zero symmetrically in both arguments', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), nonZeroDivisor, (p, q) => {
        expect(m.roundDiv(-p, q)).toBe(-m.roundDiv(p, q));
        expect(m.roundDiv(p, -q)).toBe(-m.roundDiv(p, q));
      }),
      RUNS,
    );
    expect(m.roundDiv(-5n, 2n)).toBe(-3n);
    expect(m.roundDiv(5n, 2n)).toBe(3n);
  });

  it('leaves a value untouched when numerator and denominator agree', () => {
    fc.assert(
      fc.property(anyMoney, nonZeroDivisor, (value, d) => {
        expect(m.mulDivRound(value, d, d)).toBe(value);
      }),
      RUNS,
    );
  });
});

describe('money group laws', () => {
  it('adds commutatively and subtracts back to where it started', () => {
    fc.assert(
      fc.property(anyMoney, anyMoney, (a, b) => {
        expect(m.add(a, b)).toBe(m.add(b, a));
        expect(m.sub(m.add(a, b), b)).toBe(a);
        expect(m.add(a, m.ZERO)).toBe(a);
      }),
      RUNS,
    );
    expect(m.sum([])).toBe(0n);
    expect(m.sum([1n, 2n, 3n].map(m.fromBaseUnits))).toBe(6n);
  });

  // INVARIANT: exactly one of the three comparisons holds, and min and max
  // partition a pair rather than reorder it. A comparator that got either
  // wrong would let a balance check pass on the wrong side.
  it('keeps the comparators coherent', () => {
    fc.assert(
      fc.property(anyMoney, anyMoney, (a, b) => {
        expect([m.lt(a, b), m.eq(a, b), m.gt(a, b)].filter(Boolean)).toHaveLength(1);
        expect(m.lte(a, b)).toBe(m.lt(a, b) || m.eq(a, b));
        expect(m.gte(a, b)).toBe(m.gt(a, b) || m.eq(a, b));
        expect(m.add(m.min(a, b), m.max(a, b))).toBe(m.add(a, b));
      }),
      RUNS,
    );
  });

  it('puts every amount in exactly one of negative, zero and positive', () => {
    fc.assert(
      fc.property(anyMoney, (a) => {
        expect([m.isNegative(a), m.isZero(a), m.isPositive(a)].filter(Boolean)).toHaveLength(1);
      }),
      RUNS,
    );
  });
});

// ----------------------------------------------------------------------------
// money: parsing round-trips
// ----------------------------------------------------------------------------

describe('money parsing round-trips', () => {
  it('agrees with the decimal parser on whole units', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (units) => {
        expect(m.fromWholeUnits(units)).toBe(m.parseUnits(String(units)));
      }),
      RUNS,
    );
    expect(m.fromWholeUnits(250_000)).toBe(2_500_000_000n);
  });

  it('survives the JSON boundary unchanged', () => {
    fc.assert(
      fc.property(anyMoney, (value) => {
        expect(m.fromBaseUnits(m.toJson(value))).toBe(value);
      }),
      RUNS,
    );
    expect(m.toJson(m.fromBaseUnits(-2_500_000_000n))).toBe('-2500000000');
  });

  /**
   * FAILS: `formatUnits` groups the whole part with `toLocaleString('en-US')`
   * and `parseUnits` matches `^(-?)(\d+)(?:\.(\d*))?$`, which has no comma in
   * it. Every amount from 1,000.0000 display units upward formats to a string
   * its own parser rejects.
   * Shrunk counterexample: 10000000n, formatted "1,000.0000", parse throws
   * RangeError: not a decimal amount: "1,000.0000".
   * Written up in tests/techniques/findings/properties.md.
   */
  it('round-trips through its own display format', () => {
    fc.assert(
      fc.property(anyMoney, (value) => {
        expect(m.parseUnits(m.formatUnits(value, 4))).toBe(value);
      }),
      RUNS,
    );
    expect(m.formatUnits(m.fromBaseUnits(-2_500_000_000n), 4)).toBe('-250,000.0000');
    expect(m.parseUnits('-250,000.0000')).toBe(-2_500_000_000n);
  });

  // Only the shape formatUnits emits is read as grouped. Anything else keeps
  // the comma and is refused, so 1,0000 is not ten thousand.
  it('refuses a comma that is not a thousands separator', () => {
    for (const bad of ['1,0000.00', '1,00', '1,,000', ',000', '1000,000']) {
      expect(() => m.parseUnits(bad), bad).toThrow();
    }
  });
});

// ----------------------------------------------------------------------------
// fx: metamorphic relations between an obligation and its funding debit
// ----------------------------------------------------------------------------

/** 0.5 to 5.0 XSGD per XUSD, a band that brackets the seeded 1.31 generously. */
const realisticRate = fc.bigInt({ min: RATE_SCALE / 2n, max: 5n * RATE_SCALE });
const anyPositiveRate = fc.bigInt({ min: 1n, max: 100n * RATE_SCALE });

describe('fx conversion', () => {
  // The asset check runs before the rate guard, so a rate that would be
  // rejected for XSGD is simply never consulted for the 1:1 assets.
  it('passes the obligation through unchanged for every asset but XSGD', () => {
    fc.assert(
      fc.property(
        anyMoney,
        fc.constantFrom('XUSD' as const, 'USDC' as const, 'USDT' as const),
        fc.bigInt({ min: -10n * RATE_SCALE, max: 10n * RATE_SCALE }),
        (obligation, asset, rate) => {
          const conversion = convert(obligation, asset, rate);
          expect(conversion.sourceDebit).toBe(obligation);
          expect(conversion.rate).toBeNull();
          expect(conversion.rounded).toBe(false);
        },
      ),
      RUNS,
    );
    expect(convert(m.fromBaseUnits(2_500_000_000n), 'USDC', 0n).sourceDebit).toBe(2_500_000_000n);
  });

  it('charges the obligation itself at a rate of exactly one', () => {
    fc.assert(
      fc.property(anyMoney, (obligation) => {
        expect(convert(obligation, 'XSGD', RATE_SCALE).sourceDebit).toBe(obligation);
      }),
      RUNS,
    );
    expect(convert(m.fromBaseUnits(10_000n), 'XSGD', DEFAULT_XSGD_PER_XUSD).sourceDebit).toBe(13_100n);
  });

  // INVARIANT: converting back recovers the obligation to within one base
  // unit. The bound is what lets the confirmation screen promise the payer
  // that the debit it quotes is the obligation and not an approximation of it.
  it('recovers the obligation to within one base unit at a market rate', () => {
    fc.assert(
      fc.property(positiveMoney, realisticRate, (obligation, rate) => {
        const back = m.mulDivRound(convert(obligation, 'XSGD', rate).sourceDebit, RATE_SCALE, rate);
        expect(abs(back - obligation) <= 1n).toBe(true);
      }),
      RUNS,
    );
  });

  // The one-base-unit bound above is not free: it depends on the rate being
  // near one. The general law is that the round-trip error scales with
  // RATE_SCALE / rate, which at a rate of 0.000001 is half a million base
  // units. Stated here so the narrower property above cannot be mistaken for
  // an unconditional guarantee.
  it('bounds the round-trip error by half a scale factor at any rate', () => {
    fc.assert(
      fc.property(positiveMoney, anyPositiveRate, (obligation, rate) => {
        const back = m.mulDivRound(convert(obligation, 'XSGD', rate).sourceDebit, RATE_SCALE, rate);
        expect(2n * abs(back - obligation) * rate <= RATE_SCALE + rate).toBe(true);
      }),
      RUNS,
    );
    const exaggerated = m.mulDivRound(
      convert(m.fromBaseUnits(3n), 'XSGD', 1n).sourceDebit, RATE_SCALE, 1n);
    expect(exaggerated).toBe(0n);
  });

  // INVARIANT: the flag never claims an exactness the arithmetic does not
  // have. A false `rounded` is what would let a receipt say "no rounding
  // applied" over a debit that was in fact rounded.
  it('only reports an unrounded debit when the debit is exact', () => {
    fc.assert(
      fc.property(anyMoney, anyPositiveRate, (obligation, rate) => {
        const conversion = convert(obligation, 'XSGD', rate);
        if (!conversion.rounded) {
          expect(conversion.sourceDebit * RATE_SCALE).toBe(obligation * rate);
        }
      }),
      RUNS,
    );
    expect(convert(m.fromBaseUnits(1n), 'XSGD', 1_310_000n).rounded).toBe(true);
    expect(convert(m.fromBaseUnits(10n), 'XSGD', 1_300_000n).rounded).toBe(false);
  });

  it('never charges less for a higher rate', () => {
    fc.assert(
      fc.property(nonNegativeMoney, anyPositiveRate, anyPositiveRate, (obligation, r1, r2) => {
        const [low, high] = r1 <= r2 ? [r1, r2] : [r2, r1];
        expect(convert(obligation, 'XSGD', low).sourceDebit)
          .toBeLessThanOrEqual(convert(obligation, 'XSGD', high).sourceDebit);
      }),
      RUNS,
    );
  });

  // Paying an obligation in two parts costs at most one base unit more or less
  // than paying it whole, which is the bound a split settlement has to respect.
  it('stays within one base unit of linearity', () => {
    fc.assert(
      fc.property(nonNegativeMoney, nonNegativeMoney, realisticRate, (a, b, rate) => {
        const parts = convert(a, 'XSGD', rate).sourceDebit + convert(b, 'XSGD', rate).sourceDebit;
        const whole = convert(m.add(a, b), 'XSGD', rate).sourceDebit;
        expect(abs(parts - whole) <= 1n).toBe(true);
      }),
      RUNS,
    );
  });
});

// ----------------------------------------------------------------------------
// pricing: identities that every screen showing a price depends on
// ----------------------------------------------------------------------------

/** Face and price drawn together so prices land both below and above par. */
const facePrice = fc.bigInt({ min: 1n, max: MONEY_MAX }).chain((face) =>
  fc.tuple(fc.constant(m.fromBaseUnits(face)), baseUnits(0n, face * 2n)),
);
const anyDays = fc.integer({ min: -400, max: 400 });
const liveDays = fc.integer({ min: 1, max: 365 });

describe('pricing identities', () => {
  // INVARIANT: price plus discount is face, above par included, where the
  // discount is negative. A screen that showed the three independently could
  // disagree with itself; they come from one call for exactly this reason.
  it('decomposes face into price and discount', () => {
    fc.assert(
      fc.property(facePrice, anyDays, ([face, price], days) => {
        const q = quote(face, price, days);
        expect(m.add(q.price, q.discount)).toBe(face);
        expect(q.price).toBe(price);
      }),
      RUNS,
    );
    const above = quote(m.fromBaseUnits(1_000_000n), m.fromBaseUnits(1_010_000n), 30);
    expect(above.discount).toBe(-10_000n);
  });

  it('reports the price percentage the shared helper computes', () => {
    fc.assert(
      fc.property(facePrice, anyDays, ([face, price], days) => {
        expect(quote(face, price, days).pricePercent).toBe(percentOfFace(price, face));
      }),
      RUNS,
    );
    expect(quote(m.fromBaseUnits(1_000_000n), m.fromBaseUnits(978_500n), 30).pricePercent)
      .toBeCloseTo(97.85, 10);
  });

  it('never prices higher for a higher target yield', () => {
    fc.assert(
      fc.property(positiveMoney, fc.integer({ min: 0, max: 6_000 }), fc.integer({ min: 0, max: 6_000 }),
        liveDays, (face, y1, y2, days) => {
          const [low, high] = y1 <= y2 ? [y1, y2] : [y2, y1];
          expect(priceForTargetYield(face, low / 100, days))
            .toBeGreaterThanOrEqual(priceForTargetYield(face, high / 100, days));
        }),
      RUNS,
    );
  });

  it('never prices higher for a longer tenor', () => {
    fc.assert(
      fc.property(positiveMoney, fc.integer({ min: 1, max: 6_000 }), liveDays, liveDays,
        (face, yieldBps, d1, d2) => {
          const [shortTenor, longTenor] = d1 <= d2 ? [d1, d2] : [d2, d1];
          expect(priceForTargetYield(face, yieldBps / 100, shortTenor))
            .toBeGreaterThanOrEqual(priceForTargetYield(face, yieldBps / 100, longTenor));
        }),
      RUNS,
    );
  });

  it('never yields more for a higher price', () => {
    fc.assert(
      fc.property(positiveMoney, positiveMoney, positiveMoney, liveDays, (face, p1, p2, days) => {
        const [cheap, dear] = m.lte(p1, p2) ? [p1, p2] : [p2, p1];
        expect(quote(face, cheap, days).lenderYieldPercent)
          .toBeGreaterThanOrEqual(quote(face, dear, days).lenderYieldPercent as number);
      }),
      RUNS,
    );
  });

  // Percent of face is a ratio, so listing half a payable at half the price is
  // the same quote as listing all of it. Screens show partial lots next to
  // whole ones and a scale-dependent percentage would rank them wrongly.
  it('quotes the same percentage whatever the lot is scaled by', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000n }),
        anyDays,
        (face, price, k, days) => {
          const one = quote(m.fromBaseUnits(face), m.fromBaseUnits(price), days).pricePercent;
          const scaled = quote(m.fromBaseUnits(face * k), m.fromBaseUnits(price * k), days).pricePercent;
          expect(scaled).toBeCloseTo(one, 8);
        },
      ),
      RUNS,
    );
  });

  // The clock module decides whether a payable is live and the pricing module
  // decides whether a forward yield exists. They must decide the same thing,
  // or a row shows "Due" beside an annualised rate.
  it('drops both annualised measures exactly when the payable is no longer live', () => {
    fc.assert(
      fc.property(facePrice, anyDays, ([face, price], days) => {
        const q = quote(face, price, days);
        const live = days > 0;
        expect(q.annualisedDiscountCostPercent === null).toBe(!live);
        expect(maturityState(days) === 'live').toBe(live);
        expect(q.maturity).toBe(days > 0 ? 'live' : days === 0 ? 'due' : 'past-due');
      }),
      RUNS,
    );
    expect(quote(m.fromBaseUnits(1_000_000n), m.fromBaseUnits(900_000n), 0)
      .annualisedDiscountCostPercent).toBeNull();
  });

  it('agrees with itself about a price above par', () => {
    fc.assert(
      fc.property(facePrice, anyDays, ([face, price], days) => {
        const abovePar = isAbovePar(face, price);
        expect(m.isNegative(quote(face, price, days).discount)).toBe(abovePar);
        expect(percentOfFace(price, face) > 100).toBe(abovePar);
      }),
      RUNS,
    );
    expect(isAbovePar(m.fromBaseUnits(1_000_000n), m.fromBaseUnits(1_000_001n))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// clock: calendar arithmetic the whole demo is derived from
// ----------------------------------------------------------------------------

const T0 = parseIsoDate('2026-01-01');
const anyDate = fc.integer({ min: -20_000, max: 20_000 }).map((d) => addDays(T0, d));
const anyOffset = fc.integer({ min: -3_650, max: 3_650 });
const forwardOffset = fc.integer({ min: 0, max: 3_650 });

describe('clock arithmetic', () => {
  it('measures back exactly the days it added', () => {
    fc.assert(
      fc.property(anyDate, anyOffset, (date, days) => {
        expect(daysBetween(date, addDays(date, days))).toBe(days);
      }),
      RUNS,
    );
    expect(addDays(parseIsoDate('2026-02-28'), 1)).toBe('2026-03-01');
  });

  it('adds days additively', () => {
    fc.assert(
      fc.property(anyDate, anyOffset, anyOffset, (date, a, b) => {
        expect(addDays(addDays(date, a), b)).toBe(addDays(date, a + b));
      }),
      RUNS,
    );
  });

  it('measures the same distance backwards as forwards', () => {
    fc.assert(
      fc.property(anyDate, anyDate, (from, to) => {
        expect(daysBetween(from, to)).toBe(-daysBetween(to, from));
      }),
      RUNS,
    );
    expect(daysBetween(parseIsoDate('2026-01-01'), parseIsoDate('2026-04-01'))).toBe(90);
  });

  it('adds distances along a chain of dates', () => {
    fc.assert(
      fc.property(anyDate, anyDate, anyDate, (a, b, c) => {
        expect(daysBetween(a, b) + daysBetween(b, c)).toBe(daysBetween(a, c));
      }),
      RUNS,
    );
  });

  // INVARIANT: fast-forwarding n days takes exactly n days off every countdown
  // on screen. The demo bar is pressed mid-sentence and the ladder has to move
  // by the amount the button says.
  it('takes the advance straight off days remaining', () => {
    fc.assert(
      fc.property(anyOffset, forwardOffset, anyDate, (start, step, maturity) => {
        const clock = clockAt(T0, start);
        expect(daysRemaining(advance(clock, step), maturity))
          .toBe(daysRemaining(clock, maturity) - step);
      }),
      RUNS,
    );
  });

  // Original tenor is a property of the obligation, not of the world. PRD
  // section 6 shows it beside days remaining precisely so the two differ.
  it('leaves original tenor alone however far the world advances', () => {
    fc.assert(
      fc.property(anyDate, anyOffset, fc.array(forwardOffset, { maxLength: 6 }),
        (issue, span, steps) => {
          const maturity = addDays(issue, span);
          const advanced = steps.reduce<DemoClock>((c, step) => advance(c, step), clockAt(issue, 0));
          const travelled = steps.reduce<number>((acc, step) => acc + step, 0);
          expect(daysBetween(issue, today(advanced))).toBe(travelled);
          expect(tenorDays(issue, maturity)).toBe(span);
          expect(daysRemaining(advanced, maturity)).toBe(span - travelled);
        }),
      RUNS,
    );
  });

  it('resets to the seed position from anywhere', () => {
    fc.assert(
      fc.property(anyOffset, forwardOffset, (start, step) => {
        const clock = clockAt(T0, start);
        expect(reset(advance(clock, step))).toEqual(reset(clock));
        expect(reset(advance(clock, step)).offsetDays).toBe(0);
      }),
      RUNS,
    );
    expect(today(reset(clockAt(T0, 47)))).toBe('2026-01-01');
  });
});

// ----------------------------------------------------------------------------
// market: a browse control that must never be the reason a page fails
// ----------------------------------------------------------------------------

const lot = fc
  .record({
    grade: fc.oneof(fc.constantFrom<Grade>(...GRADES), fc.constant('BBB'), fc.constant(null)),
    listedFaceBase: baseUnits(0n, 10_000_000_000n),
    maturityOffset: fc.integer({ min: -60, max: 400 }),
    daysRemaining: fc.integer({ min: -60, max: 400 }),
    lenderYieldPercent: fc.option(fc.integer({ min: -500, max: 5_000 }).map((n) => n / 100), {
      nil: null,
    }),
    pricePercent: fc.integer({ min: 5_000, max: 12_000 }).map((n) => n / 100),
  })
  .map((r) => ({
    grade: r.grade,
    listedFaceBase: r.listedFaceBase,
    maturityDate: addDays(T0, r.maturityOffset),
    quote: {
      daysRemaining: r.daysRemaining,
      lenderYieldPercent: r.lenderYieldPercent,
      pricePercent: r.pricePercent,
    },
  }));

interface Lot extends Filterable {
  id: number;
}

/** Identified after generation, so a filtered result can be compared as a set. */
const book = fc
  .array(lot, { minLength: 1, maxLength: 20 })
  .map((lots): Lot[] => lots.map((l, id) => ({ ...l, id })));

const ids = (lots: readonly Lot[]): number[] => lots.map((l) => l.id).sort((a, b) => a - b);

const queryValue = fc.oneof(
  fc.string(),
  fc.constantFrom('', ' ', 'NaN', 'Infinity', '-Infinity', '0x10', '2026-13-45', 'AAA,ZZZ', ','),
  fc.integer({ min: -400, max: 400 }).map(String),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.constant(undefined),
);

const QUERY_KEYS = ['by', 'tmin', 'tmax', 'grade', 'smin', 'smax', 'ymin', 'sort', 'junk'] as const;

describe('market filter parsing', () => {
  // The module's own contract: "Anything unparseable is dropped rather than
  // rejected", because a stale link should show the marketplace rather than an
  // error page. Fuzzed rather than enumerated, since the point is the inputs
  // nobody listed.
  it('turns any query into a usable filter instead of throwing', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...QUERY_KEYS), queryValue), (params) => {
        const filter = parseFilter(params);
        expect(SORTS).toContain(filter.sort);
        expect(Array.isArray(filter.grades)).toBe(true);
        filter.grades.forEach((g) => expect(GRADES).toContain(g));
        expect(filter.sizeMin === null || typeof filter.sizeMin === 'bigint').toBe(true);
        expect(filter.sizeMax === null || typeof filter.sizeMax === 'bigint').toBe(true);
        expect(filter.tenorMin === null || Number.isInteger(filter.tenorMin)).toBe(true);
      }),
      RUNS,
    );
    expect(parseFilter({ sort: 'nonsense', grade: 'AAA,ZZZ', smin: 'x' }))
      .toEqual({ ...NO_FILTER, grades: ['AAA'] });
    // A calendar-impossible date satisfies the shape regex and is cast straight
    // to IsoDate, where clock.parseIsoDate would have rejected it. Pinned
    // because the fuzz above reaches it and the consequence is a string
    // comparison against maturityDate rather than a throw.
    expect(parseFilter({ by: '2026-13-45' }).maturityBy).toBe('2026-13-45');
    expect(parseFilter({
      by: '2026-06-30', tmin: '30.7', tmax: '90', grade: 'AAA,A',
      smin: '250000', smax: '1000000', ymin: '7.5', sort: 'tenor',
    })).toEqual({
      maturityBy: '2026-06-30',
      tenorMin: 30,
      tenorMax: 90,
      grades: ['AAA', 'A'],
      sizeMin: 2_500_000_000n,
      sizeMax: 10_000_000_000n,
      yieldMin: 7.5,
      sort: 'tenor',
    });
  });

  /**
   * FAILS: `units()` in parseFilter checks `Number.isFinite` on the parsed
   * value and then multiplies by BASE_UNITS_PER_UNIT before converting to
   * bigint. A finite value above roughly 1.798e304 overflows to Infinity in
   * that multiplication and `BigInt(Infinity)` throws, so a size bound is the
   * one query parameter that can take the marketplace down.
   * Shrunk counterexample: exponent 305, that is `?smin=1e305`, throwing
   * RangeError: The number Infinity cannot be converted to a BigInt because it
   * is not an integer. Exponent 304 parses fine.
   * Written up in tests/techniques/findings/properties.md.
   */
  it('survives a size bound written in exponent notation', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), (exponent) => {
        const bound = parseFilter({ smin: `1e${exponent}` }).sizeMin;
        // The documented contract is that an unparseable value is dropped, not
        // that every value parses. A bound that overflows the scaling to base
        // units is dropped like any other, so the marketplace still renders.
        expect(bound === null || typeof bound === 'bigint').toBe(true);
      }),
      RUNS,
    );
    expect(parseFilter({ smin: '1e304' }).sizeMin).not.toBe(null);
    expect(parseFilter({ smin: '1e305' }).sizeMin).toBe(null);
  });
});

describe('market filtering', () => {
  type Criterion = { key: keyof MarketFilter; filter: MarketFilter };
  const criterion = (key: keyof MarketFilter, part: Partial<MarketFilter>): Criterion => ({
    key,
    filter: { ...NO_FILTER, ...part },
  });

  const singleCriterion = fc.oneof(
    fc.integer({ min: -60, max: 400 }).map((d) => criterion('maturityBy', { maturityBy: addDays(T0, d) })),
    fc.integer({ min: -60, max: 400 }).map((t) => criterion('tenorMin', { tenorMin: t })),
    fc.integer({ min: -60, max: 400 }).map((t) => criterion('tenorMax', { tenorMax: t })),
    fc.uniqueArray(fc.constantFrom<Grade>(...GRADES), { minLength: 1 })
      .map((g) => criterion('grades', { grades: g })),
    baseUnits(0n, 10_000_000_000n).map((s) => criterion('sizeMin', { sizeMin: s })),
    baseUnits(0n, 10_000_000_000n).map((s) => criterion('sizeMax', { sizeMax: s })),
    fc.integer({ min: -500, max: 5_000 }).map((y) => criterion('yieldMin', { yieldMin: y / 100 })),
  );

  // INVARIANT: criteria compose as conjunction. A lender who adds a second
  // control expects fewer lots that all still satisfy the first.
  it('combines two criteria into the intersection of each applied alone', () => {
    fc.assert(
      fc.property(book, singleCriterion, singleCriterion, (lots, a, b) => {
        // Two settings of the same criterion are one criterion, not two, so
        // only distinct pairs say anything about composition.
        fc.pre(a.key !== b.key);
        const both: MarketFilter = {
          maturityBy: a.filter.maturityBy ?? b.filter.maturityBy,
          tenorMin: a.filter.tenorMin ?? b.filter.tenorMin,
          tenorMax: a.filter.tenorMax ?? b.filter.tenorMax,
          grades: a.filter.grades.length > 0 ? a.filter.grades : b.filter.grades,
          sizeMin: a.filter.sizeMin ?? b.filter.sizeMin,
          sizeMax: a.filter.sizeMax ?? b.filter.sizeMax,
          yieldMin: a.filter.yieldMin ?? b.filter.yieldMin,
          sort: 'yield',
        };
        const left = new Set(ids(applyFilter(lots, a.filter)));
        const right = new Set(ids(applyFilter(lots, b.filter)));
        expect(ids(applyFilter(lots, both)))
          .toEqual(ids(lots).filter((id) => left.has(id) && right.has(id)));
      }),
      RUNS,
    );
  });

  it('keeps a subset when any bound is tightened', () => {
    fc.assert(
      fc.property(
        book,
        fc.record({
          tenorMin: fc.integer({ min: -60, max: 400 }),
          tenorMax: fc.integer({ min: -60, max: 400 }),
          sizeMin: baseUnits(0n, 10_000_000_000n),
          sizeMax: baseUnits(0n, 10_000_000_000n),
          yieldMin: fc.integer({ min: -500, max: 5_000 }).map((y) => y / 100),
          maturityOffset: fc.integer({ min: -60, max: 400 }),
        }),
        fc.integer({ min: 1, max: 50 }),
        (lots, base, step) => {
          const loose: MarketFilter = {
            ...NO_FILTER,
            tenorMin: base.tenorMin,
            tenorMax: base.tenorMax,
            sizeMin: base.sizeMin,
            sizeMax: base.sizeMax,
            yieldMin: base.yieldMin,
            maturityBy: addDays(T0, base.maturityOffset),
          };
          const tight: MarketFilter = {
            ...loose,
            tenorMin: base.tenorMin + step,
            tenorMax: base.tenorMax - step,
            sizeMin: m.fromBaseUnits(base.sizeMin + BigInt(step)),
            sizeMax: m.fromBaseUnits(base.sizeMax - BigInt(step)),
            yieldMin: base.yieldMin + step,
            maturityBy: addDays(T0, base.maturityOffset - step),
          };
          const kept = new Set(ids(applyFilter(lots, loose)));
          ids(applyFilter(lots, tight)).forEach((id) => expect(kept.has(id)).toBe(true));
        },
      ),
      RUNS,
    );
  });

  // The module's own suite orders only `maturity` and `size` by example, so
  // `tenor` and `price` rest entirely on this property.
  it('orders every sort the way its label promises', () => {
    const ordered: Record<Sort, (a: Lot, b: Lot) => boolean> = {
      yield: (a, b) => (a.quote.lenderYieldPercent ?? -1) >= (b.quote.lenderYieldPercent ?? -1),
      maturity: (a, b) => a.maturityDate <= b.maturityDate,
      tenor: (a, b) => a.quote.daysRemaining <= b.quote.daysRemaining,
      size: (a, b) => a.listedFaceBase >= b.listedFaceBase,
      price: (a, b) => a.quote.pricePercent <= b.quote.pricePercent,
    };
    fc.assert(
      fc.property(book, fc.constantFrom<Sort>(...SORTS), (lots, sort) => {
        const sorted = applyFilter(lots, { ...NO_FILTER, sort });
        expect(ids(sorted)).toEqual(ids(lots));
        for (let i = 1; i < sorted.length; i += 1) {
          expect(ordered[sort](sorted[i - 1], sorted[i])).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

// ----------------------------------------------------------------------------
// ledger: metamorphic relations that need the real database
// ----------------------------------------------------------------------------

const DB_RUNS = { numRuns: 25, seed: SEED } as const;

/** 90 days, so nothing generated here reaches maturity mid-property. */
const TERMS_DAYS = 90;

interface World {
  pool: Pool;
  preparer: string;
  checker: string;
  admin: string;
  supplierId: string;
  supplierWallet: string;
  otherSupplierWallet: string;
  lenderWallet: string;
}

let handle: Database;
let world: World;
let nextRef = 0;

async function postOk(
  pool: Pool,
  intent: Record<string, unknown>,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  const result = await post(pool, intent, { actorUserId });
  if (!result.ok) {
    throw new Error(`${String(intent.kind)} refused with ${result.code}: ${result.message}`);
  }
  return result.receipt;
}

async function freeBalance(pool: Pool, wallet: string, cash: string): Promise<bigint> {
  const { rows } = await pool.query<{ balance: bigint }>(
    `SELECT COALESCE(SUM(b.balance), 0)::bigint AS balance
       FROM ledger.account_balance b
       JOIN ledger.account a ON a.id = b.account_id
       JOIN ledger.asset s ON s.id = b.asset_id
      WHERE a.wallet_address = $1 AND a.purpose = 'wallet_free' AND s.cash_code::text = $2`,
    [wallet, cash],
  );
  return rows[0]?.balance ?? 0n;
}

async function entryCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: bigint }>('SELECT count(*) AS n FROM ledger.journal_entry');
  return Number(rows[0]!.n);
}

/** A payable carried all the way to a quantity the supplier can trade. */
async function issueAcceptedPayable(faceBase: bigint): Promise<string> {
  const { pool, preparer, checker, admin, supplierId, supplierWallet } = world;
  nextRef += 1;
  const tag = String(nextRef).padStart(4, '0');
  const ref = `TP-PROP-${tag}`;

  // No payableId is supplied: ledger.post() writes the journal entry before the
  // branch creates the payable, and journal_entry.payable_id is a foreign key,
  // so naming an id that does not exist yet fails on the idempotency insert.
  await postOk(pool, {
    kind: 'create_payable',
    ref,
    supplierId,
    invoiceRef: `INV-PROP-${tag}`,
    faceBase: faceBase.toString(),
    termsDays: TERMS_DAYS,
  }, preparer);
  const created = await pool.query<{ id: string }>(
    'SELECT id::text FROM app.payable WHERE ref = $1', [ref],
  );
  const payableId = created.rows[0]!.id;

  await postOk(pool, { kind: 'submit', payableId }, preparer);
  await postOk(pool, { kind: 'approve', payableId }, checker);
  await postOk(pool, {
    kind: 'grade',
    payableId,
    grade: 'AA',
    gradeRationale: 'Anchor obligor. Sample value, not an external rating.',
  }, admin);
  await postOk(pool, { kind: 'certify', payableId }, admin);
  await postOk(pool, {
    kind: 'issue_payable',
    payableId,
    toWallet: supplierWallet,
    tokenId: 900_000 + nextRef,
  }, admin);
  await postOk(pool, { kind: 'accept_receipt', payableId }, preparer);
  return payableId;
}

describe('ledger metamorphic relations', () => {
  beforeAll(async () => {
    handle = await freshDatabase('properties', 'fixtures');
    const pool = handle.pool;
    const byRole = await actors(pool);
    const { rows } = await pool.query<{ address: string; id: string; entity_type: string; name: string }>(
      `SELECT w.address, e.id::text AS id, e.entity_type::text AS entity_type, e.name
         FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id
        ORDER BY e.entity_type::text, e.name`,
    );
    const suppliers = rows.filter((r) => r.entity_type === 'supplier');
    const lenders = rows.filter((r) => r.entity_type === 'lender');
    world = {
      pool,
      preparer: byRole.adata_preparer!,
      checker: byRole.adata_checker!,
      admin: byRole.straitsx_admin!,
      supplierId: suppliers[0]!.id,
      supplierWallet: suppliers[0]!.address,
      otherSupplierWallet: suppliers[1]!.address,
      lenderWallet: lenders[0]!.address,
    };
  });

  afterAll(async () => {
    await handle?.close();
  });

  /**
   * The core metamorphic relation of the system. One obligation, one price,
   * three funding assets, and the seller has to end up with the identical XUSD
   * every time while the buyer pays a different amount of a different asset.
   *
   * The XSGD debit is checked against `fx.convert` rather than against a
   * recomputed formula, so this is also a differential test: the plpgsql in
   * ledger.payer_legs and the TypeScript the confirmation screen quotes from
   * must agree to the base unit.
   */
  it('credits the seller the same XUSD whichever asset funds the trade', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 1n, max: 2_000_000n }),
        async (lotQuantity, price) => {
          const { pool, preparer, supplierWallet, lenderWallet } = world;
          const payableId = await issueAcceptedPayable(lotQuantity * 3n);
          const credits: bigint[] = [];
          const debits: Record<string, bigint> = {};

          for (const fundingCode of ['USDC', 'USDT', 'XSGD'] as const) {
            const listingId = randomUUID();
            await postOk(pool, {
              kind: 'publish_listing',
              listingId,
              payableId,
              sellerWallet: supplierWallet,
              quantityBase: lotQuantity.toString(),
              minPriceBase: price.toString(),
              buyNowPriceBase: price.toString(),
            }, preparer);

            const sellerBefore = await freeBalance(pool, supplierWallet, 'XUSD');
            const buyerBefore = await freeBalance(pool, lenderWallet, fundingCode);
            const receipt = await postOk(pool, {
              kind: 'buy_now',
              listingId,
              buyerWallet: lenderWallet,
              fundingCode,
            }, world.admin);

            credits.push((await freeBalance(pool, supplierWallet, 'XUSD')) - sellerBefore);
            const spent = buyerBefore - (await freeBalance(pool, lenderWallet, fundingCode));
            const conversion = receipt.conversion as {
              sourceDebit: string;
              fundingAsset: string;
              rateE6: string;
            };
            expect(conversion.fundingAsset).toBe(fundingCode);
            expect(conversion.rateE6).toBe(
              (fundingCode === 'XSGD' ? DEFAULT_XSGD_PER_XUSD : RATE_SCALE).toString(),
            );
            expect(spent).toBe(BigInt(conversion.sourceDebit));
            debits[fundingCode] = spent;
          }

          expect(credits).toEqual([price, price, price]);
          expect(debits.USDC).toBe(price);
          expect(debits.USDT).toBe(price);
          expect(debits.XSGD).toBe(
            convert(m.fromBaseUnits(price), 'XSGD', DEFAULT_XSGD_PER_XUSD).sourceDebit,
          );
          expect(debits.XSGD).toBeGreaterThanOrEqual(debits.USDC);
        },
      ),
      DB_RUNS,
    );

    expect(await ledgerHealth(world.pool)).toEqual(HEALTHY);
  });

  /**
   * Conservation under a sequence nobody designed.
   *
   * The commands are generated, including ones the ledger must refuse: a
   * non-positive top-up, a transfer of more than a wallet holds. Whether each
   * is accepted or refused, the four-part oracle has to read HEALTHY
   * afterwards, and a refusal has to leave no journal entry behind.
   */
  it('keeps the books balanced through any sequence of top-ups and transfers', async () => {
    const payableId = await issueAcceptedPayable(40_000_000n);
    const wallets = () => [world.supplierWallet, world.otherSupplierWallet, world.lenderWallet];

    const command = fc.oneof(
      fc.record({
        kind: fc.constant('top_up' as const),
        walletIndex: fc.integer({ min: 0, max: 2 }),
        cashCode: fc.constantFrom('XUSD', 'USDC', 'USDT', 'XSGD'),
        amountBase: fc.bigInt({ min: -5n, max: 5_000_000n }),
      }),
      fc.record({
        kind: fc.constant('transfer' as const),
        fromIndex: fc.integer({ min: 0, max: 2 }),
        toIndex: fc.integer({ min: 0, max: 2 }),
        quantityBase: fc.bigInt({ min: -5n, max: 30_000_000n }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 6 }), async (commands) => {
        const { pool } = world;
        const addresses = wallets();
        const before = await entryCount(pool);
        let accepted = 0;

        for (const c of commands) {
          const intent =
            c.kind === 'top_up'
              ? {
                  kind: 'top_up',
                  wallet: addresses[c.walletIndex],
                  cashCode: c.cashCode,
                  amountBase: c.amountBase.toString(),
                }
              : {
                  kind: 'transfer',
                  payableId,
                  fromWallet: addresses[c.fromIndex],
                  toWallet: addresses[c.toIndex],
                  quantityBase: c.quantityBase.toString(),
                };
          if ((await post(pool, intent, { actorUserId: world.admin })).ok) accepted += 1;
        }

        expect(await entryCount(pool)).toBe(before + accepted);
        expect(await ledgerHealth(pool)).toEqual(HEALTHY);
      }),
      DB_RUNS,
    );

    expect(await ledgerHealth(world.pool)).toEqual(HEALTHY);
  });
});
