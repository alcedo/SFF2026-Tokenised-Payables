/**
 * Concurrency and fault injection against ledger.post().
 *
 * tests/ledger/concurrency.sh already drives one race, two lenders accepting
 * the same listing, on a fixed sleep. Everything here is a race it does not
 * cover, and nothing here is timed. Where an ordering is the point, one client
 * takes the lock and the second is observed parked on it through
 * pg_stat_activity and pg_blocking_pids before the first is released, so the
 * interleaving is a fact rather than a hope. Where a genuine race is the point,
 * N clients go through Promise.all and the assertion is the invariant, not the
 * winner.
 *
 * The oracle is the same in every case: whatever happened, a refusal, a
 * deadlock, a cancelled statement or a killed backend, ledgerHealth() must come
 * back HEALTHY.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  HEALTHY,
  actors,
  freshDatabase,
  idempotencyKey,
  ledgerHealth,
  openPool,
  post,
  type Database,
  type PostErr,
  type PostResult,
  type Role,
} from '../support/database';

const FACE = 2_500_000_000;
const PRICE = 2_446_250_000;
const TERMS_DAYS = 30;

// --- scaffolding ------------------------------------------------------------

const openDatabases: Database[] = [];
const openPools: Pool[] = [];

afterAll(async () => {
  await Promise.all(openPools.map((p) => p.end().catch(() => {})));
  await Promise.all(openDatabases.map((d) => d.close()));
});

interface Party {
  entityId: string;
  name: string;
  wallet: string;
  userId: string;
}

interface Stage {
  db: Database;
  pool: Pool;
  users: Record<Role, string>;
  anchor: Party;
  suppliers: Party[];
  lenders: Party[];
}

/**
 * A database, and a pool wide enough for the clients a scenario holds open at
 * once. `freshDatabase` caps its own pool at four, which several of these
 * scenarios exceed.
 */
async function stage(name: string): Promise<Stage> {
  const db = await freshDatabase(name, 'fixtures');
  openDatabases.push(db);
  const pool = openPool(db.name, 12);
  openPools.push(pool);

  const byRole = await actors(pool);
  const users = {} as Record<Role, string>;
  for (const role of Object.keys(byRole) as Role[]) {
    const id = byRole[role];
    if (!id) throw new Error(`the fixtures template has no live ${role}`);
    users[role] = id;
  }

  const { rows } = await pool.query<{
    entity_id: string;
    name: string;
    entity_type: string;
    address: string;
    user_id: string;
  }>(`
    SELECT e.id::text AS entity_id, e.name, e.entity_type::text AS entity_type,
           w.address, u.id::text AS user_id
      FROM app.entity e
      JOIN LATERAL (SELECT address FROM app.wallet
                     WHERE entity_id = e.id ORDER BY address LIMIT 1) w ON true
      JOIN LATERAL (SELECT id FROM app.app_user
                     WHERE entity_id = e.id AND deactivated_at IS NULL
                     ORDER BY id LIMIT 1) u ON true
     ORDER BY e.name`);

  const of = (kind: string): Party[] =>
    rows
      .filter((r) => r.entity_type === kind)
      .map((r) => ({ entityId: r.entity_id, name: r.name, wallet: r.address, userId: r.user_id }));

  const anchor = of('anchor')[0];
  if (!anchor) throw new Error('the fixtures template has no anchor with a wallet');
  return { db, pool, users, anchor, suppliers: of('supplier'), lenders: of('lender') };
}

function must(result: PostResult, what: string): Record<string, unknown> {
  if (!result.ok) throw new Error(`${what} was refused: ${result.code} ${result.message}`);
  return result.receipt;
}

function refused(result: PostResult): PostErr {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.receipt)}`);
  return result;
}

async function withClients<T>(
  pool: Pool,
  count: number,
  body: (clients: PoolClient[]) => Promise<T>,
): Promise<T> {
  const clients: PoolClient[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const client = await pool.connect();
      // A scenario that kills a backend would otherwise surface as an
      // unhandled 'error' event and take the whole worker down.
      client.on('error', () => {});
      clients.push(client);
    }
    return await body(clients);
  } finally {
    for (const client of clients) client.release(true);
  }
}

interface PayableSpec {
  supplier: Party;
  toWallet: string;
  ref: string;
  invoiceRef: string;
  faceBase?: number;
  termsDays?: number;
  tokenId: number;
}

interface IssuedPayable {
  id: string;
  assetId: string;
  faceBase: number;
  maturityDate: string;
}

/** A payable walked from draft to issued and accepted, through ledger.post() only. */
async function issuePayable(s: Stage, spec: PayableSpec): Promise<IssuedPayable> {
  const faceBase = spec.faceBase ?? FACE;
  const termsDays = spec.termsDays ?? TERMS_DAYS;
  const as = (role: Role) => ({ actorUserId: s.users[role] });

  // No payableId is supplied. The idempotency gate writes the intent's
  // payableId onto the journal entry before the branch creates the row, so a
  // caller-chosen id fails the entry's foreign key. See the findings file.
  const created = must(
    await post(
      s.pool,
      {
        kind: 'create_payable',
        ref: spec.ref,
        supplierId: spec.supplier.entityId,
        invoiceRef: spec.invoiceRef,
        faceBase,
        termsDays,
      },
      as('adata_preparer'),
    ),
    'create_payable',
  );
  const drafted = await s.pool.query<{ payable_id: string }>(
    'SELECT payable_id::text FROM ledger.journal_entry WHERE id = $1',
    [created.entryId],
  );
  const id = drafted.rows[0]?.payable_id;
  if (!id) throw new Error('create_payable recorded no payable on its journal entry');
  must(await post(s.pool, { kind: 'submit', payableId: id }, as('adata_preparer')), 'submit');
  must(await post(s.pool, { kind: 'approve', payableId: id }, as('adata_checker')), 'approve');
  must(
    await post(
      s.pool,
      { kind: 'grade', payableId: id, grade: 'AA', gradeRationale: 'Sample grade for a test world.' },
      as('straitsx_admin'),
    ),
    'grade',
  );
  must(await post(s.pool, { kind: 'certify', payableId: id }, as('straitsx_admin')), 'certify');
  must(
    await post(
      s.pool,
      { kind: 'issue_payable', payableId: id, toWallet: spec.toWallet, tokenId: spec.tokenId },
      as('straitsx_admin'),
    ),
    'issue_payable',
  );
  must(await post(s.pool, { kind: 'accept_receipt', payableId: id }, as('supplier')), 'accept_receipt');

  const { rows } = await s.pool.query<{ asset_id: string; maturity_date: string }>(
    `SELECT a.id::text AS asset_id, to_char(p.maturity_date, 'YYYY-MM-DD') AS maturity_date
       FROM app.payable p JOIN ledger.asset a ON a.payable_id = p.id
      WHERE p.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error('issuance minted no asset for the payable');
  return { id, assetId: row.asset_id, faceBase, maturityDate: row.maturity_date };
}

