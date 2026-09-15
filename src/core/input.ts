import {
  type BaseUnits,
  BPS_PER_100_PERCENT,
  gt,
  isPositive,
  lte,
  parseUnits,
  ZERO,
} from './money';

export type FieldResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const TERMS_MIN = 1;
const TERMS_MAX = 365;

function fail<T>(reason: string): FieldResult<T> {
  return { ok: false, reason };
}

function ok<T>(value: T): FieldResult<T> {
  return { ok: true, value };
}

function stripCommas(raw: string): string {
  return raw.trim().replace(/,/g, '');
}

/**
 * A typed face, top-up or buy-now amount in display units.
 *
 * Rejects zero, negatives, non-decimals, and any figure that needs more than
 * four decimal places. The minimum accepted value is one base unit (0.0001).
 */
export function parseAmount(raw: string): FieldResult<BaseUnits> {
  const text = stripCommas(raw);
  if (text === '') return fail('Enter an amount greater than zero.');
  try {
    const value = parseUnits(text);
    if (!isPositive(value)) return fail('Enter an amount greater than zero.');
    return ok(value);
  } catch (error) {
    return fail((error as Error).message);
  }
}

export function parseTermsDays(raw: string): FieldResult<number> {
  const text = raw.trim();
  if (text === '') return fail('Enter payment terms between 1 and 365 days.');
  if (!/^-?\d+$/.test(text)) return fail('Payment terms must be a whole number of days.');
  const days = Number(text);
  if (!Number.isInteger(days) || days < TERMS_MIN || days > TERMS_MAX) {
    return fail('Payment terms must be between 1 and 365 days.');
  }
  return ok(days);
}

/**
 * A price typed as a percentage of face, stored as whole basis points.
 *
 * Open at 0, closed at 100: a free listing is not a price, and a bid above
 * par is refused. Two-decimal entry (`97.85`) is the form's unit; rounding
 * to the nearest basis point is the same conversion the bid and listing
 * screens already performed.
 */
export function parsePricePercent(raw: string): FieldResult<number> {
  const text = stripCommas(raw);
  if (text === '') return fail('Enter a price between 0 and 100 percent of face.');
  const pct = Number(text);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return fail('Enter a price between 0 and 100 percent of face.');
  }
  const bps = Math.round(pct * 100);
  if (bps <= 0 || bps > BPS_PER_100_PERCENT) {
    return fail('Enter a price between 0 and 100 percent of face.');
  }
  return ok(bps);
}

/**
 * A holding quantity that must be a positive whole number of base units and
 * must not exceed what the wallet holds unlisted. PRD section 6.
 */
export function parseHoldingQuantity(raw: string, free: BaseUnits): FieldResult<BaseUnits> {
  const amount = parseAmount(raw);
  if (!amount.ok) return amount;
  if (gt(amount.value, free)) {
    return fail('That is more than the wallet holds unlisted.');
  }
  return amount;
}

/**
 * An optional buy-now price. Blank means bids only. A figure below the
 * minimum price is refused rather than silently becoming the minimum.
 */
export function parseOptionalBuyNow(raw: string, minPrice: BaseUnits): FieldResult<BaseUnits | null> {
  if (raw.trim() === '') return ok(null);
  const amount = parseAmount(raw);
  if (!amount.ok) return amount;
  if (lte(amount.value, ZERO)) return fail('Enter an amount greater than zero.');
  if (amount.value < minPrice) {
    return fail('A buy-now price cannot be below the minimum price.');
  }
  return amount;
}

/** A company or person name. The ledger refuses blanks as ADA28. */
export function parseRequiredName(raw: string): FieldResult<string> {
  const text = raw.trim();
  if (text === '') return fail('Enter a name.');
  return ok(text);
}

/** An invoice reference. The ledger refuses blanks as ADA25. */
export function parseInvoiceRef(raw: string): FieldResult<string> {
  const text = raw.trim();
  if (text === '') return fail('Enter the invoice reference this payable is backed by.');
  return ok(text);
}
