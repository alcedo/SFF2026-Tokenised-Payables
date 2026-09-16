/**
 * The chain from TypeScript to the ledger and back.
 *
 * The SQL suites prove the ledger's own behaviour. This proves the boundary:
 * that a `bigint` survives the round trip as a `bigint`, that a refusal arrives
 * as a tagged code rather than an exception, and that the driver hands back
 * money already in the representation the rest of the system accepts.
 */

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePool, query } from '@/db/client';
import { ERROR_MESSAGE, post } from '@/db/post';
import { fromBaseUnits, formatUnits } from '@/core/money';

const SUPPLIER = '0x509911000000000000000000000000000000f88a';
const BANK = '0x1e4de40000000000000000000000000000004b13';
const PAYABLE = '9a000000-0000-0000-0000-000000000141';
const LISTING = '7a000000-0000-0000-0000-000000000001';
const BID = 'b0000000-0000-0000-0000-0000000000a1';
const SUPPLIER_USER = '11111111-0000-0000-0000-000000000003';
const LENDER_USER = '11111111-0000-0000-0000-000000000004';

const FACE = 2_500_000_000n; // 250,000.0000 XUSD
const PRICE = 2_446_250_000n; // 97.85% of face

/**
 * Its own database. vitest runs test files in parallel, so sharing one would
 * make every run a race between two resets.
 */
const DB_NAME = 'adata_test_post';

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

async function holdingOf(wallet: string): Promise<bigint> {
  const rows = await query<{ quantity_base: bigint }>(
    'SELECT quantity_base FROM ledger.v_holding WHERE wallet_address = $1',
    [wallet],
  );
  return rows[0]?.quantity_base ?? 0n;
}

describe('money crosses the driver boundary as bigint', () => {
  it('reads a holding back as a bigint, not a string or a number', async () => {
    const held = await holdingOf(SUPPLIER);
    expect(typeof held).toBe('bigint');
    expect(held).toBe(FACE);
  });

  it('formats a driver-supplied value through the same path as a literal', async () => {
    const held = await holdingOf(SUPPLIER);
    expect(formatUnits(fromBaseUnits(held), 2)).toBe('250,000.00');
  });

  it('reads an aggregate back as a bigint too', async () => {
    // SUM(bigint) is NUMERIC in Postgres, which is the likeliest place a float
    // would enter. The parser has to cover it as well as plain BIGINT columns.
    const rows = await query<{ total: bigint }>(
      'SELECT SUM(quantity_base) AS total FROM ledger.v_holding',
    );
    expect(typeof rows[0]!.total).toBe('bigint');
  });
});

