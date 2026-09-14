import { describe, expect, it } from 'vitest';

import {
  addDays,
  advance,
  clockAt,
  daysBetween,
  daysRemaining,
  formatClock,
  formatDaysRemaining,
  jumpToNextMaturity,
  parseIsoDate,
  reset,
  tenorDays,
  today,
} from '../clock';

const T0 = parseIsoDate('2026-10-01');

describe('calendar arithmetic stays on whole days', () => {
  it('counts days across a month boundary', () => {
    expect(daysBetween(T0, parseIsoDate('2026-10-31'))).toBe(30);
  });

  it('counts days across a year boundary', () => {
    expect(daysBetween(T0, parseIsoDate('2026-12-30'))).toBe(90);
  });

  it('counts backwards for a past date', () => {
    expect(daysBetween(T0, parseIsoDate('2026-09-01'))).toBe(-30);
  });

  it('handles a leap day', () => {
    expect(daysBetween(parseIsoDate('2028-02-28'), parseIsoDate('2028-03-01'))).toBe(2);
  });

  it('adds days across a year boundary', () => {
    expect(addDays(T0, 92)).toBe('2027-01-01');
  });

  it('rejects a malformed date', () => {
    expect(() => parseIsoDate('01-10-2026')).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDate('2026-13-01')).toThrow(/not a real calendar date/);
  });
});

describe('the clock drives days remaining', () => {
  const maturity = addDays(T0, 90);

  it('starts at the seeded tenor', () => {
    expect(daysRemaining(clockAt(T0), maturity)).toBe(90);
  });

  it('re-ages every payable when the world fast-forwards', () => {
    expect(daysRemaining(advance(clockAt(T0), 30), maturity)).toBe(60);
    expect(daysRemaining(advance(clockAt(T0), 89), maturity)).toBe(1);
  });

  it('reaches zero on the maturity date', () => {
    expect(daysRemaining(advance(clockAt(T0), 90), maturity)).toBe(0);
  });

  it('goes negative past maturity', () => {
    expect(daysRemaining(advance(clockAt(T0), 104), maturity)).toBe(-14);
  });

  it('keeps original tenor fixed while days remaining falls', () => {
    const clock = advance(clockAt(T0), 60);
    expect(tenorDays(T0, maturity)).toBe(90);
    expect(daysRemaining(clock, maturity)).toBe(30);
  });
});

describe('demo controls', () => {
  it('accumulates fast-forward steps', () => {
    const clock = advance(advance(advance(clockAt(T0), 1), 30), 30);
    expect(clock.offsetDays).toBe(61);
    expect(today(clock)).toBe('2026-12-01');
  });

  it('refuses to run time backwards', () => {
    expect(() => advance(clockAt(T0), -1)).toThrow(/only moves forward/);
  });

  it('jumps to the nearest maturity still ahead', () => {
    const dates = [addDays(T0, 90), addDays(T0, 30), addDays(T0, 60)];
    expect(jumpToNextMaturity(clockAt(T0), dates).offsetDays).toBe(30);
  });

  it('skips maturities already passed', () => {
    const dates = [addDays(T0, 30), addDays(T0, 90)];
    expect(jumpToNextMaturity(advance(clockAt(T0), 40), dates).offsetDays).toBe(90);
  });

  it('is a no-op once nothing is ahead', () => {
    const dates = [addDays(T0, 30)];
    const spent = advance(clockAt(T0), 200);
    expect(jumpToNextMaturity(spent, dates)).toEqual(spent);
  });

  it('is a no-op with no maturities at all', () => {
    expect(jumpToNextMaturity(clockAt(T0), [])).toEqual(clockAt(T0));
  });

  it('resets the world back to T0', () => {
    expect(reset(advance(clockAt(T0), 365)).offsetDays).toBe(0);
    expect(today(reset(advance(clockAt(T0), 365)))).toBe(T0);
  });
});

describe('display', () => {
  it('labels T0 and an offset differently', () => {
    expect(formatClock(clockAt(T0))).toBe('1 Oct 2026 (T0)');
    expect(formatClock(advance(clockAt(T0), 30))).toBe('31 Oct 2026 (T0 + 30d)');
  });

  it('never shows a negative day count', () => {
    expect(formatDaysRemaining(90)).toBe('90d');
    expect(formatDaysRemaining(0)).toBe('Due');
    expect(formatDaysRemaining(-45)).toBe('Overdue 45d');
  });
});
