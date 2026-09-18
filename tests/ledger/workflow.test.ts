import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, query } from '@/db/client';
import { post, type Intent } from '@/db/post';

const DB_NAME = 'adata_test_workflow';

const PREP = '11111111-0000-0000-0000-000000000001';
const CHECKR = '11111111-0000-0000-0000-000000000002';
const ADMIN = '11111111-0000-0000-0000-000000000008';
const SUPP_USER = '11111111-0000-0000-0000-000000000003';
const BANK_USER = '11111111-0000-0000-0000-000000000004';
const SUPP = '0x509911000000000000000000000000000000f88a';
const BANK = '0x1e4de40000000000000000000000000000004b13';
const SUPPLIER_ENTITY = 'e0000000-0000-0000-0000-0000000000a2';
const FACE = 1_234_500_000n;
const PRICE = 1_208_000_000n;

function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, DB_NAME },
  });
}

beforeAll(() => {
  run('scripts/db.sh', ['bare']);
  process.env.DATABASE_URL = run('scripts/db.sh', ['url']).trim();
  run('psql', [process.env.DATABASE_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/ledger/fixture.sql']);
}, 60_000);

afterAll(async () => {
  await closePool();
});

async function mustPost(actorUserId: string, intent: Intent) {
  const result = await post({ key: randomUUID(), actorUserId, intent });
  if (!result.ok) {
    throw new Error(`${intent.kind} refused: ${result.error.code} ${result.error.detail}`);
  }
  return result.value;
}

describe('issue → list → bid → accept as one walk', () => {
  it('conserves face and fills exactly one listing', async () => {
    await mustPost(PREP, {
      kind: 'create_payable',
      ref: 'TP-WF-0001',
      supplierId: SUPPLIER_ENTITY,
      invoiceRef: 'INV-WF-0001',
      faceBase: FACE as never,
      termsDays: 60,
    });
    const payableRows = await query<{ id: string }>('SELECT id FROM app.payable WHERE ref = $1', [
      'TP-WF-0001',
    ]);
    const payableId = payableRows[0]!.id;

    await mustPost(PREP, { kind: 'submit', payableId });
    await mustPost(CHECKR, { kind: 'approve', payableId });
    await mustPost(PREP, {
      kind: 'grade',
      payableId,
      grade: 'AA',
      gradeRationale: 'Workflow coverage grade. Sample value.',
    });

    await mustPost(ADMIN, { kind: 'certify', payableId });
    await mustPost(ADMIN, {
      kind: 'issue_payable',
      payableId,
      toWallet: SUPP,
      tokenId: 8801,
    });
    await mustPost(SUPP_USER, { kind: 'accept_receipt', payableId });
    await mustPost(SUPP_USER, {
      kind: 'publish_listing',
      listingId: '7a000000-0000-0000-0000-00000000aa01',
      payableId,
      sellerWallet: SUPP,
      quantityBase: FACE as never,
      minPriceBase: PRICE as never,
    });
    await mustPost(BANK_USER, {
      kind: 'place_bid',
      bidId: 'b0000000-0000-0000-0000-00000000aa01',
      listingId: '7a000000-0000-0000-0000-00000000aa01',
      bidderWallet: BANK,
      priceBase: PRICE as never,
      fundingCode: 'USDC',
    });
    await mustPost(SUPP_USER, {
      kind: 'accept_bid',
      listingId: '7a000000-0000-0000-0000-00000000aa01',
      bidId: 'b0000000-0000-0000-0000-00000000aa01',
    });

    const listing = await query<{ status: string }>(
      'SELECT status::text AS status FROM app.listing WHERE id = $1',
      ['7a000000-0000-0000-0000-00000000aa01'],
    );
    expect(listing[0]!.status).toBe('filled');

    const held = await query<{ wallet: string; qty: bigint }>(
      'SELECT wallet_address AS wallet, quantity_base AS qty FROM ledger.v_holding WHERE payable_id = $1',
      [payableId],
    );
    const byWallet = Object.fromEntries(held.map((row) => [row.wallet, row.qty]));
    expect(byWallet[BANK]).toBe(FACE);
    expect(byWallet[SUPP] ?? 0n).toBe(0n);

    const face = held.reduce((acc, row) => acc + row.qty, 0n);
    expect(face).toBe(FACE);

    const drift = await query<{ count: bigint }>('SELECT count(*)::bigint AS count FROM ledger.prove_books_balance()');
    expect(drift[0]!.count).toBe(0n);
  });

  it('refuses to fill a large listing at a bid placed on a smaller one', async () => {
    const smallFace = 100_000_000n;
    const largeFace = 9_000_000_000n;
    const smallPrice = 97_000_000n;
    const largeMin = 8_800_000_000n;

    async function issueAndList(
      ref: string,
      invoiceRef: string,
      face: bigint,
      minPrice: bigint,
      listingId: string,
      tokenId: number,
    ): Promise<string> {
      await mustPost(PREP, {
        kind: 'create_payable',
        ref,
        supplierId: SUPPLIER_ENTITY,
        invoiceRef,
        faceBase: face as never,
        termsDays: 60,
      });
      const payableId = (await query<{ id: string }>('SELECT id FROM app.payable WHERE ref = $1', [ref]))[0]!.id;
      await mustPost(PREP, { kind: 'submit', payableId });
      await mustPost(CHECKR, { kind: 'approve', payableId });
      await mustPost(PREP, {
        kind: 'grade',
        payableId,
        grade: 'AA',
        gradeRationale: 'Workflow coverage grade. Sample value.',
      });
      await mustPost(ADMIN, { kind: 'certify', payableId });
      await mustPost(ADMIN, { kind: 'issue_payable', payableId, toWallet: SUPP, tokenId });
      await mustPost(SUPP_USER, { kind: 'accept_receipt', payableId });
      await mustPost(SUPP_USER, {
        kind: 'publish_listing',
        listingId,
        payableId,
        sellerWallet: SUPP,
        quantityBase: face as never,
        minPriceBase: minPrice as never,
      });
      return payableId;
    }

    const largeListing = '7a000000-0000-0000-0000-00000000aa02';
    const smallListing = '7a000000-0000-0000-0000-00000000aa03';
    const cheapBid = 'b0000000-0000-0000-0000-00000000aa03';

    await issueAndList('TP-WF-0002', 'INV-WF-0002', largeFace, largeMin, largeListing, 8802);
    await issueAndList('TP-WF-0003', 'INV-WF-0003', smallFace, smallPrice, smallListing, 8803);
    await mustPost(BANK_USER, {
      kind: 'place_bid',
      bidId: cheapBid,
      listingId: smallListing,
      bidderWallet: BANK,
      priceBase: smallPrice as never,
      fundingCode: 'USDC',
    });

    const sellerXusdBefore = await query<{ balance: bigint }>(
      `SELECT b.balance FROM ledger.account_balance b
         JOIN ledger.account a ON a.id = b.account_id
         JOIN ledger.asset s ON s.id = b.asset_id
        WHERE a.wallet_address = $1 AND s.cash_code = 'XUSD'`,
      [SUPP],
    );
    const before = sellerXusdBefore[0]?.balance ?? 0n;

    const result = await post({
      key: randomUUID(),
      actorUserId: SUPP_USER,
      intent: { kind: 'accept_bid', listingId: largeListing, bidId: cheapBid },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('listing_not_open');
      expect(result.error.detail).toBe('bid is not on this listing');
    }

    const listings = await query<{ id: string; status: string }>(
      'SELECT id::text AS id, status::text AS status FROM app.listing WHERE id = ANY($1::uuid[])',
      [[largeListing, smallListing]],
    );
    const byId = Object.fromEntries(listings.map((row) => [row.id, row.status]));
    expect(byId[largeListing]).toBe('open');
    expect(byId[smallListing]).toBe('open');

    const bid = await query<{ status: string }>('SELECT status::text AS status FROM app.bid WHERE id = $1', [
      cheapBid,
    ]);
    expect(bid[0]!.status).toBe('placed');

    const sellerXusdAfter = await query<{ balance: bigint }>(
      `SELECT b.balance FROM ledger.account_balance b
         JOIN ledger.account a ON a.id = b.account_id
         JOIN ledger.asset s ON s.id = b.asset_id
        WHERE a.wallet_address = $1 AND s.cash_code = 'XUSD'`,
      [SUPP],
    );
    expect(sellerXusdAfter[0]?.balance ?? 0n).toBe(before);

    const drift = await query<{ count: bigint }>('SELECT count(*)::bigint AS count FROM ledger.prove_books_balance()');
    expect(drift[0]!.count).toBe(0n);
  });
});
