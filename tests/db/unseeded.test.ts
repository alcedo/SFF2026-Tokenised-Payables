/**
 * A new Vercel/Neon database has DATABASE_URL and nothing else.
 * Core programme operations must work without anyone running seed.sql.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool } from '@/db/client';
import { post } from '@/db/post';
import { readEntities, readPayables, readPersonas, readWorld } from '@/db/read';
import { fromBaseUnits } from '@/core/money';

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  });
}

function createEmptyDatabase(name: string): string {
  const admin = 'postgresql://postgres@127.0.0.1:5432/postgres';
  sh('psql', [admin, '-q', '-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`]);
  sh('psql', [admin, '-q', '-c', `CREATE DATABASE ${name};`]);
  return `postgresql://postgres@127.0.0.1:5432/${name}`;
}

async function assertCoreProgrammeWorks() {
  const world = await readWorld();
  expect(world.clock.offsetDays).toBe(0);
  expect(world.xsgdPerXusdE6).toBeGreaterThan(0n);

  const personas = await readPersonas();
  const roles = new Set(personas.map((p) => p.role));
  expect(roles).toContain('adata_preparer');
  expect(roles).toContain('adata_checker');
  expect(roles).toContain('straitsx_admin');

  const actor = personas.find((p) => p.role === 'straitsx_admin') ?? personas[0]!;
  const preparer = personas.find((p) => p.role === 'adata_preparer')!;

  const company = `Empty-DB Supplier ${randomUUID().slice(0, 8)}`;
  const onboard = await post({
    key: randomUUID(),
    actorUserId: actor.userId,
    intent: {
      kind: 'onboard_entity',
      name: company,
      entityType: 'supplier',
      userName: 'First User',
      role: 'supplier',
    },
  });
  expect(onboard, JSON.stringify(onboard)).toMatchObject({ ok: true });

  const supplier = (await readEntities('supplier')).find((e) => e.name === company);
  expect(supplier).toBeTruthy();

  const created = await post({
    key: randomUUID(),
    actorUserId: preparer.userId,
    intent: {
      kind: 'create_payable',
      ref: `TP-EMPTY-${randomUUID().slice(0, 8)}`,
      supplierId: supplier!.id,
      invoiceRef: `INV-${randomUUID().slice(0, 8)}`,
      faceBase: fromBaseUnits(1_000_000n),
      termsDays: 90,
    },
  });
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true });

  const payables = await readPayables(world);
  expect(payables.some((p) => p.supplierName === company)).toBe(true);
}

describe('a hosted database with no schema and no seed', () => {
  const DB_NAME = 'adata_test_unseeded_empty';

  beforeAll(async () => {
    await closePool();
    process.env.DATABASE_URL = createEmptyDatabase(DB_NAME);
  }, 30_000);

  afterAll(async () => {
    await closePool();
  });

  it('serves a world and lets the core create-payable path run', async () => {
    await assertCoreProgrammeWorks();
  });
});

describe('a database that has the schema but no seed', () => {
  const DB_NAME = 'adata_test_unseeded_bare';

  beforeAll(async () => {
    await closePool();
    sh('scripts/db.sh', ['bare'], { ...process.env, DB_NAME });
    process.env.DATABASE_URL = sh('scripts/db.sh', ['url'], { ...process.env, DB_NAME }).trim();
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('serves a world and lets the core create-payable path run', async () => {
    await assertCoreProgrammeWorks();
  });
});
