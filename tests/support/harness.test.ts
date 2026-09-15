/**
 * The harness itself, checked.
 *
 * Every other database-backed suite trusts that its database is its own and
 * that the oracle notices a broken book. If either is false those suites pass
 * for the wrong reason, so both are asserted here directly.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { freshDatabase, ledgerHealth, post, HEALTHY, type Database } from './database';

const open: Database[] = [];

async function db(name: string) {
  const handle = await freshDatabase(name, 'fixtures');
  open.push(handle);
  return handle;
}

afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

describe('per-suite database isolation', () => {
  it('gives two suites different databases', async () => {
    const [a, b] = await Promise.all([db('iso_a'), db('iso_b')]);
    expect(a.name).not.toBe(b.name);
  });

  it('does not leak a write from one database into another', async () => {
    const [a, b] = await Promise.all([db('leak_a'), db('leak_b')]);
    const wallet = await a.pool.query<{ address: string }>('SELECT address FROM app.wallet LIMIT 1');
    const address = wallet.rows[0]!.address;

    const topUps = async (d: Database) =>
      Number((await d.pool.query<{ n: bigint }>(
        "SELECT count(*) AS n FROM ledger.journal_entry WHERE kind = 'top_up'",
      )).rows[0]!.n);

    const before = { a: await topUps(a), b: await topUps(b) };
    expect(await post(a.pool, { kind: 'top_up', wallet: address, cashCode: 'USDC', amountBase: 5_000_000 }))
      .toMatchObject({ ok: true });

    expect(await topUps(a)).toBe(before.a + 1);
    expect(await topUps(b)).toBe(before.b);
  });
});

describe('the ledger oracle', () => {
  it('reports a healthy book on a fresh database', async () => {
    const d = await db('oracle_clean');
    expect(await ledgerHealth(d.pool)).toEqual(HEALTHY);
  });

  it('still reports healthy after a real command', async () => {
    const d = await db('oracle_after');
    const wallet = await d.pool.query<{ address: string }>('SELECT address FROM app.wallet LIMIT 1');
    await post(d.pool, { kind: 'top_up', wallet: wallet.rows[0]!.address, cashCode: 'XSGD', amountBase: 1_234_000 });
    expect(await ledgerHealth(d.pool)).toEqual(HEALTHY);
  });

  it('notices an asset that no longer sums to zero', async () => {
    const d = await db('oracle_broken');
    const wallet = await d.pool.query<{ address: string }>('SELECT address FROM app.wallet LIMIT 1');
    await post(d.pool, { kind: 'top_up', wallet: wallet.rows[0]!.address, cashCode: 'USDC', amountBase: 9_000_000 });

    // Corrupt one leg behind the append-only trigger's back, so the oracle is
    // shown failing on a book that is genuinely broken rather than only ever
    // shown passing.
    await d.pool.query('ALTER TABLE ledger.journal_leg DISABLE TRIGGER USER');
    await d.pool.query(`
      UPDATE ledger.journal_leg SET amount = amount + 1
       WHERE (entry_id, leg_no) = (
         SELECT entry_id, leg_no FROM ledger.journal_leg ORDER BY entry_id, leg_no LIMIT 1)`);
    await d.pool.query('ALTER TABLE ledger.journal_leg ENABLE TRIGGER USER');

    const health = await ledgerHealth(d.pool);
    expect(health).not.toEqual(HEALTHY);
    expect(health.unbalancedEntries).toBeGreaterThan(0);
  });
});
