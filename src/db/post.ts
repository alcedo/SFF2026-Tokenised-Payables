/**
 * The typed front door to `ledger.post()`.
 *
 * Everything that changes state in this system goes through this one function.
 * There is no repository layer, no `db.wallet.update`, and no second path.
 *
 * The result is a discriminated union rather than an exception, because every
 * caller is a server action that has to turn a refusal into inline feedback
 * (PRD §14), and an exception loses the reason on the way up. A failure here is
 * an expected outcome, not a crash: "the lender no longer has the funds" is
 * information the seller needs, not a bug.
 */

import { query } from './client';
import type { Asset, BaseUnits } from '@/core/money';
import type { Role } from '@/core/lifecycle';

// --- intents ----------------------------------------------------------------

/**
 * Every command the system accepts. Adding a member here without handling it in
 * `ledger.post()` produces a runtime `unknown intent kind`, which the intent
 * round-trip test in tests/ledger catches.
 */
export type Intent =
  // PRD §8 screen 2: "manual entry or Import from ERP". Two shapes, one kind,
  // because the database treats them as one act producing one audit event.
  | { kind: 'create_payable'; erpInvoiceId: string; ref: string; payableId?: string }
  | {
      kind: 'create_payable';
      ref: string;
      supplierId: string;
      invoiceRef: string;
      faceBase: BaseUnits;
      termsDays: number;
      payableId?: string;
    }
  | { kind: 'issue_payable'; payableId: string; toWallet: string; tokenId: number }
  | { kind: 'accept_receipt'; payableId: string }
  | { kind: 'reject_receipt'; payableId: string; holderWallet: string }
  | { kind: 'top_up'; wallet: string; cashCode: Asset; amountBase: BaseUnits }
  | { kind: 'transfer'; payableId: string; fromWallet: string; toWallet: string; quantityBase: BaseUnits }
  | {
      kind: 'publish_listing';
      listingId?: string;
      payableId: string;
      sellerWallet: string;
      quantityBase: BaseUnits;
      minPriceBase: BaseUnits;
      buyNowPriceBase?: BaseUnits;
    }
  | { kind: 'cancel_listing'; listingId: string }
  | {
      kind: 'place_bid';
      bidId?: string;
      listingId: string;
      bidderWallet: string;
      priceBase: BaseUnits;
      fundingCode: Asset;
    }
  | { kind: 'withdraw_bid'; bidId: string }
  | { kind: 'accept_bid'; listingId: string; bidId: string }
  | { kind: 'buy_now'; listingId: string; buyerWallet: string; fundingCode: Asset }
  // PRD §5 and §8 screen 5. Onboarding creates an organisation, its custodial
  // wallet and its first user; create_user adds another to one that exists.
  | {
      kind: 'onboard_entity';
      name: string;
      entityType: 'supplier' | 'lender';
      userName: string;
      role: 'supplier' | 'lender';
    }
  | { kind: 'create_user'; entityId: string; userName: string; role: Role }
  | { kind: 'remove_user'; userId: string }
  // PRD §5 and §8 screen 14. Both are enforced at issuance, not just shown.
  | { kind: 'set_programme_limit'; entityId: string; limitBase: BaseUnits | null }
  | {
      kind: 'set_certification';
      entityId: string;
      status: 'uncertified' | 'certified' | 'suspended';
    }
  // PRD §3 question 13: redemption is denominated in XUSD; the asset is chosen
  // only for payment, so it is required rather than defaulted.
  | { kind: 'settle_maturity'; payableId: string; fundingCode: Asset }
  | { kind: 'advance_clock'; days: number }
  | { kind: 'submit'; payableId: string }
  | { kind: 'approve'; payableId: string }
  | { kind: 'certify'; payableId: string }
  | { kind: 'grade'; payableId: string; grade: 'AAA' | 'AA' | 'A'; gradeRationale: string };

export interface Command {
  /**
   * Minted by the client when a confirmation dialog opens, so a double-click
   * and a serverless retry are the same key and collapse to one effect.
   *
   * For a system-triggered sweep with no dialog behind it, derive the key from
   * the target instead, e.g. `settle:<payableId>`, so a retried sweep after a
   * crash is naturally safe to re-run.
   */
  key: string;
  actorUserId: string;
  intent: Intent;
}

// --- results ----------------------------------------------------------------

export interface Receipt {
  txHash: string;
  blockNumber: string;
  status: 'confirmed' | 'pending' | 'failed' | 'not_applicable';
  /** Always true in this build. PRD §10 requires every receipt be labelled. */
  simulated: true;
}

