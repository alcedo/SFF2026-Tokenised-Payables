/**
 * Money and quantity primitives.
 *
 * PRD section 6: "XUSD 1.0000 of face value corresponds to 10,000 base units.
 * The minimum increment is one base unit (XUSD 0.0001); amounts between base
 * units are not representable. Store and compute quantities as integers of
 * those base units."
 *
 * Every amount in this system is a whole number of base units, carried as a
 * `bigint`. That choice is load-bearing rather than stylistic: JavaScript
 * refuses to mix `bigint` and `number` in arithmetic, so a float that leaks
 * into the money path fails to compile under TypeScript and throws at runtime
 * under plain JS. The representation enforces the invariant; no lint rule or
 * code-review convention is relied on.
 *
 * Percentages, yields and FX display values are derived `number`s. They are
 * outputs only. Nothing in this module accepts one back as money.
 */

/** Base units per 1.0000 unit of any supported asset. PRD section 6. */
export const BASE_UNITS_PER_UNIT = 10_000n;

/** Decimal places implied by {@link BASE_UNITS_PER_UNIT}. */
export const DECIMALS = 4;

declare const baseUnitsBrand: unique symbol;

/**
 * A whole number of base units. Always non-negative in stored balances and
 * holdings; intermediate differences may be negative, which is why the brand
 * does not itself assert positivity.
 */
export type BaseUnits = bigint & { readonly [baseUnitsBrand]: true };

/**
 * Hundredths of a percent. 97.85% is 9785. Used for price entry, never for
 * storing money. PRD section 9 lets a seller enter a price as a percentage of
 * face; that entry is converted to base units at the boundary and the base-unit
 * value is what is stored.
 */
export type PercentBps = number;

/** Basis points in 100%. */
export const BPS_PER_100_PERCENT = 10_000;

/** The four assets a wallet holds. PRD section 10. */
export const ASSETS = ['XUSD', 'USDC', 'USDT', 'XSGD'] as const;
export type Asset = (typeof ASSETS)[number];

/** Assets that may fund an XUSD obligation. PRD section 6. */
export type FundingAsset = Asset;

/**
 * Obligations, listings, bids and redemptions are denominated in XUSD only.
 * PRD section 4 puts issuing or listing in USDC, USDT or XSGD out of scope, so
 * the denomination is a constant rather than a field.
 */
export const DENOMINATION = 'XUSD' as const satisfies Asset;

export function isAsset(value: string): value is Asset {
  return (ASSETS as readonly string[]).includes(value);
}

// --- construction -----------------------------------------------------------

/** Unchecked cast. Internal to this module; callers use the parsers below. */
function brand(value: bigint): BaseUnits {
  return value as BaseUnits;
}

export const ZERO: BaseUnits = brand(0n);

/**
 * Build base units from a whole number of display units (250_000 -> 2.5e9 BU).
 * Rejects non-integers so a caller cannot smuggle 0.1 through as "whole".
 */
export function fromWholeUnits(units: number): BaseUnits {
  if (!Number.isSafeInteger(units)) {
    throw new RangeError(`fromWholeUnits expects a safe integer, received ${units}`);
  }
  return brand(BigInt(units) * BASE_UNITS_PER_UNIT);
}

/**
 * Parse a decimal string such as "250000.0000" or "1234.5" into base units.
 *
 * This is the boundary parser for anything a human typed or a seed file holds.
 * It rejects rather than rounds when the input carries more precision than the
 * base unit can represent, so "0.00005" is an error instead of a silent 0.
 */
/** The exact shape `formatUnits` emits, so `1,0000` is still not ten thousand. */
const GROUPED = /^-?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

