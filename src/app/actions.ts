'use server';

/**
 * Every write the UI can perform.
 *
 * Each action is a thin shell: resolve who is acting, hand an intent to
 * `post()`, turn a refusal into a message. No business rule lives here. That is
 * deliberate per the boundary-discipline principle: the rules are in the
 * database where they can be enforced under lock, and duplicating them here
 * would create a second opinion that can disagree.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import { ERROR_MESSAGE, type Intent, post } from '@/db/post';
import { readPayables, readPersonas, readWorld } from '@/db/read';
import { currentPersona, setPersona } from './session';

export interface ActionResult {
  ok: boolean;
  message: string;
  receipt?: { txHash: string; blockNumber: string; simulated: true } | null;
  conversion?: { fundingAsset: string; sourceDebit: string; rateE6: string } | null;
  replayed?: boolean;
}

/**
 * Run an intent as the acting persona.
 *
 * The idempotency key is passed in by the form that opened the dialog, so a
 * double-clicked Confirm and a retried POST collapse to one effect and return
 * the same receipt. A caller that omits one gets a fresh key, which is correct
 * for actions with no confirmation step.
 */
async function run(intent: Intent, key?: string): Promise<ActionResult> {
  const persona = await currentPersona();
  const result = await post({ key: key ?? randomUUID(), actorUserId: persona.userId, intent });

  if (!result.ok) {
    return { ok: false, message: ERROR_MESSAGE[result.error.code] };
  }

  // The whole world is shared, so a write anywhere can change any screen.
  revalidatePath('/', 'layout');

  return {
    ok: true,
    message: result.value.replayed ? 'Already done. Showing the original receipt.' : 'Done.',
    replayed: result.value.replayed,
    receipt: result.value.receipt
      ? {
          txHash: result.value.receipt.txHash,
          blockNumber: String(result.value.receipt.blockNumber),
          simulated: true,
        }
      : null,
    conversion: result.value.conversion
      ? {
          fundingAsset: result.value.conversion.fundingAsset,
          sourceDebit: result.value.conversion.sourceDebit.toString(),
          rateE6: result.value.conversion.rateE6.toString(),
        }
      : null,
  };
}

// --- demo controls (PRD §11) -------------------------------------------------

export async function switchPersona(userId: string): Promise<void> {
  await setPersona(userId);
  revalidatePath('/', 'layout');
}

export async function advanceClock(days: number): Promise<ActionResult> {
  return run({ kind: 'advance_clock', days });
}

/**
 * "Jump to next maturity". Computed here rather than in SQL so the definition
 * of "next" matches the one the screens use.
 */
export async function jumpToNextMaturity(): Promise<ActionResult> {
  const world = await readWorld();
  const ahead = (await readPayables(world))
    .filter((p) => p.status !== 'settled' && p.daysRemaining > 0)
    .map((p) => p.daysRemaining)
    .sort((a, b) => a - b);
  if (ahead.length === 0) {
    return { ok: true, message: 'Nothing is still ahead of the clock.' };
  }
  return run({ kind: 'advance_clock', days: ahead[0]! });
}

export async function topUp(wallet: string, cashCode: string, amountBase: string): Promise<ActionResult> {
  return run({
    kind: 'top_up',
    wallet,
    cashCode: cashCode as never,
    amountBase: BigInt(amountBase) as never,
  });
}

// --- ADATA ------------------------------------------------------------------

export async function createPayableFromErp(
  erpInvoiceId: string,
  ref: string,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'create_payable', erpInvoiceId, ref }, key);
}

/**
 * PRD §8 screen 2's other path: an invoice typed by hand rather than imported.
 *
 * Takes strings because it is called from a form. Everything it can get wrong —
 * a blank reference, a zero face, zero-day terms, an unknown supplier, an
 * invoice already financed — is refused by `ledger.post()` with a message, not
 * validated twice.
 */
export async function createPayableManually(
  ref: string,
  supplierId: string,
  invoiceRef: string,
  faceBase: string,
  termsDays: string,
  key?: string,
): Promise<ActionResult> {
  return run(
    {
      kind: 'create_payable',
      ref,
      supplierId,
      invoiceRef,
      faceBase: BigInt(faceBase) as never,
      termsDays: Number(termsDays),
    },
    key,
  );
}

export async function submitPayable(payableId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'submit', payableId }, key);
}

export async function approvePayable(payableId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'approve', payableId }, key);
}

export async function certifyPayable(payableId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'certify', payableId }, key);
}

export async function cancelPayable(payableId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'cancel_payable', payableId }, key);
}

export async function gradePayable(
  payableId: string,
  grade: 'AAA' | 'AA' | 'A',
  gradeRationale: string,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'grade', payableId, grade, gradeRationale }, key);
}

export async function issuePayable(
  payableId: string,
  toWallet: string,
  tokenId: number,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'issue_payable', payableId, toWallet, tokenId }, key);
}