export interface Conversion {
  fundingAsset: Asset;
  sourceDebit: BaseUnits;
  rateE6: bigint;
}

export interface PostSuccess {
  entryId: string;
  seq: bigint;
  kind: string;
  worldDate: string;
  /** True when this call matched an existing idempotency key. */
  replayed: boolean;
  receipt: Receipt | null;
  conversion: Conversion | null;
}

export type PostErrorCode =
  | 'insufficient_funds'
  | 'insufficient_quantity'
  | 'listing_not_open'
  | 'bid_not_open'
  | 'past_maturity'
  | 'stale_owner'
  | 'series_not_whole_lot'
  | 'not_permitted'
  | 'already_settled'
  | 'duplicate_listing'
  | 'key_reused'
  | 'contended'
  | 'invalid_amount'
  // PRD §8 screen 2's manual entry is the first form a person types into
  // freely, so its refusals get their own codes rather than being folded into
  // not_permitted. See the registry in db/schema.sql.
  | 'duplicate_invoice'
  | 'invalid_terms'
  | 'unknown_supplier'
  | 'missing_invoice_ref'
  | 'duplicate_reference'
  | 'duplicate_entity'
  | 'missing_name'
  | 'role_mismatch'
  | 'last_user'
  | 'supplier_not_onboarded'
  | 'issuer_not_certified'
  | 'programme_limit_exceeded'
  | 'not_institutional'
  | 'not_graded'
  | 'wrong_actor_role'
  | 'receipt_rejected'
  | 'below_min_price'
  | 'unknown';

export interface PostError {
  code: PostErrorCode;
  /** The database's own message. Safe to show: it names no internals. */
  detail: string;
}

export type PostResult = { ok: true; value: PostSuccess } | { ok: false; error: PostError };

/**
 * SQLSTATE to tagged code.
 *
 * The ADA* codes are raised deliberately by `ledger.post()`. The standard codes
 * are the ones the schema's own constraints raise, which is the point of
 * putting those invariants in the database: an overdraft does not need an
 * explicit check in application code, it needs a CHECK and a mapping here.
 */
const CODE_BY_SQLSTATE: Record<string, PostErrorCode> = {
  ADA02: 'unknown',
  ADA03: 'unknown',
  ADA04: 'insufficient_quantity',
  ADA05: 'unknown',
  ADA06: 'not_permitted',
  ADA10: 'key_reused',
  ADA11: 'listing_not_open',
  ADA12: 'past_maturity',
  ADA13: 'stale_owner',
  ADA14: 'series_not_whole_lot',
  ADA15: 'not_permitted',
  ADA16: 'already_settled',
  ADA17: 'unknown',
  ADA18: 'unknown',
  ADA19: 'invalid_amount',
  ADA22: 'duplicate_invoice',
  ADA23: 'invalid_terms',
  ADA24: 'unknown_supplier',
  ADA25: 'missing_invoice_ref',
  ADA26: 'duplicate_reference',
  ADA27: 'duplicate_entity',
  ADA28: 'missing_name',
  ADA29: 'role_mismatch',
  ADA30: 'last_user',
  ADA31: 'supplier_not_onboarded',
  ADA32: 'issuer_not_certified',
  ADA33: 'programme_limit_exceeded',
  ADA34: 'not_institutional',
  ADA35: 'not_graded',
  ADA36: 'wrong_actor_role',
  ADA37: 'receipt_rejected',
  ADA38: 'below_min_price',
  ADA20: 'insufficient_funds',
  ADA21: 'insufficient_quantity',
  '23505': 'duplicate_listing',
  '55P03': 'contended', // lock_not_available, from lock_timeout
  '40P01': 'contended', // deadlock_detected
  '57014': 'contended', // query_canceled, from statement_timeout
};

/**
 * A bare CHECK violation reaching here means the backstop fired instead of the
 * shortfall check inside `ledger.post_legs`, which normally raises ADA20 or
 * ADA21 while it still has the asset kind in hand.
 *
 * One CHECK guards every asset, so the constraint name alone cannot say whether
 * a wallet ran out of dollars or ran out of payable. Rather than guess, this
 * reports the generic shortfall: the amount is right, only the noun is missing.
 */
function codeForCheckViolation(detail: string): PostErrorCode {
  return /wallet_balance_non_negative/.test(detail) ? 'insufficient_quantity' : 'unknown';
}

interface PgError extends Error {
  code?: string;
  detail?: string;
}

