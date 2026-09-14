/**
 * First request against a never-initialised database loads the world, and a
 * second pass leaves a mutated world alone.
 *
 * This is the Vercel path: a fresh Neon has no `app` schema, there is no psql
 * in the function image, and wiping a database that already has the demo in it
 * would interrupt a presentation. The driver load is the same as Reset world;
 * only the emptiness gate is new.
 */

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, query } from '@/db/client';
import { resetEnsureForTests } from '@/db/ensure';
import { readPersonas, readWorld } from '@/db/read';

const DB_NAME = 'adata_test_ensure';
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5432/postgres';
const URL = `postgresql://postgres@127.0.0.1:5432/${DB_NAME}`;

function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, DB_NAME },
  });
}

function appSchemaExists(): boolean {
  return (
    execFileSync(
      'psql',
      [URL, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app')"],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim() === 't'
  );
}

beforeAll(() => {
  run('scripts/db.sh', ['up']);
  execFileSync('psql', [ADMIN_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`], {
    stdio: 'pipe',
  });
  execFileSync('psql', [ADMIN_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${DB_NAME};`], {
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = URL;
  delete process.env.NEXT_PHASE;
  resetEnsureForTests();
}, 60_000);

afterAll(async () => {
  await closePool();
});

describe('an empty database', () => {
  it('loads schema and seed on the first read, then leaves a live world alone', async () => {
    expect(appSchemaExists()).toBe(false);

    const world = await readWorld();
    expect(appSchemaExists()).toBe(true);
    expect(world.clock.offsetDays).toBe(0);
    const personas = await readPersonas();
    expect(personas.some((p) => p.role === 'straitsx_admin')).toBe(true);

    await query('UPDATE app.world SET offset_days = 7');
    resetEnsureForTests();
    await closePool();

    const again = await readWorld();
    expect(again.clock.offsetDays).toBe(7);
  });
});
