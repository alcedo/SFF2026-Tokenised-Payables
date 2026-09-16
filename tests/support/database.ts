/**
 * Per-suite databases.
 *
 * Every database-backed suite here writes to the ledger, so sharing one
 * database between them would make the suites race each other rather than the
 * system under test. Cloning is cheap enough that nothing has to be shared:
 * `CREATE DATABASE ... TEMPLATE` copies the loaded schema in about 80ms, so
 * each suite owns a database outright and no suite needs a lock.
 *
 * The templates themselves are built once per run in `global-setup.ts`, because
 * vitest workers are separate processes and would otherwise each try to build
 * the same template at the same time.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, types, type PoolClient } from 'pg';

const PG_INT8 = 20;
const PG_NUMERIC = 1700;

// Same parsers as src/db/client.ts. Money has to arrive as bigint here too, or
// an assertion comparing a balance would compare a string to a bigint and pass
// for the wrong reason.
types.setTypeParser(PG_INT8, (value) => BigInt(value));
types.setTypeParser(PG_NUMERIC, (value) => BigInt(value));

/** `bare` is schema only. `fixtures` is the world a fresh database boots into. `seed` is the demo world. */
export type TemplateKind = 'bare' | 'fixtures' | 'seed';

// schema.sql is the tables and invariants; post.sql is ledger.post(). Loading
// only the first gives a database with no way to write, so both always load,
// in this order.
export const TEMPLATE_SOURCES: Record<TemplateKind, readonly string[]> = {
  bare: ['db/schema.sql', 'db/post.sql'],
  fixtures: ['db/schema.sql', 'db/post.sql', 'db/fixtures.sql'],
  seed: ['db/schema.sql', 'db/post.sql', 'db/seed.sql'],
};

const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * Templates are built only when missing, so a fixed name would let a run after
 * a `db/` edit clone a database built from the SQL as it was before. Every
 * suite would then pass against code that is no longer in the tree, which is
 * indistinguishable from passing. Naming the template after a digest of the
 * files it is built from makes an edit produce a name that does not exist yet,
 * so the rebuild is a consequence of the edit rather than something to
 * remember.
 */
function templateName(kind: TemplateKind): string {
  const digest = createHash('sha256');
  for (const file of TEMPLATE_SOURCES[kind]) digest.update(readFileSync(`${ROOT}/${file}`));
  return `adata_t_${kind}_${digest.digest('hex').slice(0, 12)}`;
}

export const TEMPLATES: Record<TemplateKind, string> = {
  bare: templateName('bare'),
  fixtures: templateName('fixtures'),
  seed: templateName('seed'),
};

const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '5432';
const USER = process.env.PGUSER ?? 'postgres';

export function urlFor(database: string): string {
  return `postgresql://${USER}@${HOST}:${PORT}/${database}`;
}

export const ADMIN_URL = urlFor('postgres');

let counter = 0;

/**
 * The prefix every database this run creates shares.
 *
 * Teardown deletes exactly this set and nothing else. The id is stamped into
 * the environment by global-setup before any worker forks, so the workers that
 * create the databases and the teardown that removes them agree on it. Two
 * runs at once get two ids and cannot delete each other's databases.
 */
export function clonePrefix(): string {
  return `adata_x_${process.env.ADATA_RUN_ID ?? process.pid}_`;
}

function uniqueName(suite: string): string {
  const slug = suite.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  counter += 1;
  return `${clonePrefix()}${slug}_${process.pid}_${counter}`;
}

async function withAdmin<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * A database of its own, cloned from a template.
 *
 * `WITH (FORCE)` on the drop matters: a fault-injection test deliberately
 * leaves connections open, and without FORCE the drop would block on them and
 * strand the database.
 */
