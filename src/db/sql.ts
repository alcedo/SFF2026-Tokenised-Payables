import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PoolClient } from 'pg';

export function stripPsqlDirectives(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');
}

export async function beginWorldLoad(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '120s'");
}

async function run(client: PoolClient, sql: string): Promise<void> {
  await client.query(stripPsqlDirectives(sql));
}

export async function applySchemaAndPost(client: PoolClient): Promise<void> {
  const root = process.cwd();
  // Literal `db/….sql` segments so Turbopack traces only these files. A path
  // built from a variable looks dynamic and ships the whole repository.
  await run(client, await readFile(path.join(root, 'db/schema.sql'), 'utf8'));
  await run(client, await readFile(path.join(root, 'db/post.sql'), 'utf8'));
}

export async function applyFixtures(client: PoolClient): Promise<void> {
  await run(client, await readFile(path.join(process.cwd(), 'db/fixtures.sql'), 'utf8'));
}

export async function applySeed(client: PoolClient): Promise<void> {
  await run(client, await readFile(path.join(process.cwd(), 'db/seed.sql'), 'utf8'));
}
