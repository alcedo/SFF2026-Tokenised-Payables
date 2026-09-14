import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { closePool, pool } from './client';

/**
 * Rebuild the world from the schema and the seed.
 *
 * PRD §11 requires a reset that "restores the complete seed state, including
 * the clock and the mocked FX rate". The clock is a fixed T0 plus a
 * forward-only offset, so there is nothing to unwind; reloading is the only
 * honest way back.
 *
 * This executes the SQL files rather than shelling out to scripts/db.sh,
 * because on Vercel there is no shell, no psql and no scripts directory. The
 * files themselves are traced into the deployment by next.config.mjs.
 */
const FILES = ['db/schema.sql', 'db/post.sql', 'db/seed.sql'] as const;

/**
 * Remove psql meta-commands such as `\set` and `\echo`.
 *
 * They are valid in a file run through psql and a syntax error through the
 * driver, so a contributor adding one for local convenience would otherwise
 * break Reset world only in production. Stripping them here means the files
 * stay runnable both ways.
 */
function stripPsqlDirectives(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');
}

export async function resetWorld(): Promise<void> {
  const sql = await Promise.all(
    FILES.map((f) => readFile(path.join(process.cwd(), f), 'utf8')),
  );

  const client = await pool().connect();
  try {
    // One transaction: a half-reset world would be worse than no reset, and a
    // presenter pressing this mid-sentence deserves either the old world or the
    // new one, never a mixture.
    await client.query('BEGIN');
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.query('DROP SCHEMA IF EXISTS ledger CASCADE');
    for (const statement of sql) {
      await client.query(stripPsqlDirectives(statement));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // The seed recreates every table, so any pooled connection still holding a
  // plan against the old ones would fail its next query.
  await closePool();
}
