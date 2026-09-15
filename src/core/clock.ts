/**
 * The demo clock. PRD sections 11 and 13.
 *
 * Every time-derived value in the product (days remaining, yields, due status,
 * the maturity ladder) is computed from this clock rather than from the wall
 * clock or from a stored column. PRD section 13 is explicit that "tenor,
 * remaining days, percentages, and yields are derived rather than independently
 * editable values", and section 11 lets any viewer fast-forward the world, so a
 * stored day count would be wrong the moment someone pressed +30 days.
 *
 * Dates here are business dates, not instants. A payable matures on a date, not
 * at a time of day, so the whole module works in calendar days on UTC midnight
 * and never touches a local timezone. That keeps the booth laptop and the
 * tablet in agreement regardless of where either is set.
 */

/** A business date as `YYYY-MM-DD`. */
export type IsoDate = string & { readonly __brand: 'IsoDate' };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: string): IsoDate {
  if (!ISO_DATE.test(value)) {
    throw new RangeError(`expected a YYYY-MM-DD date, received ${JSON.stringify(value)}`);
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls an out-of-range day over instead of returning NaN, so
  // 2026-02-30 came back as a valid timestamp two days into March. Comparing
  // the round trip is what catches the day against the length of its month:
  // the brand promises the date exists, and a rolled-over value changes
  // identity the moment anything does arithmetic on it.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`not a real calendar date: ${value}`);
  }
  return value as IsoDate;
}

const MS_PER_DAY = 86_400_000;

function toUtcMs(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}

/** Whole calendar days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) {
    throw new RangeError(`addDays expects whole days, received ${days}`);
  }
  return fromUtcMs(toUtcMs(date) + days * MS_PER_DAY);
}

/**
 * The world's current position in time.
 *
 * `t0` is the seed date and never moves; `offsetDays` is everything the demo
 * controls have added. Holding the offset separately rather than mutating a
 * single date means "reset world" is a single assignment back to zero and the
 * seeded relative dates in PRD section 12 stay meaningful.
 */
export interface DemoClock {
  readonly t0: IsoDate;
  readonly offsetDays: number;
}

export function clockAt(t0: IsoDate, offsetDays = 0): DemoClock {
  if (!Number.isInteger(offsetDays)) {
    throw new RangeError(`offsetDays must be whole days, received ${offsetDays}`);
  }
  return { t0, offsetDays };
}

/** Today, as the demo world sees it. */
export function today(clock: DemoClock): IsoDate {
  return addDays(clock.t0, clock.offsetDays);
}

/**
 * `d` in the PRD section 6 pricing formulas. Zero on the maturity date,
 * negative after it.
 */
export function daysRemaining(clock: DemoClock, maturityDate: IsoDate): number {
  return daysBetween(today(clock), maturityDate);
}

/**
 * Original tenor, which PRD section 6 requires be displayed separately from
 * days remaining and does not change as the clock advances.
 */
export function tenorDays(issueDate: IsoDate, maturityDate: IsoDate): number {
  return daysBetween(issueDate, maturityDate);
}

/** The fast-forward steps offered in PRD section 11. */
export const FAST_FORWARD_STEPS = [1, 30] as const;

export function advance(clock: DemoClock, days: number): DemoClock {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`the demo clock only moves forward in whole days, received ${days}`);
  }
  return { ...clock, offsetDays: clock.offsetDays + days };
}

/**
 * "Jump to next maturity" from PRD section 11.
 *
 * Returns the clock unchanged when nothing is still ahead of it, so pressing
 * the control on a fully matured world is a no-op rather than an error. That
 * matters because the control sits on a bar the presenter may hit mid-sentence.
 */
export function jumpToNextMaturity(clock: DemoClock, maturityDates: readonly IsoDate[]): DemoClock {
  const now = today(clock);
  const ahead = maturityDates
    .map((date) => daysBetween(now, date))
    .filter((days) => days > 0)
    .sort((a, b) => a - b);
  const next = ahead[0];
  return next === undefined ? clock : advance(clock, next);
}

export function reset(clock: DemoClock): DemoClock {
  return { ...clock, offsetDays: 0 };
}

/** Format for the demo-controls bar, e.g. "14 Sep 2026 (T0 + 30d)". */
export function formatClock(clock: DemoClock): string {
  const date = new Date(`${today(clock)}T00:00:00Z`);
  const shown = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return clock.offsetDays === 0 ? `${shown} (T0)` : `${shown} (T0 + ${clock.offsetDays}d)`;
}

/**
 * Render days remaining for a table cell.
 *
 * PRD section 6 replaces a forward yield with "Due" or "Overdue" at or after
 * maturity; the same substitution applies to the day count so a row never shows
 * a negative number of days.
 */
export function formatDaysRemaining(days: number): string {
  if (days > 0) return `${days}d`;
  return days === 0 ? 'Due' : `Overdue ${Math.abs(days)}d`;
}
