/**
 * The two reference numbers a preparer meets on PRD §8 screen 2.
 *
 * A payable carries the programme's own reference, `TP-2026-0141`, and the
 * supplier's invoice number, `INV-TW-88Q4A`. Both are sequential within their
 * series and both are generated the same way, by continuing from the highest
 * one already in use. That rule lived in three places before this module: a
 * regex in the create page and a `padStart` in each of the two entry forms.
 *
 * PRD §12 fixes the seeded `TP-2026-xxxx` numbers as identifiers rather than
 * live dates, so the year is part of the prefix and does not follow the clock.
 * The demo world's T0 moves; these do not.
 *
 * Suggesting rather than assigning. The database owns uniqueness: one unique
 * index guards the payable reference and another guards (supplier, invoice
 * reference), and `ledger.post()` refuses a collision by name. What these
 * functions buy is that a preparer creating the tenth payable of a demo does
 * not have to invent a number, and that the number offered is not one already
 * on the books.
 */

/** Payable references are four digits within the programme year. */
const PAYABLE_PREFIX = 'TP-2026-';
const PAYABLE_WIDTH = 4;

/** Invoice references are five digits behind the supplier's country code. */
const INVOICE_PREFIX = 'INV-TW-';
const INVOICE_WIDTH = 5;

/**
 * The next free number in a prefixed series.
 *
 * Only all-digit tails count toward the maximum. The seeded register contains
 * `INV-TW-88Q4A`, which is a real invoice number and not a member of any
 * sequence, so reading it as 88 would hand back a reference thousands below the
 * ones already issued.
 */
function nextInSeries(existing: Iterable<string>, prefix: string, width: number): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let highest = 0;
  for (const ref of existing) {
    const digits = pattern.exec(ref)?.[1];
    if (digits !== undefined) highest = Math.max(highest, Number(digits));
  }
  return `${prefix}${String(highest + 1).padStart(width, '0')}`;
}

/** The next programme reference, continuing the seeded `TP-2026-xxxx` series. */
export function nextPayableRef(existingRefs: Iterable<string>): string {
  return nextInSeries(existingRefs, PAYABLE_PREFIX, PAYABLE_WIDTH);
}

/**
 * An invoice reference the preparer can accept or type over.
 *
 * Feed it every reference the world knows, both the payables already raised and
 * the ERP register waiting to be imported. An unconsumed register row is a
 * reference about to exist, and suggesting it would collide the moment someone
 * imported that invoice for the same supplier.
 */
export function suggestInvoiceRef(existingRefs: Iterable<string>): string {
  return nextInSeries(existingRefs, INVOICE_PREFIX, INVOICE_WIDTH);
}
