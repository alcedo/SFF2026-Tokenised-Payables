/**
 * Every expected value here is copied from the PRD, not from a run of the code.
 * If the implementation changes and these fail, the implementation is wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  allocateProRata,
  formatUnits,
  fromWholeUnits,
  parseUnits,
  sum,
  ZERO,
} from '../money';
import { formatPercent, priceForTargetYield, priceFromPercent, quote } from '../pricing';
import { convert, DEFAULT_XSGD_PER_XUSD, formatRate } from '../fx';

describe('PRD section 6 worked example', () => {
  // "XUSD 250,000 face value, 90 days remaining, price 97.85% -> XUSD 244,625
  //  proceeds, XUSD 5,375 discount, 8.7% annualised discount cost and 8.9%
  //  lender yield."
  const face = fromWholeUnits(250_000);
  const price = priceFromPercent(face, 9785);
  const q = quote(face, price, 90);

  it('prices 97.85% of 250,000 face at exactly 244,625 XUSD', () => {
    expect(formatUnits(price, 2)).toBe('244,625.00');
  });

  it('reports a 5,375 XUSD discount', () => {
    expect(formatUnits(q.discount, 2)).toBe('5,375.00');
  });

  it('reports 8.7% annualised discount cost', () => {
    expect(formatPercent(q.annualisedDiscountCostPercent, 1)).toBe('8.7%');
  });

  it('reports 8.9% lender yield', () => {
    expect(formatPercent(q.lenderYieldPercent, 1)).toBe('8.9%');
  });

  it('keeps the two annualised measures distinct', () => {
    expect(q.annualisedDiscountCostPercent).not.toBe(q.lenderYieldPercent);
  });

  it('round-trips the price back to 97.85% of face', () => {
    expect(q.pricePercent.toFixed(2)).toBe('97.85');
  });
});

describe('PRD section 12 seed table', () => {
  // "Listed yields are calculated from the remaining days and asks above,
  //  rounded to one decimal place."
  const rows = [
    { ref: 'TP-2026-0143', faceUnits: 1_200_000, days: 30, askBps: 9942, yield: '7.1%' },
    { ref: 'TP-2026-0141', faceUnits: 250_000, days: 90, askBps: 9785, yield: '8.9%' },
    { ref: 'TP-2026-0142', faceUnits: 48_000, days: 60, askBps: 9840, yield: '9.9%' },
    { ref: 'SERIES-2026-Q4-30D', faceUnits: 180_000, days: 30, askBps: 9920, yield: '9.8%' },
  ] as const;

  for (const row of rows) {
    it(`${row.ref} yields ${row.yield}`, () => {
      const face = fromWholeUnits(row.faceUnits);
      const q = quote(face, priceFromPercent(face, row.askBps), row.days);
      expect(formatPercent(q.lenderYieldPercent, 1)).toBe(row.yield);
    });
  }
});

describe('maturity suppresses forward rates', () => {
  const face = fromWholeUnits(100_000);
  const price = priceFromPercent(face, 9900);

  it('annualises while days remain', () => {
    expect(quote(face, price, 1).maturity).toBe('live');
    expect(quote(face, price, 1).lenderYieldPercent).not.toBeNull();
  });

  it('reports due and no yield on the maturity date', () => {
    const q = quote(face, price, 0);
    expect(q.maturity).toBe('due');
    expect(q.lenderYieldPercent).toBeNull();
    expect(q.annualisedDiscountCostPercent).toBeNull();
    expect(formatPercent(q.lenderYieldPercent, 1)).toBe('—');
  });

  it('reports past-due after maturity', () => {
    expect(quote(face, price, -14).maturity).toBe('past-due');
  });
});

describe('base units admit no sub-unit precision', () => {
  it('parses four decimals exactly', () => {
    expect(parseUnits('250000.0000')).toBe(2_500_000_000n);
    expect(parseUnits('0.0001')).toBe(1n);
  });

  it('rejects an amount between base units rather than rounding it away', () => {
    expect(() => parseUnits('0.00005')).toThrow(/not representable/);
  });

  it('accepts trailing zeros beyond four decimals', () => {
    expect(parseUnits('1.50000000')).toBe(15_000n);
  });

  it('rejects text that is not a decimal amount', () => {
    expect(() => parseUnits('1e5')).toThrow(/not a decimal amount/);
    expect(() => parseUnits('')).toThrow(/not a decimal amount/);
  });

  it('formats at both the summary and detail precisions', () => {
    const value = parseUnits('1234567.8912');
    expect(formatUnits(value, 4)).toBe('1,234,567.8912');
    expect(formatUnits(value, 2)).toBe('1,234,567.89');
    expect(formatUnits(value, 0)).toBe('1,234,568');
  });
});

describe('pro-rata allocation reconciles to the obligation', () => {
  // PRD section 7: ADATA funds the full outstanding face, allocated to each
  // current holder in proportion to quantity held. The credits must sum back to
  // the single debit exactly, or holdings stop summing to outstanding face.
  it('splits a remainder-producing total without losing a base unit', () => {
    const total = parseUnits('100.0000');
    const parts = allocateProRata(total, [parseUnits('33.3333'), parseUnits('33.3333'), parseUnits('33.3334')]);
    expect(sum(parts)).toBe(total);
  });

  it('splits across many holders without drift', () => {
    const total = parseUnits('1000000.0000');
    const weights = Array.from({ length: 7 }, () => parseUnits('142857.1428'));
    const parts = allocateProRata(total, weights);
    expect(sum(parts)).toBe(total);
  });

  it('gives a sole holder the whole obligation', () => {
    const total = parseUnits('250000.0000');
    expect(allocateProRata(total, [total])).toEqual([total]);
  });

  it('refuses an allocation with no positive weight', () => {
    expect(() => allocateProRata(parseUnits('1.0000'), [ZERO])).toThrow(/positive weight/);
  });
});

describe('funding conversion', () => {
  const obligation = fromWholeUnits(244_625);

  for (const asset of ['XUSD', 'USDC', 'USDT'] as const) {
    it(`funds 1:1 from ${asset}`, () => {
      const c = convert(obligation, asset);
      expect(c.sourceDebit).toBe(obligation);
      expect(c.rounded).toBe(false);
      expect(c.rate).toBeNull();
    });
  }

  it('charges 1.31 XSGD per XUSD of obligation', () => {
    // 244,625 XUSD * 1.31 = 320,458.75 XSGD
    const c = convert(obligation, 'XSGD');
    expect(formatUnits(c.sourceDebit, 4)).toBe('320,458.7500');
    expect(c.obligationXusd).toBe(obligation);
  });

  it('states the rate it applied', () => {
    expect(formatRate(DEFAULT_XSGD_PER_XUSD)).toBe('1 XUSD = 1.3100 XSGD');
  });

  it('flags rounding when the conversion does not land on a base unit', () => {
    const c = convert(parseUnits('0.0001'), 'XSGD');
    expect(c.rounded).toBe(true);
    expect(c.sourceDebit).toBe(1n);
  });
});

describe('indicative pricing from a target yield', () => {
  it('returns a price that quotes back at the requested yield', () => {
    const face = fromWholeUnits(250_000);
    const price = priceForTargetYield(face, 8.9, 90);
    expect(formatPercent(quote(face, price, 90).lenderYieldPercent, 1)).toBe('8.9%');
  });

  it('lands next to the PRD worked example, which quotes the unrounded yield', () => {
    // The PRD's stated 244,625 price carries a true yield of 8.911%. Asking for
    // the rounded 8.9% therefore gives 244,632, seven XUSD above it. The gap is
    // the rounding in the PRD's display, not an error here.
    const face = fromWholeUnits(250_000);
    expect(formatUnits(priceForTargetYield(face, 8.9, 90), 0)).toBe('244,632');
    expect(formatUnits(priceForTargetYield(face, 8.911, 90), 0)).toBe('244,625');
  });

  it('refuses a target yield at or after maturity', () => {
    expect(() => priceForTargetYield(fromWholeUnits(1), 5, 0)).toThrow(/days remaining/);
  });
});