export async function createDatabase(suite: string, from: TemplateKind = 'fixtures'): Promise<string> {
  const name = uniqueName(suite);
  await withAdmin(async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await pool.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATES[from]}`);
  });
  return name;
}

export async function dropDatabase(name: string): Promise<void> {
  await withAdmin(async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}

export function openPool(database: string, max = 4): Pool {
  return new Pool({
    connectionString: urlFor(database),
    max,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * A database plus its pool, torn down together.
 *
 * Suites call this in `beforeAll` and `await handle.close()` in `afterAll`, so
 * a suite that throws still drops its database instead of leaking one per run.
 */
export interface Database {
  readonly name: string;
  readonly url: string;
  readonly pool: Pool;
  close(): Promise<void>;
}

export async function freshDatabase(suite: string, from: TemplateKind = 'fixtures'): Promise<Database> {
  const name = await createDatabase(suite, from);
  const pool = openPool(name);
  return {
    name,
    url: urlFor(name),
    pool,
    async close() {
      await pool.end().catch(() => {});
      if (process.env.KEEP_DATABASES === '1') {
        console.error(`KEEP_DATABASES=1: kept ${urlFor(name)}`);
        return;
      }
      await dropDatabase(name);
    },
  };
}

// --- posting ----------------------------------------------------------------

export type PostOk = { ok: true; receipt: Record<string, unknown> };
export type PostErr = { ok: false; message: string; code: string | undefined };
export type PostResult = PostOk | PostErr;

export type Role = 'adata_preparer' | 'adata_checker' | 'supplier' | 'lender' | 'straitsx_admin';

/**
 * Who each command is posted as.
 *
 * `journal_entry.actor_user_id` is NOT NULL, so every command needs a real
 * user. Resolving by role against the database rather than hardcoding the
 * fixture UUIDs means a suite works against any template.
 */
export async function actors(executor: Pool | PoolClient): Promise<Record<Role, string | undefined>> {
  const { rows } = await executor.query<{ id: string; role: Role }>(
    'SELECT id::text, role FROM app.app_user WHERE deactivated_at IS NULL ORDER BY id',
  );
  const byRole = {} as Record<Role, string | undefined>;
  for (const row of rows) byRole[row.role] ??= row.id;
  return byRole;
}

export async function anyActor(executor: Pool | PoolClient): Promise<string> {
  const { rows } = await executor.query<{ id: string }>(
    'SELECT id::text FROM app.app_user WHERE deactivated_at IS NULL ORDER BY id LIMIT 1',
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('no app_user to post as; the template loaded no users');
  return id;
}

let keySeq = 0;

export function idempotencyKey(): string {
  keySeq += 1;
  const tail = `${process.pid}${keySeq}`.padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${tail}`;
}

/**
 * Call `ledger.post()` the way the application does, and return its refusal
 * rather than throwing it.
 *
 * A refusal is an expected outcome across most of these suites ("the lender no
 * longer has the funds"), so tests assert on `message` and `code`. Throwing
 * would force every table-driven case to wrap itself in a try/catch and would
 * lose the SQLSTATE.
 */
export async function post(
  executor: Pool | PoolClient,
  intent: Record<string, unknown>,
  options: { actorUserId?: string; key?: string } = {},
): Promise<PostResult> {
  const envelope = {
    idempotencyKey: options.key ?? idempotencyKey(),
    actorUserId: options.actorUserId ?? (await anyActor(executor)),
    intent,
  };
  try {
    const result = await executor.query<{ post: Record<string, unknown> }>(
      'SELECT ledger.post($1::jsonb) AS post',
      [JSON.stringify(envelope)],
    );
    return { ok: true, receipt: result.rows[0]?.post ?? {} };
  } catch (error) {
    const err = error as { message?: string; code?: string };
    return { ok: false, message: err.message ?? String(error), code: err.code };
  }
}

// --- the oracle -------------------------------------------------------------

export interface LedgerHealth {
  projectionMismatches: number;
  unconservedAssets: number;
  negativeBalances: number;
  unbalancedEntries: number;
}

/**
 * The four things that must be true of the books after any sequence of
 * commands, however that sequence was produced.
 *
 * Every database-backed suite asserts this, so a property run, a generated
 * command sequence and an injected fault are all held to the same standard.
 */
export async function ledgerHealth(executor: Pool | PoolClient): Promise<LedgerHealth> {
  const { rows } = await executor.query<{
    projection_mismatches: bigint;
    unconserved_assets: bigint;
    negative_balances: bigint;
    unbalanced_entries: bigint;
  }>(`
    SELECT
      (SELECT count(*) FROM ledger.prove_books_balance())                       AS projection_mismatches,
      (SELECT count(*) FROM (SELECT asset_id FROM ledger.account_balance
          GROUP BY asset_id HAVING SUM(balance) <> 0) c)                        AS unconserved_assets,
      (SELECT count(*) FROM ledger.account_balance
         WHERE balance < 0 AND class = 'wallet')                                AS negative_balances,
      (SELECT count(*) FROM (SELECT entry_id FROM ledger.journal_leg
          GROUP BY entry_id, asset_id HAVING SUM(amount) <> 0) u)               AS unbalanced_entries
  `);
  const r = rows[0]!;
  return {
    projectionMismatches: Number(r.projection_mismatches),
    unconservedAssets: Number(r.unconserved_assets),
    negativeBalances: Number(r.negative_balances),
    unbalancedEntries: Number(r.unbalanced_entries),
  };
}

export const HEALTHY: LedgerHealth = {
  projectionMismatches: 0,
  unconservedAssets: 0,
  negativeBalances: 0,
  unbalancedEntries: 0,
};