describe('post returns a tagged result, never an exception', () => {
  it('publishes a listing and reports no receipt for an audit-only event', async () => {
    const result = await post({
      key: 'c1000000-0000-0000-0000-000000000001',
      actorUserId: SUPPLIER_USER,
      intent: {
        kind: 'publish_listing',
        listingId: LISTING,
        payableId: PAYABLE,
        sellerWallet: SUPPLIER,
        quantityBase: FACE as never,
        minPriceBase: PRICE as never,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // PRD §10: listing publication is an audit event with no chain receipt.
      expect(result.value.receipt).toBeNull();
      expect(result.value.replayed).toBe(false);
    }
  });

  it('refuses an over-quantity transfer with a usable code', async () => {
    const result = await post({
      key: 'c1000000-0000-0000-0000-000000000002',
      actorUserId: SUPPLIER_USER,
      intent: {
        kind: 'transfer',
        payableId: PAYABLE,
        fromWallet: SUPPLIER,
        toWallet: BANK,
        quantityBase: (FACE + 1n) as never,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('insufficient_quantity');
      expect(ERROR_MESSAGE[result.error.code]).toMatch(/listed quantity is locked/i);
    }
  });

  it('names an out-of-order lifecycle step and logs the refusal with its context', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await post({
      key: 'c1000000-0000-0000-0000-000000000011',
      actorUserId: SUPPLIER_USER,
      intent: { kind: 'approve', payableId: PAYABLE },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('illegal_transition');
      expect(result.error.detail).toMatch(/issued/);
    }
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[1]).toMatchObject({
      sqlstate: 'ADA01',
      code: 'illegal_transition',
      kind: 'approve',
      actor: SUPPLIER_USER,
    });
    errors.mockRestore();
  });

  it('tags a command the ledger does not recognise as internal, not unknown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await post({
      key: 'c1000000-0000-0000-0000-000000000012',
      actorUserId: SUPPLIER_USER,
      intent: { kind: 'nonsense' } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      expect(result.error.detail).toMatch(/nonsense/);
    }
    errors.mockRestore();
  });

  it('settles a trade and returns a simulated receipt with a conversion', async () => {
    await post({
      key: 'c1000000-0000-0000-0000-000000000003',
      actorUserId: LENDER_USER,
      intent: {
        kind: 'place_bid',
        bidId: BID,
        listingId: LISTING,
        bidderWallet: BANK,
        priceBase: PRICE as never,
        fundingCode: 'USDC',
      },
    });

    const result = await post({
      key: 'c1000000-0000-0000-0000-000000000004',
      actorUserId: SUPPLIER_USER,
      intent: { kind: 'accept_bid', listingId: LISTING, bidId: BID },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.receipt?.simulated).toBe(true);
      expect(result.value.receipt?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.value.conversion?.fundingAsset).toBe('USDC');
      // USDC funds XUSD 1:1, so the debit equals the obligation exactly.
      expect(result.value.conversion?.sourceDebit).toBe(PRICE);
      expect(typeof result.value.conversion?.sourceDebit).toBe('bigint');
    }

    expect(await holdingOf(BANK)).toBe(FACE);
    expect(await holdingOf(SUPPLIER)).toBe(0n);
  });

  it('returns the same receipt on a replay and pays nobody twice', async () => {
    const before = await query<{ balance: bigint }>(
      `SELECT b.balance FROM ledger.account_balance b
         JOIN ledger.account a ON a.id = b.account_id
         JOIN ledger.asset s ON s.id = b.asset_id
        WHERE a.wallet_address = $1 AND s.cash_code = 'XUSD'`,
      [SUPPLIER],
    );

    const replay = await post({
      key: 'c1000000-0000-0000-0000-000000000004',
      actorUserId: SUPPLIER_USER,
      intent: { kind: 'accept_bid', listingId: LISTING, bidId: BID },
    });

    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);

    const after = await query<{ balance: bigint }>(
      `SELECT b.balance FROM ledger.account_balance b
         JOIN ledger.account a ON a.id = b.account_id
         JOIN ledger.asset s ON s.id = b.asset_id
        WHERE a.wallet_address = $1 AND s.cash_code = 'XUSD'`,
      [SUPPLIER],
    );
    expect(after[0]!.balance).toBe(before[0]!.balance);
  });

  it('refuses a key reused for a different intent', async () => {
    const result = await post({
      key: 'c1000000-0000-0000-0000-000000000004',
      actorUserId: SUPPLIER_USER,
      intent: { kind: 'settle_maturity', payableId: PAYABLE, fundingCode: 'XUSD' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('key_reused');
  });
});

describe('the books stay provably consistent', () => {
  it('has no projection drift and conserves every asset', async () => {
    const drift = await query<{ count: bigint }>(
      'SELECT count(*)::bigint AS count FROM ledger.prove_books_balance()',
    );
    expect(drift[0]!.count).toBe(0n);

    const unconserved = await query<{ count: bigint }>(
      `SELECT count(*)::bigint AS count FROM (
         SELECT asset_id FROM ledger.account_balance GROUP BY asset_id HAVING SUM(balance) <> 0
       ) bad`,
    );
    expect(unconserved[0]!.count).toBe(0n);
  });
});