export async function post(command: Command): Promise<PostResult> {
  const payload = {
    idempotencyKey: command.key,
    actorUserId: command.actorUserId,
    intent: serialiseIntent(command.intent),
  };

  try {
    const rows = await query<{ post: PostSuccess }>('SELECT ledger.post($1::jsonb) AS post', [
      JSON.stringify(payload),
    ]);
    const raw = rows[0]?.post;
    if (!raw) {
      return { ok: false, error: { code: 'unknown', detail: 'ledger.post returned nothing' } };
    }
    return { ok: true, value: reviveSuccess(raw) };
  } catch (error) {
    const pg = error as PgError;
    const sqlstate = pg.code ?? '';
    const detail = pg.message ?? String(error);
    const code =
      sqlstate === '23514' ? codeForCheckViolation(detail) : (CODE_BY_SQLSTATE[sqlstate] ?? 'unknown');
    return { ok: false, error: { code, detail } };
  }
}

/**
 * `bigint` has no JSON representation, so amounts cross into the database as
 * decimal strings and are cast back to `bigint` by `ledger.post()`. Doing it
 * here, once, is what keeps every call site free of the conversion.
 */
function serialiseIntent(intent: Intent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(intent)) {
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out;
}

function reviveSuccess(raw: PostSuccess): PostSuccess {
  return {
    ...raw,
    seq: BigInt(raw.seq),
    receipt: raw.receipt ? { ...raw.receipt, simulated: true } : null,
    conversion: raw.conversion
      ? {
          fundingAsset: raw.conversion.fundingAsset,
          sourceDebit: BigInt(raw.conversion.sourceDebit as unknown as string) as BaseUnits,
          rateE6: BigInt(raw.conversion.rateE6 as unknown as string),
        }
      : null,
  };
}

/**
 * Messages for the refusals a persona can actually cause. PRD §14 asks for
 * clear inline feedback; each of these says what happened and what did not.
 */
export const ERROR_MESSAGE: Record<PostErrorCode, string> = {
  insufficient_funds:
    'That wallet no longer holds enough of the funding asset. Nothing was charged and the position is unchanged.',
  insufficient_quantity:
    'That is more than the wallet holds unlisted. Listed quantity is locked to its listing until the listing closes.',
  listing_not_open: 'That listing is no longer open. Another offer was accepted, or the seller withdrew it.',
  bid_not_open: 'That offer was withdrawn or superseded.',
  past_maturity: 'This payable has reached maturity. Listings and transfers close at maturity.',
  stale_owner: 'The holder changed while this was open. Reload and try again.',
  series_not_whole_lot: 'Every payable in a series must be wholly held by the seller before the series can move.',
  not_permitted: 'That persona cannot take this action.',
  already_settled: 'This payable has already settled. It cannot settle twice.',
  duplicate_listing: 'That wallet already has an open listing for this payable.',
  key_reused: 'This confirmation was already used for a different action. Reopen the dialog and try again.',
  contended: 'Someone else is acting on this right now. Try again in a moment.',
  invalid_amount: 'Enter an amount greater than zero, in whole units of 0.0001.',
  duplicate_invoice:
    'That invoice has already been financed for this supplier. One invoice backs one payable.',
  invalid_terms: 'Payment terms must be between 1 and 365 days.',
  unknown_supplier: 'That supplier is not on the platform.',
  missing_invoice_ref: 'Enter the invoice reference this payable is backed by.',
  duplicate_reference: 'That payable reference is already in use. Reload and try again.',
  duplicate_entity: 'An organisation with that name is already on the platform.',
  missing_name: 'Enter a name.',
  role_mismatch: 'That persona does not belong in that kind of organisation.',
  last_user:
    'That is the only account for this organisation. Removing it would strand the wallet it holds, so add another account first.',
  supplier_not_onboarded:
    'That supplier has no account yet, so nobody could accept the payable. Onboard them first.',
  issuer_not_certified:
    'That issuer is not certified under this programme, so nothing can be issued against it.',
  programme_limit_exceeded:
    'This issuance would take the issuer over its programme limit. Raise the limit, or wait for an outstanding payable to settle.',
  not_institutional:
    'Only institutional lender accounts can bid or buy. Switch to a lender persona in the demo controls.',
  not_graded: 'This payable has no grade yet. Assign one before certifying it.',
  below_min_price:
    'That offer is below the minimum price the seller published for this listing. Raise the offer, or use Buy now.',
  receipt_rejected:
    'This payable was rejected by its supplier, so the quantity went back to ADATA and there is nobody to redeem to. It cannot be settled.',
  wrong_actor_role:
    'That persona cannot take this step. Each lifecycle step belongs to one role: the preparer submits and redeems, a separate checker approves, and StraitsX certifies and issues.',
  unknown: 'That did not go through. Nothing was changed.',
};