// --- reading the books ------------------------------------------------------

async function tokenBalance(
  ex: Pool | PoolClient,
  wallet: string,
  purpose: 'wallet_free' | 'wallet_listed',
  assetId: string,
): Promise<bigint> {
  const { rows } = await ex.query<{ balance: bigint }>(
    `SELECT b.balance FROM ledger.account_balance b
       JOIN ledger.account a ON a.id = b.account_id
      WHERE a.wallet_address = $1 AND a.purpose = $2::ledger.account_purpose
        AND b.asset_id = $3`,
    [wallet, purpose, assetId],
  );
  return rows[0]?.balance ?? 0n;
}

async function cashBalance(ex: Pool | PoolClient, wallet: string, code: string): Promise<bigint> {
  const { rows } = await ex.query<{ balance: bigint }>(
    `SELECT b.balance FROM ledger.account_balance b
       JOIN ledger.account a ON a.id = b.account_id
       JOIN ledger.asset s ON s.id = b.asset_id
      WHERE a.wallet_address = $1 AND a.purpose = 'wallet_free'
        AND s.cash_code = $2::ledger.cash_code`,
    [wallet, code],
  );
  return rows[0]?.balance ?? 0n;
}

async function countOf(ex: Pool | PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await ex.query<{ n: bigint }>(sql, params);
  return Number(rows[0]?.n ?? 0n);
}

