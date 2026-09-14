import { closePool, pool } from './client';
import { applyWorldSql, beginWorldLoad } from './sql';

/**
 * Class 7 / class 8 advisory lock keys for the empty-database load.
 *
 * Transaction-scoped, not session-scoped: Neon’s pooled connection string
 * (transaction mode) drops session state at COMMIT, so a session lock would
 * not serialise two serverless instances. Two cold starts against a fresh
 * database both try to load; the loser waits, then sees `app` and skips.
 */
const BOOTSTRAP_LOCK = { classid: 2026, objid: 10_004 };

let ready: Promise<void> | undefined;

export function resetEnsureForTests(): void {
  ready = undefined;
}

/**
 * Load schema + seed if this database has never been initialised.
 *
 * "Empty" means the `app` schema is absent. That is a fresh Neon/Supabase
 * database, not a `scripts/db.sh bare` test database (those already have
 * `app` and `ledger`, just no seed). A populated demo is left alone: later
 * deploys must not wipe a world someone is presenting.
 *
 * Skipped during `next build`. Vercel injects DATABASE_URL at build time too,
 * and running this there would make every preview deploy contend for the
 * database before the function is even serving traffic.
 */
export async function ensureWorld(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (!ready) {
    ready = bootstrapIfEmpty().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
  }
  await ready;
}

async function hasAppSchema(): Promise<boolean> {
  const result = await pool().query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') AS exists",
  );
  return result.rows[0]?.exists === true;
}

async function bootstrapIfEmpty(): Promise<void> {
  if (await hasAppSchema()) return;

  const client = await pool().connect();
  let loaded = false;
  try {
    await beginWorldLoad(client);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      BOOTSTRAP_LOCK.classid,
      BOOTSTRAP_LOCK.objid,
    ]);

    const locked = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') AS exists",
    );
    if (locked.rows[0]?.exists) {
      await client.query('COMMIT');
      return;
    }

    await applyWorldSql(client);
    await client.query('COMMIT');
    loaded = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (loaded) await closePool();
}
