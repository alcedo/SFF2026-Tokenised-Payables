import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PoolClient } from 'pg';

/**
 * The three files that make a database into the demo world.
 *
 * Reset world, the first request against an empty hosted database, and
 * `scripts/db.sh` all apply this same set. The files live at the repo root so a
 * laptop can run them through psql, and next.config.mjs traces them into every
 * serverless bundle because on Vercel there is no checkout to read from.
 */
export const WORLD_SQL_FILES = ['db/schema.sql', 'db/post.sql', 'db/seed.sql'] as const;

/**
 * Remove psql meta-commands such as `\set` and `\echo`.
 *
 * They are valid in a file run through psql and a syntax error through the
 * driver, so a contributor adding one for local convenience would otherwise
 * break production-only paths. Stripping them here means the files stay
 * runnable both ways.
 */
export function stripPsqlDirectives(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');
}

export async function readWorldSql(): Promise<string[]> {
  return Promise.all(
    WORLD_SQL_FILES.map((file) => readFile(path.join(process.cwd(), file), 'utf8')),
  );
}

/**
 * Load the schema, the write surface, and the seed onto an open connection.
 *
 * The caller owns the transaction: Reset world drops first, first-request
 * bootstrap does not. Both need a long statement timeout because Neon cold
 * starts plus the seed's historical `ledger.post()` calls can outlast the
 * pool's 10s default, and a timeout mid-file would leave a half-world.
 */
export async function applyWorldSql(client: PoolClient): Promise<void> {
  for (const sql of await readWorldSql()) {
    await client.query(stripPsqlDirectives(sql));
  }
}

export async function beginWorldLoad(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '120s'");
}