/** PRD §3 question 7: the supplier decides whether to take delivery. */
export async function acceptReceipt(payableId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'accept_receipt', payableId }, key);
}

export async function rejectReceipt(
  payableId: string,
  holderWallet: string,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'reject_receipt', payableId, holderWallet }, key);
}

export async function settleMaturity(
  payableId: string,
  fundingCode: string,
  key?: string,
): Promise<ActionResult> {
  // A deterministic key, because a settlement sweep has no dialog to mint one
  // and a retry after a crash must not pay twice. The asset is in the seed so
  // that a retry in a different asset is refused as already settled rather
  // than as a reused key.
  return run(
    { kind: 'settle_maturity', payableId, fundingCode: fundingCode as never },
    key ?? deterministicKey(`settle:${payableId}:${fundingCode}`),
  );
}

// --- market -----------------------------------------------------------------

export async function publishListing(
  input: { payableId?: string; seriesId?: string; sellerWallet: string; quantityBase: string; minPriceBase: string; buyNowPriceBase?: string },
  key?: string,
): Promise<ActionResult> {
  return run(
    {
      kind: 'publish_listing',
      ...(input.seriesId ? { seriesId: input.seriesId } : { payableId: input.payableId! }),
      sellerWallet: input.sellerWallet,
      quantityBase: BigInt(input.quantityBase) as never,
      minPriceBase: BigInt(input.minPriceBase) as never,
      ...(input.buyNowPriceBase ? { buyNowPriceBase: BigInt(input.buyNowPriceBase) as never } : {}),
    } as Intent,
    key,
  );
}

export async function cancelListing(listingId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'cancel_listing', listingId }, key);
}

export async function placeBid(
  listingId: string,
  bidderWallet: string,
  priceBase: string,
  fundingCode: string,
  key?: string,
): Promise<ActionResult> {
  return run(
    {
      kind: 'place_bid',
      listingId,
      bidderWallet,
      priceBase: BigInt(priceBase) as never,
      fundingCode: fundingCode as never,
    },
    key,
  );
}

export async function acceptBid(listingId: string, bidId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'accept_bid', listingId, bidId }, key);
}

/**
 * PRD §8 screen 11. Buy now: take the lot at the price the seller published,
 * without waiting for them to accept a bid.
 */
export async function buyNow(
  listingId: string,
  buyerWallet: string,
  fundingCode: string,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'buy_now', listingId, buyerWallet, fundingCode: fundingCode as never }, key);
}

export async function transferQuantity(
  payableId: string,
  fromWallet: string,
  toWallet: string,
  quantityBase: string,
  key?: string,
): Promise<ActionResult> {
  return run(
    { kind: 'transfer', payableId, fromWallet, toWallet, quantityBase: BigInt(quantityBase) as never },
    key,
  );
}

// --- accounts (PRD §5, §8 screen 5) -----------------------------------------

/**
 * Onboard a counterparty and switch to it. PRD §8 screen 5, §5.
 *
 * Switching afterwards is the point of the flow, not a convenience: §5 asks to
 * "create a user, assign a persona, then view this newly created user in the
 * drop down and switch to the user". Landing on the new persona's own screen
 * is what shows the account is real.
 */
export async function onboardEntity(
  name: string,
  entityType: string,
  userName: string,
  key?: string,
): Promise<ActionResult> {
  const result = await run(
    {
      kind: 'onboard_entity',
      name,
      entityType: entityType as never,
      userName,
      // A supplier company gets a supplier persona and a lender company a
      // lender one. The database refuses any other pairing, so there is
      // nothing here for a form to get wrong.
      role: entityType as never,
    },
    key,
  );
  if (result.ok) {
    const created = (await readPersonas()).find((p) => p.name === userName.trim());
    if (created) await setPersona(created.userId);
    revalidatePath('/', 'layout');
  }
  return result;
}

export async function createUser(
  entityId: string,
  userName: string,
  role: string,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'create_user', entityId, userName, role: role as never }, key);
}

export async function removeUser(userId: string, key?: string): Promise<ActionResult> {
  return run({ kind: 'remove_user', userId }, key);
}

/**
 * PRD §5: the StraitsX admin's two levers over an issuer. Both bite at
 * issuance, so changing one here changes what the programme can do next, not
 * just what a screen reports.
 */
export async function setProgrammeLimit(
  entityId: string,
  limitBase: string | null,
  key?: string,
): Promise<ActionResult> {
  return run(
    { kind: 'set_programme_limit', entityId, limitBase: limitBase === null ? null : (BigInt(limitBase) as never) },
    key,
  );
}

export async function setCertification(
  entityId: string,
  status: string,
  key?: string,
): Promise<ActionResult> {
  return run({ kind: 'set_certification', entityId, status: status as never }, key);
}

/**
 * A stable UUID derived from a string, for operations whose identity is their
 * target rather than a dialog the user opened.
 */
function deterministicKey(seed: string): string {
  const hash = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${hex.repeat(2).slice(0, 12)}`;
}
