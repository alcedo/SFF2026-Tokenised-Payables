import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, query } from '@/db/client';
import { post, type Intent } from '@/db/post';
import { allocateProRata, fromBaseUnits } from '@/core/money';

const DB_NAME = 'adata_test_workflow';

const PREP = '11111111-0000-0000-0000-000000000001';
const CHECKR = '11111111-0000-0000-0000-000000000002';
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

    await query(
      `INSERT INTO app.entity (id, name, entity_type, certification_status)
       VALUES ('e0000000-0000-0000-0000-0000000000aa', 'StraitsX', 'platform', 'certified')
       ON CONFLICT (id) DO NOTHING`,
    );
    await query(
      `INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
       VALUES ('11111111-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-0000000000aa',
               'Admin', 'straitsx_admin', true, false)
       ON CONFLICT (id) DO NOTHING`,
    );
    const ADMIN = '11111111-0000-0000-0000-000000000008';
    await mustPost(ADMIN, { kind: 'certify', payableId });
    await mustPost(PREP, {
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

    const trades = await query<{ quantity_base: bigint; price_base: bigint }>(
      'SELECT quantity_base, price_base FROM ledger.v_trade WHERE payable_id = $1',
      [payableId],
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.quantity_base).toBe(FACE);
    expect(trades[0]!.price_base).toBe(PRICE);

    const drift = await query<{ count: bigint }>('SELECT count(*)::bigint AS count FROM ledger.prove_books_balance()');
    expect(drift[0]!.count).toBe(0n);
  });
});

const FACE_A = 10_000_000n;
const FACE_B = 20_000_000n;
const LOT_PRICE = 10_000_001n;

async function ensureStraitsXAdmin() {
  await query(
    `INSERT INTO app.entity (id, name, entity_type, certification_status)
     VALUES ('e0000000-0000-0000-0000-0000000000aa', 'StraitsX', 'platform', 'certified')
     ON CONFLICT (id) DO NOTHING`,
  );
  await query(
    `INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
     VALUES ('11111111-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-0000000000aa',
             'Admin', 'straitsx_admin', true, false)
     ON CONFLICT (id) DO NOTHING`,
  );
  return '11111111-0000-0000-0000-000000000008';
}

async function issueAccepted(ref: string, invoiceRef: string, face: bigint, tokenId: number) {
  const admin = await ensureStraitsXAdmin();
  await mustPost(PREP, {
    kind: 'create_payable',
    ref,
    supplierId: SUPPLIER_ENTITY,
    invoiceRef,
    faceBase: face as never,
    termsDays: 60,
  });
  const payableId = (
    await query<{ id: string }>('SELECT id FROM app.payable WHERE ref = $1', [ref])
  )[0]!.id;
  await mustPost(PREP, { kind: 'submit', payableId });
  await mustPost(CHECKR, { kind: 'approve', payableId });
  await mustPost(PREP, {
    kind: 'grade',
    payableId,
    grade: 'AA',
    gradeRationale: 'Workflow coverage grade. Sample value.',
  });
  await mustPost(admin, { kind: 'certify', payableId });
  await mustPost(PREP, { kind: 'issue_payable', payableId, toWallet: SUPP, tokenId });
  await mustPost(SUPP_USER, { kind: 'accept_receipt', payableId });
  return payableId;
}

describe('series trade cost basis', () => {
  it('allocates the lot price across members so they sum to the cash paid', async () => {
    const payableA = await issueAccepted('TP-WF-S1', 'INV-WF-S1', FACE_A, 8802);
    const payableB = await issueAccepted('TP-WF-S2', 'INV-WF-S2', FACE_B, 8803);

    const bundled = await query<{ id: string; maturity_date: Date; anchor_id: string }>(
      'SELECT id, maturity_date, anchor_id FROM app.payable WHERE id = $1',
      [payableA],
    );
    const seriesId = '5e000000-0000-0000-0000-00000000aa01';
    await query(
      `INSERT INTO app.series (id, ref, anchor_id, maturity_date, grade)
       VALUES ($1, 'SERIES-WF-1', $2, $3, 'AA')`,
      [seriesId, bundled[0]!.anchor_id, bundled[0]!.maturity_date],
    );
    await query('UPDATE app.payable SET series_id = $1 WHERE id = ANY($2::uuid[])', [
      seriesId,
      [payableA, payableB],
    ]);

    const listingId = '7a000000-0000-0000-0000-00000000aa02';
    await mustPost(SUPP_USER, {
      kind: 'publish_listing',
      listingId,
      seriesId,
      sellerWallet: SUPP,
      minPriceBase: LOT_PRICE as never,
    } as unknown as Intent);

    await mustPost(BANK_USER, {
      kind: 'place_bid',
      bidId: 'b0000000-0000-0000-0000-00000000aa02',
      listingId,
      bidderWallet: BANK,
      priceBase: LOT_PRICE as never,
      fundingCode: 'USDC',
    });
    await mustPost(SUPP_USER, {
      kind: 'accept_bid',
      listingId,
      bidId: 'b0000000-0000-0000-0000-00000000aa02',
    });

    const trades = await query<{ payable_id: string; quantity_base: bigint; price_base: bigint }>(
      `SELECT payable_id, quantity_base, price_base
         FROM ledger.v_trade
        WHERE listing_id = $1
        ORDER BY payable_id`,
      [listingId],
    );
    expect(trades).toHaveLength(2);
    const expected = allocateProRata(
      fromBaseUnits(LOT_PRICE),
      trades.map((t) => fromBaseUnits(t.quantity_base)),
    );
    expect(trades.map((t) => t.price_base)).toEqual(expected);
    expect(trades.reduce((acc, t) => acc + t.price_base, 0n)).toBe(LOT_PRICE);
    expect(trades.every((t) => t.price_base !== LOT_PRICE)).toBe(true);
  });
});
