/**
 * The pricing convention from PRD section 6.
 *
 * "Use one calculation across listings, offers, dashboards, and the runbook."
 * That sentence is the reason this module exists and the reason it is pure.
 * Every screen that shows a price, a discount or a yield calls {@link quote}.
 * There is no second implementation to drift from this one.
 *
 * `F` and `P` always apply to the quantity being priced, never automatically to
 * the original invoice face. Callers pass the face of the listed quantity.
 */

import {
  BPS_PER_100_PERCENT,
  type BaseUnits,
  type PercentBps,
  gt,
  isPositive,
  mulDivRound,
  sub,
} from './money';

/**
 * Where a payable sits relative to its maturity date.
 *
 * PRD section 6: "At or after maturity, show 'Due' or 'Overdue' instead of
 * calculating a forward yield." Whether a past-due payable is reported as
 * Overdue also depends on whether it settled, which is lifecycle state rather
 * than arithmetic, so this type reports only what the clock can prove.
 */
export type MaturityState = 'live' | 'due' | 'past-due';

export function maturityState(daysRemaining: number): MaturityState {
  if (daysRemaining > 0) return 'live';
  return daysRemaining === 0 ? 'due' : 'past-due';
}

/**
 * The complete economics of one priced quantity.
 *
 * Returned as a whole rather than as five separate helpers because every
 * surface in the PRD shows these together, and a caller assembling them one
 * call at a time is how two screens end up disagreeing.
 *
 * The two annualised measures carry different denominators and must keep their
 * distinct labels (PRD section 6). They are deliberately named for what they
 * measure rather than shortened to a shared "yield".
 */
export interface Quote {
  /** `F`. XUSD face of the quantity being priced. */
  readonly face: BaseUnits;
  /** `P`. XUSD purchase price for that quantity. */
  readonly price: BaseUnits;
  /** `F - P`. */
  readonly discount: BaseUnits;
  /** `100 * P / F`, for display. */
  readonly pricePercent: number;
  /** `d`. Remaining calendar days to maturity, from the demo clock. */
  readonly daysRemaining: number;
  readonly maturity: MaturityState;
  /**
   * `100 * (F - P) / F * 365 / d`. The supplier's cost of financing.
   * Null at or after maturity, where a forward rate has no meaning.
   */
  readonly annualisedDiscountCostPercent: number | null;
  /**
   * `100 * (F - P) / P * 365 / d`. The lender's return on cash deployed.
   * Null at or after maturity.
   */
  readonly lenderYieldPercent: number | null;
}

/** Actual/365, no compounding, no fees. PRD section 6. */
const DAYS_PER_YEAR = 365;

/**
 * Convert a percent-of-face entry into a whole number of base units.
 *
 * PRD section 9: "percentage-of-face entry converts to the same amount using
 * listed face as `F`". The base-unit result is the canonical stored price; the
 * percentage is only ever an input or a display value. Rounding is half away
 * from zero, shared with every other rounding decision in the system.
 */
export function priceFromPercent(face: BaseUnits, percent: PercentBps): BaseUnits {
  if (!Number.isInteger(percent) || percent < 0) {
    throw new RangeError(`percent must be a non-negative whole number of basis points, received ${percent}`);
  }
  return mulDivRound(face, BigInt(percent), BigInt(BPS_PER_100_PERCENT));
}

/**
 * `100 * P / F` as a display number.
 *
 * Returns a float on purpose: this value is shown, never stored and never fed
 * back into an amount. The money path stays in base units.
 */
export function percentOfFace(price: BaseUnits, face: BaseUnits): number {
  if (!isPositive(face)) {
    throw new RangeError('face must be positive to express a price as a percentage of it');
  }
  return (Number(price) / Number(face)) * 100;
}

/**
 * Build the full economics for one priced quantity.
 *
 * @param face  `F`, the XUSD face of the quantity being priced.
 * @param price `P`, the XUSD price for that same quantity.
 * @param daysRemaining `d`, from the demo clock. May be zero or negative.
 */
export function quote(face: BaseUnits, price: BaseUnits, daysRemaining: number): Quote {
  if (!isPositive(face)) {
    throw new RangeError('face must be positive');
  }
  if (!Number.isInteger(daysRemaining)) {
    throw new RangeError(`daysRemaining must be a whole number of days, received ${daysRemaining}`);
  }
  const discount = sub(face, price);
  const maturity = maturityState(daysRemaining);
  const annualise = maturity === 'live';

  return {
    face,
    price,
    discount,
    pricePercent: percentOfFace(price, face),
    daysRemaining,
    maturity,
    annualisedDiscountCostPercent: annualise
      ? (Number(discount) / Number(face)) * 100 * (DAYS_PER_YEAR / daysRemaining)
      : null,
    lenderYieldPercent:
      annualise && isPositive(price)
        ? (Number(discount) / Number(price)) * 100 * (DAYS_PER_YEAR / daysRemaining)
        : null,
  };
}

/**
 * Find the price that produces a target lender yield, for the indicative price
 * a supplier is offered before they name their own (PRD section 8, screen 7).
 *
 * Derived from `y = (F - P) / P * 365 / d` solved for `P`:
 *   P = F / (1 + y * d / 365)
 */
export function priceForTargetYield(face: BaseUnits, targetYieldPercent: number, daysRemaining: number): BaseUnits {
  if (daysRemaining <= 0) {
    throw new RangeError('a target yield needs a positive number of days remaining');
  }
  const scale = 1_000_000n;
  const factor = 1 + (targetYieldPercent / 100) * (daysRemaining / DAYS_PER_YEAR);
  return mulDivRound(face, scale, BigInt(Math.round(factor * Number(scale))));
}

/**
 * Render a derived percentage.
 *
 * PRD section 12 rounds seeded yields to one decimal place; section 6 asks for
 * two decimals in summary views. The caller picks, and a null (at or after
 * maturity) renders as the maturity label instead of a number.
 */
export function formatPercent(value: number | null, decimals = 2): string {
  if (value === null) return '—';
  return `${value.toFixed(decimals)}%`;
}

/** The label shown where a forward yield would otherwise go. */
export function maturityLabel(state: MaturityState, settled: boolean): string {
  if (state === 'live') return 'Live';
  if (settled) return 'Settled';
  return state === 'due' ? 'Due' : 'Overdue';
}

/** True when `price` exceeds `face`, which no listing or bid may do. */
export function isAbovePar(face: BaseUnits, price: BaseUnits): boolean {
  return gt(price, face);
}
