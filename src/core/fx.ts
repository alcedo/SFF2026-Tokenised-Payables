/**
 * Funding-asset conversion. PRD sections 6 and 10.
 *
 * Obligations are always XUSD. A payer chooses which of the four assets funds
 * that obligation, and the recipient is always credited XUSD. This module owns
 * the one-way conversion from an XUSD obligation to the payer's source debit.
 *
 * The rate lives in the demo world (PRD section 11: reset restores the clock
 * and the mocked FX rate) and is passed in rather than read from a module-level
 * constant, so a reset cannot leave a stale rate behind in a warm serverless
 * instance.
 */

import { type Asset, type BaseUnits, mulDivRound } from './money';

/**
 * XSGD per 1 XUSD, scaled by {@link RATE_SCALE}.
 *
 * PRD section 6 states the mocked rate as "1XUSD = 1.31 XSGD", so the seeded
 * value is 1.31 * 1_000_000 = 1_310_000. Stored scaled and integral so that
 * conversion never touches a float.
 */
export type XsgdPerXusdRate = bigint;

/** The scale of `app.world.xsgd_per_xusd_e6`. */
export const RATE_SCALE = 1_000_000n;

/** The seeded rate. PRD section 6. */
export const DEFAULT_XSGD_PER_XUSD: XsgdPerXusdRate = 1_310_000n;

/**
 * What a payer is actually charged to discharge an XUSD obligation.
 *
 * PRD section 10 requires the conversion rate and the resulting source-asset
 * debit to be shown before confirmation, which is why this returns the rate it
 * used alongside the amount instead of just the number.
 */
export interface Conversion {
  /** The XUSD the recipient receives. Never altered by the funding choice. */
  readonly obligationXusd: BaseUnits;
  readonly fundingAsset: Asset;
  /** What leaves the payer's wallet, in `fundingAsset`. */
  readonly sourceDebit: BaseUnits;
  /**
   * XSGD per 1 XUSD, scaled by {@link RATE_SCALE}, or null for the 1:1 assets.
   * Present so the confirmation screen can state the rate it applied.
   */
  readonly rate: XsgdPerXusdRate | null;
  /** True when {@link sourceDebit} was rounded to the nearest base unit. */
  readonly rounded: boolean;
}

/**
 * Convert an XUSD obligation into the debit taken from the funding asset.
 *
 * USDC, USDT and XUSD fund XUSD at a mocked 1:1 (PRD section 6), so the debit
 * equals the obligation and no rounding occurs. XSGD applies the world rate.
 *
 * PRD section 10 words the XSGD case as "source debit = XUSD obligation / rate,
 * where rate is XUSD per 1 XSGD". Section 6 states the same rate the other way
 * up, as "1XUSD = 1.31 XSGD". Both describe one fact: discharging a 1 XUSD
 * obligation costs 1.31 XSGD. This module holds the rate in the section 6
 * orientation, XSGD per XUSD, and multiplies. The arithmetic is identical; the
 * multiplication is simply harder to invert by mistake.
 */
export function convert(
  obligationXusd: BaseUnits,
  fundingAsset: Asset,
  rate: XsgdPerXusdRate = DEFAULT_XSGD_PER_XUSD,
): Conversion {
  if (fundingAsset !== 'XSGD') {
    return {
      obligationXusd,
      fundingAsset,
      sourceDebit: obligationXusd,
      rate: null,
      rounded: false,
    };
  }
  if (rate <= 0n) {
    throw new RangeError('the XSGD rate must be positive');
  }
  const sourceDebit = mulDivRound(obligationXusd, rate, RATE_SCALE);
  const exact = obligationXusd * rate;
  return {
    obligationXusd,
    fundingAsset,
    sourceDebit,
    rate,
    rounded: exact % RATE_SCALE !== 0n,
  };
}

/** Render a scaled rate to four decimals, e.g. "1 XUSD = 1.3100 XSGD". */
export function formatRate(rate: XsgdPerXusdRate): string {
  const e4 = (rate + 50n) / 100n;
  return `1 XUSD = ${e4 / 10_000n}.${(e4 % 10_000n).toString().padStart(4, '0')} XSGD`;
}
