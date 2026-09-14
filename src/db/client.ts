/**
 * The database connection.
 *
 * Two things here are load-bearing rather than boilerplate.
 *
 * First, the type parsers. node-postgres hands back `BIGINT` as a JavaScript
 * string, and `SUM(bigint)` as a `NUMERIC` string, because neither fits safely
 * in a double. Left alone, the first contributor who needs arithmetic reaches
 * for `Number()` and the money path acquires a float. Registering a parser that
 * turns both into `bigint` means a money value arrives already in the only
 * representation the rest of the system accepts, and `Number()` on it throws
 * rather than rounding.
 *
 * Second, the pool size. On Vercel each serverless instance gets its own pool,
 * and instances scale out under load, so a large per-instance pool multiplies
 * into a connection-limit failure on the database rather than into throughput.
 * One connection per instance, plus a pooled connection string, is the shape
 * that survives.
 */

import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

const PG_INT8 = 20;
const PG_NUMERIC = 1700;

/**
 * Both arrive as strings on the wire. Parsing to `bigint` keeps every integer
 * exact and makes an accidental float a runtime error instead of a silent loss
 * of precision.
 *
 * A NUMERIC carrying a fraction would throw here, which is intentional: the
 * schema's own CI check (schema.sql §12) asserts no fractional column exists in
 * the money path, so a fractional NUMERIC reaching this point means that check
 * has been defeated and the loud failure is the correct one.
 */
types.setTypeParser(PG_INT8, (value) => BigInt(value));
types.setTypeParser(PG_NUMERIC, (value) => BigInt(value));

declare global {
  // eslint-disable-next-line no-var
  var __adataPool: Pool | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Locally: scripts/db.sh up, then export DATABASE_URL="$(scripts/db.sh url)".',
    );
  }
  return url;
}

/**
 * One pool per process, cached on `globalThis` so Next's dev-mode module
 * reloading does not leak a new pool on every edit.
 */
export function pool(): Pool {
  if (!globalThis.__adataPool) {
    globalThis.__adataPool = new Pool({
      connectionString: connectionString(),
      max: Number(process.env.PG_POOL_MAX ?? 1),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      // A statement that has not finished in ten seconds is not going to make
      // the PRD's 2000ms budget, and holding locks past that hurts everyone
      // else on a shared demo world.
      statement_timeout: 10_000,
      // Contention on a listing resolves in milliseconds. Waiting longer than
      // two seconds means something is genuinely stuck, and a prompt
      // "try again" beats a spinner nobody can explain at a booth.
      lock_timeout: 2_000,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString()) ? undefined : { rejectUnauthorized: true },
    });
  }
  return globalThis.__adataPool;
}

/**
 * First use of the driver loads schema+seed if the database has no `app`
 * schema. That is how a fresh Neon on Vercel becomes the demo world without
 * psql. Memoised per process; a populated database is a no-op after one
 * catalog check.
 *
 * Dynamic import so this module can finish initialising before ensure.ts
 * asks for pool(). A static import would be a cycle.
 */
async function ensureReady(): Promise<void> {
  const { ensureWorld } = await import('./ensure');
  await ensureWorld();
}

export async function query<R extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  await ensureReady();
  const result = await pool().query<R>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<R extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R | null> {
  const rows = await query<R>(text, params);
  return rows[0] ?? null;
}

/**
 * Run several statements on one connection inside a transaction.
 *
 * Almost nothing needs this: `ledger.post()` is itself atomic, and a single
 * call is one network round trip. It exists for seeding and for tests that
 * need to hold a lock open deliberately.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureReady();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__adataPool) {
    await globalThis.__adataPool.end();
    globalThis.__adataPool = undefined;
  }
}