async function entriesWithKey(ex: Pool | PoolClient, key: string): Promise<number> {
  return countOf(ex, 'SELECT count(*) AS n FROM ledger.journal_entry WHERE idempotency_key = $1', [key]);
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

/**
 * Wait for a backend to be parked on a lock.
 *
 * This is what replaces a sleep. The scenarios below need "the second session
 * is now inside post() and blocked" to be true before they release the first
 * session, and that is a condition to poll, not a duration to guess.
 */
async function waitUntilBlocked(pool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows } = await pool.query<{ state: string | null; wait_event_type: string | null }>(
      'SELECT state, wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    const row = rows[0];
    if (row?.state === 'active' && row.wait_event_type === 'Lock') return;
    if (Date.now() > deadline) {
      throw new Error(`backend ${pid} never blocked on a lock (state ${row?.state ?? 'gone'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Wait for a backend to be gone.
 *
 * pg_terminate_backend signals and returns; the row in pg_stat_activity
 * survives until the backend actually exits, so asserting straight after the
 * call would be asserting a race.
 */
async function waitUntilGone(pool: Pool, pid: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const live = await countOf(pool, 'SELECT count(*) AS n FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (live === 0) return live;
    if (Date.now() > deadline) return live;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Who a parked backend is waiting for, which is how a lock order is evidenced. */
async function blockingPids(pool: Pool, pid: number): Promise<number[]> {
  const { rows } = await pool.query<{ blockers: number[] }>(
    'SELECT pg_blocking_pids($1) AS blockers',
    [pid],
  );
  return rows[0]?.blockers ?? [];
}

// --- 1. lock-order inversion ------------------------------------------------

describe('lock-order inversion between settle_maturity and accept_bid', () => {
  it('deadlocks ABBA, names one victim with 40P01, and settles the other side', async () => {
    const s = await stage('abba');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-ABBA-0001',
      invoiceRef: 'INV-ABBA-0001',
      tokenId: 9001,
    });

    const listingId = randomUUID();
    const bidId = randomUUID();
    must(
      await post(
        s.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId: payable.id,
          sellerWallet: supplier.wallet,
          quantityBase: FACE,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(
        s.pool,
        {
          kind: 'place_bid',
          bidId,
          listingId,
          bidderWallet: lender.wallet,
          priceBase: PRICE,
          fundingCode: 'XUSD',
        },
        { actorUserId: s.users.lender },
      ),
      'place_bid',
    );
    must(
      await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
      'advance_clock',
    );

    await withClients(s.pool, 2, async ([settler, accepter]) => {
      // settle_maturity takes app.payable then app.listing; accept_bid takes
      // app.listing then app.payable. Each session is given the first lock of
      // its own path by hand, so the cycle is closed by construction rather
      // than by timing. deadlock_timeout chooses the victim, because the
      // backend whose timer expires first runs the detector and aborts itself.
      await settler!.query('BEGIN');
      await settler!.query("SET LOCAL deadlock_timeout = '5s'");
      await settler!.query('SELECT 1 FROM app.payable WHERE id = $1 FOR NO KEY UPDATE', [payable.id]);

      await accepter!.query('BEGIN');
      await accepter!.query("SET LOCAL deadlock_timeout = '40ms'");
      await accepter!.query('SELECT 1 FROM app.listing WHERE id = $1 FOR UPDATE', [listingId]);

      const settling = post(
        settler!,
        { kind: 'settle_maturity', payableId: payable.id, fundingCode: 'XUSD' },
        { actorUserId: s.users.adata_preparer },
      );
      const accepting = post(
        accepter!,
        { kind: 'accept_bid', listingId, bidId },
        { actorUserId: s.users.supplier },
      );
      const [settled, accepted] = await Promise.all([settling, accepting]);

      const victim = refused(accepted);
      expect(victim.code).toBe('40P01');
      expect(victim.message).toContain('deadlock detected');
      expect(settled.ok).toBe(true);

      await settler!.query('COMMIT');
      await accepter!.query('ROLLBACK');
    });

    const { rows } = await s.pool.query<{ lifecycle: string; listing: string; bid: string }>(
      `SELECT p.lifecycle_status::text AS lifecycle, l.status::text AS listing, b.status::text AS bid
         FROM app.payable p, app.listing l, app.bid b
        WHERE p.id = $1 AND l.id = $2 AND b.id = $3`,
      [payable.id, listingId, bidId],
    );
    expect(rows[0]).toEqual({ lifecycle: 'settled', listing: 'cancelled', bid: 'superseded' });
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(0n);
    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('refuses the acceptance with ADA12 when the deadlock victim is the settlement', async () => {
    const s = await stage('abba_flip');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-ABBA-0002',
      invoiceRef: 'INV-ABBA-0002',
      tokenId: 9002,
    });

    const listingId = randomUUID();
    const bidId = randomUUID();
    must(
      await post(
        s.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId: payable.id,
          sellerWallet: supplier.wallet,
          quantityBase: FACE,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(
        s.pool,
        {
          kind: 'place_bid',
          bidId,
          listingId,
          bidderWallet: lender.wallet,
          priceBase: PRICE,
          fundingCode: 'XUSD',
        },
        { actorUserId: s.users.lender },
      ),
      'place_bid',
    );
    must(
      await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
      'advance_clock',
    );

    await withClients(s.pool, 2, async ([settler, accepter]) => {
      await settler!.query('BEGIN');
      await settler!.query("SET LOCAL deadlock_timeout = '40ms'");
      await settler!.query('SELECT 1 FROM app.payable WHERE id = $1 FOR NO KEY UPDATE', [payable.id]);

      await accepter!.query('BEGIN');
      await accepter!.query("SET LOCAL deadlock_timeout = '5s'");
      await accepter!.query('SELECT 1 FROM app.listing WHERE id = $1 FOR UPDATE', [listingId]);

      const settling = post(
        settler!,
        { kind: 'settle_maturity', payableId: payable.id, fundingCode: 'XUSD' },
        { actorUserId: s.users.adata_preparer },
      );
      const accepting = post(
        accepter!,
        { kind: 'accept_bid', listingId, bidId },
        { actorUserId: s.users.supplier },
      );
      const [settled, accepted] = await Promise.all([settling, accepting]);

      expect(refused(settled).code).toBe('40P01');
      // The survivor finishes its own lock order and then meets the maturity
      // check it was blocked ahead of, so the loser of the race still gets a
      // sentence a presenter can read out.
      expect(refused(accepted).code).toBe('ADA12');
      expect(refused(accepted).message).toContain('has reached maturity');

      await settler!.query('ROLLBACK');
      await accepter!.query('ROLLBACK');
    });

    const { rows } = await s.pool.query<{ lifecycle: string; listing: string; bid: string }>(
      `SELECT p.lifecycle_status::text AS lifecycle, l.status::text AS listing, b.status::text AS bid
         FROM app.payable p, app.listing l, app.bid b
        WHERE p.id = $1 AND l.id = $2 AND b.id = $3`,
      [payable.id, listingId, bidId],
    );
    expect(rows[0]).toEqual({ lifecycle: 'issued', listing: 'open', bid: 'placed' });
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- 2. the unlocked holder read --------------------------------------------

describe('settle_maturity reads holder balances without a lock', () => {
  it('parks on the payable row alone, before the holder loop runs', async () => {
    const s = await stage('holder_lock');
    const supplier = s.suppliers[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-READ-0001',
      invoiceRef: 'INV-READ-0001',
      tokenId: 9010,
    });
    must(
      await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
      'advance_clock',
    );

    await withClients(s.pool, 2, async ([holder, settler]) => {
      // The holder session takes the payable row and nothing else: no balance
      // row, no listing. Whatever the settlement then waits for can only be
      // that row, which is the lock the unlocked holder loop relies on.
      const holderPid = await backendPid(holder!);
      await holder!.query('BEGIN');
      await holder!.query('SELECT 1 FROM app.payable WHERE id = $1 FOR NO KEY UPDATE', [payable.id]);

      const settlerPid = await backendPid(settler!);
      const settling = post(
        settler!,
        { kind: 'settle_maturity', payableId: payable.id, fundingCode: 'XUSD' },
        { actorUserId: s.users.adata_preparer },
      );
      await waitUntilBlocked(s.pool, settlerPid);
      expect(await blockingPids(s.pool, settlerPid)).toEqual([holderPid]);

      await holder!.query('ROLLBACK');
      expect((await settling).ok).toBe(true);
    });

    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('pays the holders an interleaved transfer left behind, not the ones it read', async () => {
    const s = await stage('holder_read');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-READ-0002',
      invoiceRef: 'INV-READ-0002',
      tokenId: 9011,
    });
    const half = FACE / 2;
    const lenderCashBefore = await cashBalance(s.pool, lender.wallet, 'XUSD');

    await withClients(s.pool, 2, async ([mover, settler]) => {
      const moverPid = await backendPid(mover!);
      await mover!.query('BEGIN');
      must(
        await post(
          mover!,
          {
            kind: 'transfer',
            payableId: payable.id,
            fromWallet: supplier.wallet,
            toWallet: lender.wallet,
            quantityBase: half,
          },
          { actorUserId: s.users.supplier },
        ),
        'transfer',
      );

      must(
        await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
        'advance_clock',
      );

      const settlerPid = await backendPid(settler!);
      const settling = post(
        settler!,
        { kind: 'settle_maturity', payableId: payable.id, fundingCode: 'XUSD' },
        { actorUserId: s.users.adata_preparer },
      );
      await waitUntilBlocked(s.pool, settlerPid);
      expect(await blockingPids(s.pool, settlerPid)).toEqual([moverPid]);

      await mover!.query('COMMIT');
      expect((await settling).ok).toBe(true);
    });

    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_free', payable.assetId)).toBe(0n);
    expect(await tokenBalance(s.pool, lender.wallet, 'wallet_free', payable.assetId)).toBe(0n);
    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(BigInt(half));
    expect(await cashBalance(s.pool, lender.wallet, 'XUSD')).toBe(lenderCashBefore + BigInt(half));

    const { rows } = await s.pool.query<{ outstanding: bigint }>(
      'SELECT outstanding_base AS outstanding FROM ledger.v_payable_supply WHERE payable_id = $1',
      [payable.id],
    );
    expect(rows[0]!.outstanding).toBe(0n);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- 3. over-committing one holding -----------------------------------------

describe('over-committing one holding', () => {
  it('escrows the holding once when N publishes race for it', async () => {
    const s = await stage('overcommit_race');
    const supplier = s.suppliers[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-ESC-0001',
      invoiceRef: 'INV-ESC-0001',
      tokenId: 9020,
    });

    const attempts = 4;
    const results = await withClients(s.pool, attempts, (clients) =>
      Promise.all(
        clients.map((client) =>
          post(
            client,
            {
              kind: 'publish_listing',
              listingId: randomUUID(),
              payableId: payable.id,
              sellerWallet: supplier.wallet,
              quantityBase: FACE,
              minPriceBase: PRICE,
            },
            { actorUserId: s.users.supplier },
          ),
        ),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r): r is PostErr => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(attempts - 1);
    for (const loser of losers) {
      expect(loser.code).toBe('23505');
      expect(loser.message).toContain('one_open_listing_per_seller_target');
    }

    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(BigInt(FACE));
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_free', payable.assetId)).toBe(0n);
    expect(await countOf(s.pool, "SELECT count(*) AS n FROM app.listing WHERE status = 'open'")).toBe(1);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('refuses a publish that would escrow a holding a committed transfer has taken', async () => {
    const s = await stage('overcommit_transfer');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-ESC-0002',
      invoiceRef: 'INV-ESC-0002',
      tokenId: 9021,
    });

    await withClients(s.pool, 2, async ([mover, lister]) => {
      const moverPid = await backendPid(mover!);
      await mover!.query('BEGIN');
      must(
        await post(
          mover!,
          {
            kind: 'transfer',
            payableId: payable.id,
            fromWallet: supplier.wallet,
            toWallet: lender.wallet,
            quantityBase: FACE,
          },
          { actorUserId: s.users.supplier },
        ),
        'transfer',
      );

      const listerPid = await backendPid(lister!);
      const listing = post(
        lister!,
        {
          kind: 'publish_listing',
          listingId: randomUUID(),
          payableId: payable.id,
          sellerWallet: supplier.wallet,
          quantityBase: FACE,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      );
      await waitUntilBlocked(s.pool, listerPid);
      expect(await blockingPids(s.pool, listerPid)).toEqual([moverPid]);

      await mover!.query('COMMIT');

      const published = refused(await listing);
      expect(published.code).toBe('ADA21');
      expect(published.message).toBe(
        `wallet ${supplier.wallet} holds 0 unlisted, needs ${FACE}`,
      );
    });

    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(0n);
    expect(await tokenBalance(s.pool, lender.wallet, 'wallet_free', payable.assetId)).toBe(BigInt(FACE));
    expect(await countOf(s.pool, 'SELECT count(*) AS n FROM app.listing')).toBe(0);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- 4. select-or-insert races ----------------------------------------------

describe('select-or-insert races on accounts', () => {
  it('creates one wallet account when N first-ever top-ups race for it', async () => {
    const s = await stage('account_race');
    const name = 'Aurora Bridge Capital';
    must(
      await post(
        s.pool,
        { kind: 'onboard_entity', name, entityType: 'lender', userName: 'A. Nakamura', role: 'lender' },
        { actorUserId: s.users.straitsx_admin },
      ),
      'onboard_entity',
    );
    const { rows } = await s.pool.query<{ address: string }>(
      'SELECT w.address FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id WHERE lower(e.name) = lower($1)',
      [name],
    );
    const wallet = rows[0]!.address;
    expect(
      await countOf(s.pool, 'SELECT count(*) AS n FROM ledger.account WHERE wallet_address = $1', [wallet]),
    ).toBe(0);

    const amount = 1_000_000;
    const attempts = 6;
    const results = await withClients(s.pool, attempts, (clients) =>
      Promise.all(
        clients.map((client) =>
          post(
            client,
            { kind: 'top_up', wallet, cashCode: 'USDC', amountBase: amount },
            { actorUserId: s.users.straitsx_admin },
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(attempts);
    expect(
      await countOf(
        s.pool,
        "SELECT count(*) AS n FROM ledger.account WHERE wallet_address = $1 AND purpose = 'wallet_free'",
        [wallet],
      ),
    ).toBe(1);
    expect(await cashBalance(s.pool, wallet, 'USDC')).toBe(BigInt(amount * attempts));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('creates one system_fx account when two first-ever funded trades race for it', async () => {
    const s = await stage('system_fx_race');
    const supplier = s.suppliers[0]!;
    const lenderA = s.lenders[0]!;
    const lenderB = s.lenders[1]!;
    expect(
      await countOf(s.pool, "SELECT count(*) AS n FROM ledger.account WHERE purpose = 'system_fx'"),
    ).toBe(0);

    const lots = await Promise.all(
      [0, 1].map((i) =>
        issuePayable(s, {
          supplier,
          toWallet: supplier.wallet,
          ref: `TP-FX-000${i}`,
          invoiceRef: `INV-FX-000${i}`,
          tokenId: 9030 + i,
        }),
      ),
    );

    const deals = await Promise.all(
      lots.map(async (lot, i) => {
        const listingId = randomUUID();
        const bidId = randomUUID();
        must(
          await post(
            s.pool,
            {
              kind: 'publish_listing',
              listingId,
              payableId: lot.id,
              sellerWallet: supplier.wallet,
              quantityBase: FACE,
              minPriceBase: PRICE,
            },
            { actorUserId: s.users.supplier },
          ),
          'publish_listing',
        );
        must(
          await post(
            s.pool,
            {
              kind: 'place_bid',
              bidId,
              listingId,
              bidderWallet: i === 0 ? lenderA.wallet : lenderB.wallet,
              priceBase: PRICE,
              fundingCode: 'USDC',
            },
            { actorUserId: s.users.lender },
          ),
          'place_bid',
        );
        return { listingId, bidId };
      }),
    );

    const results = await withClients(s.pool, deals.length, (clients) =>
      Promise.all(
        deals.map((deal, i) =>
          post(
            clients[i]!,
            { kind: 'accept_bid', listingId: deal.listingId, bidId: deal.bidId },
            { actorUserId: s.users.supplier },
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(deals.length);
    expect(
      await countOf(s.pool, "SELECT count(*) AS n FROM ledger.account WHERE purpose = 'system_fx'"),
    ).toBe(1);
    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(BigInt(PRICE * 2));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- 5. concurrent idempotent replay ----------------------------------------

describe('concurrent idempotent replay', () => {
  it('collapses N simultaneous copies of one command into one journal entry', async () => {
    const s = await stage('replay_race');
    const lender = s.lenders[0]!;
    const before = await cashBalance(s.pool, lender.wallet, 'USDT');

    const key = idempotencyKey();
    const amount = 7_777_000;
    const attempts = 6;
    const results = await withClients(s.pool, attempts, (clients) =>
      Promise.all(
        clients.map((client) =>
          post(
            client,
            { kind: 'top_up', wallet: lender.wallet, cashCode: 'USDT', amountBase: amount },
            { actorUserId: s.users.straitsx_admin, key },
          ),
        ),
      ),
    );

    for (const result of results) expect(result.ok).toBe(true);
    const receipts = results.map((r) => (r.ok ? r.receipt : {}));
    const entryIds = new Set(receipts.map((r) => r.entryId as string));
    expect(entryIds.size).toBe(1);
    expect(receipts.filter((r) => r.replayed === false)).toHaveLength(1);
    expect(receipts.filter((r) => r.replayed === true)).toHaveLength(attempts - 1);

    const txHashes = new Set(
      receipts.map((r) => (r.receipt as { txHash?: string } | null)?.txHash ?? null),
    );
    expect(txHashes.size).toBe(1);

    expect(await entriesWithKey(s.pool, key)).toBe(1);
    expect(await cashBalance(s.pool, lender.wallet, 'USDT')).toBe(before + BigInt(amount));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('refuses a concurrent replay that reuses the key for a different intent', async () => {
    const s = await stage('replay_fingerprint');
    const lender = s.lenders[0]!;
    const key = idempotencyKey();

    const results = await withClients(s.pool, 4, (clients) =>
      Promise.all(
        clients.map((client, i) =>
          post(
            client,
            { kind: 'top_up', wallet: lender.wallet, cashCode: 'XSGD', amountBase: 1_000_000 + i },
            { actorUserId: s.users.straitsx_admin, key },
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const result of results.filter((r): r is PostErr => !r.ok)) {
      expect(result.code).toBe('ADA10');
      expect(result.message).toBe('idempotency key reused with a different intent');
    }
    expect(await entriesWithKey(s.pool, key)).toBe(1);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- 6. the clock moving under a trade --------------------------------------

describe('advance_clock against a trade', () => {
  it('settles a trade whose world row is advanced past maturity underneath it', async () => {
    const s = await stage('clock_under_trade');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-CLOCK-0001',
      invoiceRef: 'INV-CLOCK-0001',
      tokenId: 9040,
    });

    const listingId = randomUUID();
    const bidId = randomUUID();
    must(
      await post(
        s.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId: payable.id,
          sellerWallet: supplier.wallet,
          quantityBase: FACE,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(
        s.pool,
        { kind: 'place_bid', bidId, listingId, bidderWallet: lender.wallet, priceBase: PRICE, fundingCode: 'XUSD' },
        { actorUserId: s.users.lender },
      ),
      'place_bid',
    );

    // schema.sql section 6 says the world row is deliberately not locked and
    // both orderings are legal. This pins the ordering the clock loses: the
    // acceptance read the world before the advance committed, so a lot trades
    // on a payable that is matured by the time the trade lands.
    await withClients(s.pool, 1, async ([ticker]) => {
      await ticker!.query('BEGIN');
      must(
        await post(ticker!, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
        'advance_clock',
      );
      const accepted = await post(
        s.pool,
        { kind: 'accept_bid', listingId, bidId },
        { actorUserId: s.users.supplier },
      );
      expect(accepted.ok).toBe(true);
      await ticker!.query('COMMIT');
    });

    const { rows } = await s.pool.query<{ matured: boolean }>(
      `SELECT (w.t0 + w.offset_days) >= p.maturity_date AS matured
         FROM app.world w, app.payable p WHERE w.only_row AND p.id = $1`,
      [payable.id],
    );
    expect(rows[0]!.matured).toBe(true);
    expect(await tokenBalance(s.pool, lender.wallet, 'wallet_free', payable.assetId)).toBe(BigInt(FACE));
    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(BigInt(PRICE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('balances the books under either interleaving when the two race', async () => {
    const s = await stage('clock_race');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-CLOCK-0002',
      invoiceRef: 'INV-CLOCK-0002',
      tokenId: 9041,
    });

    const listingId = randomUUID();
    const bidId = randomUUID();
    must(
      await post(
        s.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId: payable.id,
          sellerWallet: supplier.wallet,
          quantityBase: FACE,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(
        s.pool,
        { kind: 'place_bid', bidId, listingId, bidderWallet: lender.wallet, priceBase: PRICE, fundingCode: 'XUSD' },
        { actorUserId: s.users.lender },
      ),
      'place_bid',
    );

    const [ticked, accepted] = await withClients(s.pool, 2, ([ticker, accepter]) =>
      Promise.all([
        post(ticker!, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
        post(accepter!, { kind: 'accept_bid', listingId, bidId }, { actorUserId: s.users.supplier }),
      ]),
    );

    expect(ticked.ok).toBe(true);
    if (accepted.ok) {
      expect(await tokenBalance(s.pool, lender.wallet, 'wallet_free', payable.assetId)).toBe(BigInt(FACE));
      expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(BigInt(PRICE));
      expect(await countOf(s.pool, "SELECT count(*) AS n FROM app.listing WHERE status = 'filled'")).toBe(1);
    } else {
      expect(accepted.code).toBe('ADA12');
      expect(accepted.message).toContain('has reached maturity');
      expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(BigInt(FACE));
      expect(await countOf(s.pool, "SELECT count(*) AS n FROM app.listing WHERE status = 'open'")).toBe(1);
    }
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- 7. over-withdrawal -----------------------------------------------------

describe('over-withdrawal under concurrency', () => {
  it('lets exactly as many token transfers through as the holding covers', async () => {
    const s = await stage('overdraw_token');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-OVER-0001',
      invoiceRef: 'INV-OVER-0001',
      tokenId: 9050,
    });

    const slice = FACE / 2;
    const attempts = 5;
    const results = await withClients(s.pool, attempts, (clients) =>
      Promise.all(
        clients.map((client) =>
          post(
            client,
            {
              kind: 'transfer',
              payableId: payable.id,
              fromWallet: supplier.wallet,
              toWallet: lender.wallet,
              quantityBase: slice,
            },
            { actorUserId: s.users.supplier },
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(2);
    for (const result of results.filter((r): r is PostErr => !r.ok)) {
      expect(result.code).toBe('ADA21');
      expect(result.message).toBe(`wallet ${supplier.wallet} holds 0 unlisted, needs ${slice}`);
    }
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_free', payable.assetId)).toBe(0n);
    expect(await tokenBalance(s.pool, lender.wallet, 'wallet_free', payable.assetId)).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('lets exactly as many buy-nows through as the wallet can fund', async () => {
    const s = await stage('overdraw_cash');
    const supplier = s.suppliers[0]!;
    const buyer = s.lenders[0]!;
    const funds = await cashBalance(s.pool, buyer.wallet, 'XUSD');
    const price = funds / 2n;
    const shortfall = price * 3n - funds;

    const listings = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const lot = await issuePayable(s, {
          supplier,
          toWallet: supplier.wallet,
          ref: `TP-CASH-000${i}`,
          invoiceRef: `INV-CASH-000${i}`,
          faceBase: 100_000_000,
          tokenId: 9060 + i,
        });
        const listingId = randomUUID();
        must(
          await post(
            s.pool,
            {
              kind: 'publish_listing',
              listingId,
              payableId: lot.id,
              sellerWallet: supplier.wallet,
              quantityBase: lot.faceBase,
              minPriceBase: Number(price),
              buyNowPriceBase: Number(price),
            },
            { actorUserId: s.users.supplier },
          ),
          'publish_listing',
        );
        return listingId;
      }),
    );

    const results = await withClients(s.pool, listings.length, (clients) =>
      Promise.all(
        listings.map((listingId, i) =>
          post(
            clients[i]!,
            { kind: 'buy_now', listingId, buyerWallet: buyer.wallet, fundingCode: 'XUSD' },
            { actorUserId: s.users.lender },
          ),
        ),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(2);
    for (const result of results.filter((r): r is PostErr => !r.ok)) {
      expect(result.code).toBe('ADA20');
      expect(result.message).toBe(`wallet ${buyer.wallet} is short ${shortfall} of the funding asset`);
    }
    expect(await cashBalance(s.pool, buyer.wallet, 'XUSD')).toBe(funds - price * 2n);
    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(price * 2n);
    expect(
      await countOf(s.pool, 'SELECT count(*) AS n FROM ledger.account_balance WHERE balance < 0 AND class = $1', [
        'wallet',
      ]),
    ).toBe(0);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

// --- fault injection --------------------------------------------------------

describe('fault injection', () => {
  it('rolls a killed backend back whole', async () => {
    const s = await stage('killed_backend');
    const lender = s.lenders[0]!;
    const before = await cashBalance(s.pool, lender.wallet, 'USDC');
    const key = idempotencyKey();

    const pid = await withClients(s.pool, 1, async ([doomed]) => {
      const backend = await backendPid(doomed!);
      const fatal = new Promise<{ code?: string; message?: string }>((resolve) => {
        doomed!.on('error', resolve);
      });
      await doomed!.query('BEGIN');
      must(
        await post(
          doomed!,
          { kind: 'top_up', wallet: lender.wallet, cashCode: 'USDC', amountBase: 5_000_000 },
          { actorUserId: s.users.straitsx_admin, key },
        ),
        'top_up',
      );
      // The uncommitted write is real inside its own transaction, which is what
      // makes the rollback below worth asserting.
      expect(await cashBalance(doomed!, lender.wallet, 'USDC')).toBe(before + 5_000_000n);

      const { rows } = await s.pool.query<{ killed: boolean }>(
        'SELECT pg_terminate_backend($1) AS killed',
        [backend],
      );
      expect(rows[0]!.killed).toBe(true);

      const fault = await fatal;
      expect(fault.code).toBe('57P01');
      expect(fault.message).toBe('terminating connection due to administrator command');
      return backend;
    });

    expect(await waitUntilGone(s.pool, pid)).toBe(0);
    expect(await entriesWithKey(s.pool, key)).toBe(0);
    expect(await cashBalance(s.pool, lender.wallet, 'USDC')).toBe(before);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('rolls a statement-timeout cancellation back whole', async () => {
    const s = await stage('statement_timeout');
    const { listingId, bidId, supplier, payable } = await marketplace(s, 'TIMEOUT', 9070);
    const key = idempotencyKey();

    await withClients(s.pool, 2, async ([holder, timing]) => {
      await holder!.query('BEGIN');
      await holder!.query('SELECT 1 FROM app.listing WHERE id = $1 FOR UPDATE', [listingId]);

      await timing!.query("SET statement_timeout = '80ms'");
      const cancelled = refused(
        await post(timing!, { kind: 'accept_bid', listingId, bidId }, { actorUserId: s.users.supplier, key }),
      );
      expect(cancelled.code).toBe('57014');
      expect(cancelled.message).toBe('canceling statement due to statement timeout');
      await timing!.query('RESET statement_timeout');
      await holder!.query('ROLLBACK');
    });

    expect(await entriesWithKey(s.pool, key)).toBe(0);
    expect(await countOf(s.pool, "SELECT count(*) AS n FROM app.listing WHERE status = 'open'")).toBe(1);
    expect(await countOf(s.pool, "SELECT count(*) AS n FROM app.bid WHERE status = 'placed'")).toBe(1);
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('rolls a lock-timeout refusal back whole', async () => {
    const s = await stage('lock_timeout');
    const { listingId, bidId, supplier, payable } = await marketplace(s, 'LOCKOUT', 9080);
    const key = idempotencyKey();

    await withClients(s.pool, 2, async ([holder, timing]) => {
      await holder!.query('BEGIN');
      await holder!.query('SELECT 1 FROM app.listing WHERE id = $1 FOR UPDATE', [listingId]);

      await timing!.query("SET lock_timeout = '100ms'");
      const cancelled = refused(
        await post(timing!, { kind: 'accept_bid', listingId, bidId }, { actorUserId: s.users.supplier, key }),
      );
      expect(cancelled.code).toBe('55P03');
      expect(cancelled.message).toBe('canceling statement due to lock timeout');
      await timing!.query('RESET lock_timeout');
      await holder!.query('ROLLBACK');
    });

    expect(await entriesWithKey(s.pool, key)).toBe(0);
    expect(await countOf(s.pool, "SELECT count(*) AS n FROM app.listing WHERE status = 'open'")).toBe(1);
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('raises the escrow invariant at COMMIT, not at the statement', async () => {
    const s = await stage('deferred_escrow');
    const supplier = s.suppliers[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-DEFER-0001',
      invoiceRef: 'INV-DEFER-0001',
      tokenId: 9090,
    });
    const listingId = randomUUID();

    await withClients(s.pool, 1, async ([client]) => {
      await client!.query('BEGIN');
      must(
        await post(
          client!,
          {
            kind: 'publish_listing',
            listingId,
            payableId: payable.id,
            sellerWallet: supplier.wallet,
            quantityBase: FACE,
            minPriceBase: PRICE,
          },
          { actorUserId: s.users.supplier },
        ),
        'publish_listing',
      );
      // Retiring the listing without returning its escrow is exactly what the
      // deferred trigger exists to catch, and it has to stay legal until COMMIT
      // so that a settlement can cancel and unwind in either order.
      const retired = await client!.query("UPDATE app.listing SET status = 'cancelled' WHERE id = $1", [
        listingId,
      ]);
      expect(retired.rowCount).toBe(1);

      const failure = await client!
        .query('COMMIT')
        .then(() => null)
        .catch((error: { code?: string; message?: string }) => error);
      expect(failure?.code).toBe('ADA04');
      expect(failure?.message).toContain(
        `escrow for ${supplier.wallet} asset ${payable.assetId} does not match open listings (held ${FACE}, listed 0)`,
      );
    });

    expect(await countOf(s.pool, 'SELECT count(*) AS n FROM app.listing')).toBe(0);
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', payable.assetId)).toBe(0n);
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_free', payable.assetId)).toBe(BigInt(FACE));
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('leaves a sibling member escrowed and fails ADA04 at COMMIT of a series redemption', async () => {
    const s = await stage('series_escrow');
    const supplier = s.suppliers[0]!;
    const members = await Promise.all(
      [0, 1].map((i) =>
        issuePayable(s, {
          supplier,
          toWallet: supplier.wallet,
          ref: `TP-SERIES-000${i}`,
          invoiceRef: `INV-SERIES-000${i}`,
          faceBase: 400_000_000 + i,
          tokenId: 9100 + i,
        }),
      ),
    );
    const [first, second] = members as [IssuedPayable, IssuedPayable];

    const seriesId = randomUUID();
    await s.pool.query(
      `INSERT INTO app.series (id, ref, anchor_id, maturity_date, grade, grade_rationale)
       VALUES ($1, 'SERIES-CF-0001', $2, $3::date, 'A', 'Sample grade for a test lot.')`,
      [seriesId, s.anchor.entityId, first.maturityDate],
    );
    await s.pool.query('UPDATE app.payable SET series_id = $1 WHERE id = ANY($2::uuid[])', [
      seriesId,
      members.map((m) => m.id),
    ]);

    const listingId = randomUUID();
    must(
      await post(
        s.pool,
        {
          kind: 'publish_listing',
          listingId,
          seriesId,
          sellerWallet: supplier.wallet,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
      'advance_clock',
    );

    await withClients(s.pool, 1, async ([client]) => {
      await client!.query('BEGIN');
      // settle_maturity expires every open listing carrying the settled asset,
      // but only unwinds that one asset's escrow. A series listing carries the
      // sibling members too, so their escrow is left held against a listing
      // that is no longer open.
      expect(
        (
          await post(
            client!,
            { kind: 'settle_maturity', payableId: first.id, fundingCode: 'XUSD' },
            { actorUserId: s.users.adata_preparer },
          )
        ).ok,
      ).toBe(true);

      const failure = await client!
        .query('COMMIT')
        .then(() => null)
        .catch((error: { code?: string; message?: string }) => error);
      expect(failure?.code).toBe('ADA04');
      expect(failure?.message).toBe(
        `escrow for ${supplier.wallet} asset ${second.assetId} does not match open listings (held ${second.faceBase}, listed 0)`,
      );
    });

    const { rows } = await s.pool.query<{ lifecycle: string; listing: string }>(
      `SELECT p.lifecycle_status::text AS lifecycle, l.status::text AS listing
         FROM app.payable p, app.listing l WHERE p.id = $1 AND l.id = $2`,
      [first.id, listingId],
    );
    expect(rows[0]).toEqual({ lifecycle: 'issued', listing: 'open' });
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', first.assetId)).toBe(
      BigInt(first.faceBase),
    );
    expect(await tokenBalance(s.pool, supplier.wallet, 'wallet_listed', second.assetId)).toBe(
      BigInt(second.faceBase),
    );

    // The application posts in autocommit, so the same violation reaches a
    // caller as a refusal of the whole redemption rather than as a commit error.
    const autocommit = refused(
      await post(
        s.pool,
        { kind: 'settle_maturity', payableId: first.id, fundingCode: 'XUSD' },
        { actorUserId: s.users.adata_preparer },
      ),
    );
    expect(autocommit.code).toBe('ADA04');

    // Cancelling the listing by hand first lets both members redeem, which
    // locates the defect in settle_maturity's escrow unwind rather than in the
    // data.
    must(
      await post(s.pool, { kind: 'cancel_listing', listingId }, { actorUserId: s.users.supplier }),
      'cancel_listing',
    );
    for (const member of members) {
      must(
        await post(
          s.pool,
          { kind: 'settle_maturity', payableId: member.id, fundingCode: 'XUSD' },
          { actorUserId: s.users.adata_preparer },
        ),
        'settle_maturity',
      );
    }
    expect(await cashBalance(s.pool, supplier.wallet, 'XUSD')).toBe(
      BigInt(first.faceBase + second.faceBase),
    );
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });

  it('raises the double-entry invariant at COMMIT, not at the statement', async () => {
    const s = await stage('deferred_balance');
    const { rows } = await s.pool.query<{ entry_id: string; account_id: string; asset_id: string }>(
      `SELECT l.entry_id::text, l.account_id::text, l.asset_id::text
         FROM ledger.journal_leg l
        WHERE l.account_id = (SELECT id FROM ledger.account WHERE purpose = 'system_mint')
          AND l.asset_id = (SELECT id FROM ledger.asset WHERE kind = 'cash' AND cash_code = 'XUSD')
        ORDER BY l.entry_id LIMIT 2`,
    );
    const [first, second] = rows;
    if (!first || !second) throw new Error('the fixtures template posted too few legs to unbalance');

    await withClients(s.pool, 1, async ([client]) => {
      await client!.query('BEGIN');
      // Equal and opposite on one account and one asset across two entries, so
      // conservation still nets to zero and only the per-entry check can
      // object. Otherwise ADA05 fires first and hides ADA03.
      const added = await client!.query(
        `INSERT INTO ledger.journal_leg (entry_id, leg_no, account_id, asset_id, amount)
         VALUES ($1, 90, $2, $3, 1), ($4, 91, $5, $6, -1)`,
        [first.entry_id, first.account_id, first.asset_id, second.entry_id, second.account_id, second.asset_id],
      );
      expect(added.rowCount).toBe(2);

      const failure = await client!
        .query('COMMIT')
        .then(() => null)
        .catch((error: { code?: string; message?: string }) => error);
      expect(failure?.code).toBe('ADA03');
      expect(failure?.message).toContain('does not balance for asset');
    });

    expect(await countOf(s.pool, 'SELECT count(*) AS n FROM ledger.journal_leg WHERE leg_no >= 90')).toBe(0);
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});

/** One payable, escrowed in one open listing, with one live bid on it. */
async function marketplace(
  s: Stage,
  tag: string,
  tokenId: number,
): Promise<{ listingId: string; bidId: string; supplier: Party; payable: IssuedPayable }> {
  const supplier = s.suppliers[0]!;
  const lender = s.lenders[0]!;
  const payable = await issuePayable(s, {
    supplier,
    toWallet: supplier.wallet,
    ref: `TP-${tag}-0001`,
    invoiceRef: `INV-${tag}-0001`,
    tokenId,
  });
  const listingId = randomUUID();
  const bidId = randomUUID();
  must(
    await post(
      s.pool,
      {
        kind: 'publish_listing',
        listingId,
        payableId: payable.id,
        sellerWallet: supplier.wallet,
        quantityBase: FACE,
        minPriceBase: PRICE,
      },
      { actorUserId: s.users.supplier },
    ),
    'publish_listing',
  );
  must(
    await post(
      s.pool,
      { kind: 'place_bid', bidId, listingId, bidderWallet: lender.wallet, priceBase: PRICE, fundingCode: 'XUSD' },
      { actorUserId: s.users.lender },
    ),
    'place_bid',
  );
  return { listingId, bidId, supplier, payable };
}

/**
 * The two defects above, stated as the behaviour a reader expects.
 *
 * Everything else in this file pins what the system does, which is the right
 * record for a concurrency suite: `40P01` and `ADA04` are what actually
 * happens, and a test asserting otherwise would just fail for the whole life of
 * the defect. The cost is that both findings are green, so a reader running
 * `npm test` sees a clean sheet over a deadlock on the settlement path and a
 * series lot that cannot be redeemed.
 *
 * These two cases carry the expectation instead. Each is `it.fails`, so the day
 * either is fixed this file turns red and someone deletes the case on purpose.
 * Both are written up in tests/techniques/findings/concurrency-faults.md.
 */
describe('outcomes these races should not have', () => {
  it.fails('settles and accepts on one payable without either side deadlocking', async () => {
    const s = await stage('abba_expected');
    const supplier = s.suppliers[0]!;
    const lender = s.lenders[0]!;
    const payable = await issuePayable(s, {
      supplier,
      toWallet: supplier.wallet,
      ref: 'TP-ABBAX-0001',
      invoiceRef: 'INV-ABBAX-0001',
      tokenId: 9301,
    });

    const listingId = randomUUID();
    const bidId = randomUUID();
    must(
      await post(
        s.pool,
        {
          kind: 'publish_listing',
          listingId,
          payableId: payable.id,
          sellerWallet: supplier.wallet,
          quantityBase: FACE,
          minPriceBase: PRICE,
        },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(
        s.pool,
        { kind: 'place_bid', bidId, listingId, bidderWallet: lender.wallet, priceBase: PRICE, fundingCode: 'XUSD' },
        { actorUserId: s.users.lender },
      ),
      'place_bid',
    );
    must(
      await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
      'advance_clock',
    );

    // The same cycle the test above constructs, so this case fails for the
    // lock ordering and not for a race that happened not to occur.
    await withClients(s.pool, 2, async ([settler, accepter]) => {
      await settler!.query('BEGIN');
      await settler!.query("SET LOCAL deadlock_timeout = '5s'");
      await settler!.query('SELECT 1 FROM app.payable WHERE id = $1 FOR NO KEY UPDATE', [payable.id]);

      await accepter!.query('BEGIN');
      await accepter!.query("SET LOCAL deadlock_timeout = '40ms'");
      await accepter!.query('SELECT 1 FROM app.listing WHERE id = $1 FOR UPDATE', [listingId]);

      const [settled, accepted] = await Promise.all([
        post(
          settler!,
          { kind: 'settle_maturity', payableId: payable.id, fundingCode: 'XUSD' },
          { actorUserId: s.users.adata_preparer },
        ),
        post(accepter!, { kind: 'accept_bid', listingId, bidId }, { actorUserId: s.users.supplier }),
      ]);

      const codes = [settled, accepted]
        .filter((r): r is PostErr => !r.ok)
        .map((r) => r.code);
      await settler!.query('ROLLBACK');
      await accepter!.query('ROLLBACK');

      expect(codes).not.toContain('40P01');
    });
  });

  it.fails('redeems a matured member of a listed series', async () => {
    const s = await stage('series_expected');
    const supplier = s.suppliers[0]!;
    const members = await Promise.all(
      [0, 1].map((i) =>
        issuePayable(s, {
          supplier,
          toWallet: supplier.wallet,
          ref: `TP-SERIESX-000${i}`,
          invoiceRef: `INV-SERIESX-000${i}`,
          faceBase: 400_000_000 + i,
          tokenId: 9310 + i,
        }),
      ),
    );
    const [first] = members as [IssuedPayable, IssuedPayable];

    const seriesId = randomUUID();
    await s.pool.query(
      `INSERT INTO app.series (id, ref, anchor_id, maturity_date, grade, grade_rationale)
       VALUES ($1, 'SERIES-CFX-0001', $2, $3::date, 'A', 'Sample grade for a test lot.')`,
      [seriesId, s.anchor.entityId, first.maturityDate],
    );
    await s.pool.query('UPDATE app.payable SET series_id = $1 WHERE id = ANY($2::uuid[])', [
      seriesId,
      members.map((m) => m.id),
    ]);

    must(
      await post(
        s.pool,
        { kind: 'publish_listing', listingId: randomUUID(), seriesId, sellerWallet: supplier.wallet, minPriceBase: PRICE },
        { actorUserId: s.users.supplier },
      ),
      'publish_listing',
    );
    must(
      await post(s.pool, { kind: 'advance_clock', days: TERMS_DAYS }, { actorUserId: s.users.straitsx_admin }),
      'advance_clock',
    );

    const redeemed = await post(
      s.pool,
      { kind: 'settle_maturity', payableId: first.id, fundingCode: 'XUSD' },
      { actorUserId: s.users.adata_preparer },
    );
    expect(redeemed).toMatchObject({ ok: true });
    expect(await ledgerHealth(s.pool)).toEqual(HEALTHY);
  });
});
