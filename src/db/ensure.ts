import { closePool, pool } from './client';
import { applyFixtures, applySchemaAndPost, beginWorldLoad } from './sql';

/**
 * Transaction-scoped lock. Neon pooled connections are transaction-mode, so a
 * session advisory lock would not serialise two serverless cold starts.
 */
const BOOTSTRAP_LOCK = { classid: 2026, objid: 10_005 };

type WorldState = 'ready' | 'missing-schema' | 'missing-world';

function ensureMemo(): Promise<void> | undefined {
  return globalThis.__adataEnsure;
}

function setEnsureMemo(value: Promise<void> | undefined): void {
  globalThis.__adataEnsure = value;
}

async function classify(
  query: (text: string) => Promise<{ rows: Array<{ exists: boolean }> }>,
): Promise<WorldState> {
  // Catalog only. A SELECT from app.world that fails with 42P01 aborts the
  // transaction we are about to load into.
  const rel = await query(`SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = 'world'
    ) AS exists`);
  if (!rel.rows[0]?.exists) return 'missing-schema';
  const row = await query('SELECT EXISTS (SELECT 1 FROM app.world) AS exists');
  return row.rows[0]?.exists ? 'ready' : 'missing-world';
}

/**
 * Make the database able to serve Shell and create-payable.
 *
 * Ready means `app.world` has a row. A missing relation is a never-initialised
 * host. A present table with no row is schema-only (`scripts/db.sh bare`, or
 * someone loaded schema.sql and stopped). Neither may throw.
 *
 * Does not load db/seed.sql. That catalogue is Reset world's job.
 */
export async function ensureWorld(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (!ensureMemo()) {
    setEnsureMemo(
      bootstrap().catch((error: unknown) => {
        setEnsureMemo(undefined);
        throw error;
      }),
    );
  }
  await ensureMemo();
}

async function bootstrap(): Promise<void> {
  if ((await classify((text) => pool().query<{ exists: boolean }>(text))) === 'ready') return;

  const client = await pool().connect();
  let loaded = false;
  try {
    await beginWorldLoad(client);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      BOOTSTRAP_LOCK.classid,
      BOOTSTRAP_LOCK.objid,
    ]);

    const state = await classify((text) => client.query<{ exists: boolean }>(text));
    if (state === 'ready') {
      await client.query('COMMIT');
      return;
    }
    if (state === 'missing-schema') {
      await applySchemaAndPost(client);
    }
    const afterSchema = await classify((text) => client.query<{ exists: boolean }>(text));
    if (afterSchema !== 'ready') {
      await applyFixtures(client);
    }
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