export function parseUnits(input: string): BaseUnits {
  // formatUnits groups the whole part with toLocaleString, so a figure copied
  // off a screen arrives with separators in it. This module is the only writer
  // and the only reader of its own decimal representation, so a value it
  // formatted has to parse back to itself. Groups of three only, so 1,0000 is
  // still refused rather than read as ten thousand.
  const raw = input.trim();
  const text = GROUPED.test(raw) ? raw.replace(/,/g, '') : raw;
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    throw new RangeError(`not a decimal amount: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > DECIMALS) {
    const excess = fraction.slice(DECIMALS);
    if (/[^0]/.test(excess)) {
      throw new RangeError(
        `${input} needs more than ${DECIMALS} decimals; amounts between base units are not representable`,
      );
    }
  }
  const padded = fraction.padEnd(DECIMALS, '0').slice(0, DECIMALS);
  const magnitude = BigInt(whole) * BASE_UNITS_PER_UNIT + BigInt(padded || '0');
  return brand(sign === '-' ? -magnitude : magnitude);
}

/**
 * Adopt a value already known to be a whole number of base units, such as a
 * BIGINT column read back from Postgres.
 */
export function fromBaseUnits(value: bigint | string | number): BaseUnits {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`base units must be a safe integer, received ${value}`);
    }
    return brand(BigInt(value));
  }
  return brand(BigInt(value));
}

// --- arithmetic -------------------------------------------------------------

export function add(a: BaseUnits, b: BaseUnits): BaseUnits {
  return brand(a + b);
}

export function sub(a: BaseUnits, b: BaseUnits): BaseUnits {
  return brand(a - b);
}

export function sum(values: readonly BaseUnits[]): BaseUnits {
  return brand(values.reduce<bigint>((acc, v) => acc + v, 0n));
}

export function isZero(a: BaseUnits): boolean {
  return a === 0n;
}

export function isNegative(a: BaseUnits): boolean {
  return a < 0n;
}

export function isPositive(a: BaseUnits): boolean {
  return a > 0n;
}

export function lt(a: BaseUnits, b: BaseUnits): boolean {
  return a < b;
}

export function lte(a: BaseUnits, b: BaseUnits): boolean {
  return a <= b;
}

export function gt(a: BaseUnits, b: BaseUnits): boolean {
  return a > b;
}

export function gte(a: BaseUnits, b: BaseUnits): boolean {
  return a >= b;
}

export function eq(a: BaseUnits, b: BaseUnits): boolean {
  return a === b;
}

export function min(a: BaseUnits, b: BaseUnits): BaseUnits {
  return a <= b ? a : b;
}

export function max(a: BaseUnits, b: BaseUnits): BaseUnits {
  return a >= b ? a : b;
}

/**
 * Divide `value * numerator / denominator`, rounding half away from zero.
 *
 * Every rounding decision in the system routes through here so the convention
 * is stated once rather than re-derived per call site. PRD section 6 requires
 * source-asset rounding to be explicit on confirmation; the caller reports the
 * rounded result, and this function guarantees the result is a whole base unit.
 */
export function mulDivRound(value: BaseUnits, numerator: bigint, denominator: bigint): BaseUnits {
  return brand(roundDiv(value * numerator, denominator));
}

/**
 * The same rounding on a plain bigint, for a scaled value that is not money.
 * A rate rendered to fewer decimals than it carries rounds by this rule too.
 */
export function roundDiv(product: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('division by zero');
  }
  const negative = product < 0n !== denominator < 0n;
  const absProduct = product < 0n ? -product : product;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = (absProduct * 2n + absDenominator) / (absDenominator * 2n);
  return negative ? -quotient : quotient;
}

/**
 * Split `total` across `weights` so the parts sum back to `total` exactly.
 *
 * Maturity settlement pays each current holder in proportion to quantity held
 * (PRD section 7). Rounding each holder independently would leave a residue of
 * a few base units against the obligation, breaking the section 13 rule that
 * holdings sum to outstanding face. The largest-remainder method assigns the
 * residue deterministically, so the credits always reconcile to the debit.
 */
export function allocateProRata(total: BaseUnits, weights: readonly BaseUnits[]): BaseUnits[] {
  // Guarded per weight, not on the sum. bigint division truncates toward zero,
  // which is a ceiling rather than a floor for a negative product, so the
  // "floors" can sum past the total, the residue comes out negative, and the
  // largest-remainder loop exits on its first test leaving the over-allocation
  // in place. The sum alone admitted that, and the postcondition is that the
  // parts sum back to the total exactly.
  if (weights.some((weight) => weight < 0n)) {
    throw new RangeError('allocateProRata cannot split across a negative weight');
  }
  const weightTotal = weights.reduce<bigint>((acc, w) => acc + w, 0n);
  if (weightTotal <= 0n) {
    throw new RangeError('allocateProRata needs at least one positive weight');
  }
  const floors: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let assigned = 0n;
  weights.forEach((weight, index) => {
    const exact = total * weight;
    const floor = exact / weightTotal;
    floors.push(floor);
    assigned += floor;
    remainders.push({ index, remainder: exact - floor * weightTotal });
  });
  let residue = total - assigned;
  remainders.sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));
  for (const { index } of remainders) {
    if (residue <= 0n) break;
    floors[index] += 1n;
    residue -= 1n;
  }
  return floors.map(brand);
}

// --- formatting -------------------------------------------------------------

/**
 * Render base units as a fixed-point decimal string.
 *
 * PRD section 6: two decimals in summary views, four in token detail. The
 * caller picks; the default is the full four so nothing is silently truncated.
 */
export function formatUnits(value: BaseUnits, decimals: number = DECIMALS): string {
  // Integer first. NaN passes both comparisons, and slice(0, NaN) then returns
  // '' while the suffix branch still takes the `.` path, so the answer was a
  // number with a decimal point and nothing after it.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > DECIMALS) {
    throw new RangeError(`decimals must be a whole number between 0 and ${DECIMALS}`);
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / BASE_UNITS_PER_UNIT;
  const fraction = absolute % BASE_UNITS_PER_UNIT;
  const fractionText = fraction.toString().padStart(DECIMALS, '0');
  const shown = roundFractionText(fractionText, decimals);
  const grouped = (shown.carry ? whole + 1n : whole).toLocaleString('en-US');
  const suffix = decimals === 0 ? '' : `.${shown.text}`;
  return `${negative ? '-' : ''}${grouped}${suffix}`;
}

/**
 * Truncate a four-digit fraction to `decimals`, rounding half up and reporting
 * a carry into the whole part. Returns one shape for every `decimals` value,
 * including the no-op case, so the caller never branches on which it got.
 */
function roundFractionText(fractionText: string, decimals: number): { text: string; carry: boolean } {
  if (decimals >= DECIMALS) return { text: fractionText, carry: false };
  const kept = fractionText.slice(0, decimals);
  const nextDigit = Number(fractionText[decimals] ?? '0');
  if (nextDigit < 5) return { text: kept, carry: false };
  const bumped = (BigInt(kept || '0') + 1n).toString();
  if (bumped.length > decimals) return { text: '0'.repeat(decimals), carry: true };
  return { text: bumped.padStart(decimals, '0'), carry: false };
}

/** Render with the asset ticker, e.g. "250,000.0000 XUSD". */
export function formatAmount(value: BaseUnits, asset: Asset, decimals: number = DECIMALS): string {
  return `${formatUnits(value, decimals)} ${asset}`;
}

/** Serialise for a JSON boundary. `bigint` has no JSON representation. */
export function toJson(value: BaseUnits): string {
  return value.toString();
}
