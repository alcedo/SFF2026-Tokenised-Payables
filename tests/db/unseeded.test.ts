/**
 * A new Vercel/Neon database has DATABASE_URL and nothing else.
 * Core programme operations must work without anyone running seed.sql.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5432/postgres';

function createEmptyDatabase(name: string): string {
  sh('psql', [ADMIN_URL, '-q', '-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`]);
  sh('psql', [ADMIN_URL, '-q', '-c', `CREATE DATABASE ${name};`]);
  return `postgresql://postgres@127.0.0.1:5432/${name}`;
}

/** Neon-like: the login owns the database and cannot CREATE ROLE. */
function createNocreateroleDatabase(name: string): { url: string; owner: string } {
  const owner = `${name}_owner`;
  sh('psql', [ADMIN_URL, '-q', '-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`]);
  sh('psql', [ADMIN_URL, '-q', '-c', `DROP ROLE IF EXISTS ${owner};`]);
  sh('psql', [
    ADMIN_URL,
    '-q',
    '-c',
    `CREATE ROLE ${owner} LOGIN PASSWORD 'x' NOSUPERUSER NOCREATEDB NOCREATEROLE;`,
  ]);
  sh('psql', [ADMIN_URL, '-q', '-c', `CREATE DATABASE ${name} OWNER ${owner};`]);
  // Local non-superusers cannot CREATE EXTENSION; Neon owners can. Pre-install
  // so this test measures CREATE ROLE / GRANT, which is the hosted failure.
  sh('psql', [
    `postgresql://postgres@127.0.0.1:5432/${name}`,
    '-q',
    '-c',
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
  ]);
  return { url: `postgresql://${owner}:x@127.0.0.1:5432/${name}`, owner };
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
  expect(onboard.ok).toBe(true);

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
  expect(created.ok).toBe(true);

  const payables = await readPayables(world);
  expect(payables.some((p) => p.supplierName === company)).toBe(true);

  const advanced = await post({
    key: randomUUID(),
    actorUserId: actor.userId,
    intent: { kind: 'advance_clock', days: 4 },
  });
  expect(advanced.ok).toBe(true);
  await closePool();
  const again = await readWorld();
  expect(again.clock.offsetDays).toBe(world.clock.offsetDays + 4);
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

describe('a schema-only database that already has a differently-id ADATA', () => {
  const DB_NAME = 'adata_test_unseeded_natural';

  beforeAll(async () => {
    await closePool();
    sh('scripts/db.sh', ['bare'], { ...process.env, DB_NAME });
    const url = sh('scripts/db.sh', ['url'], { ...process.env, DB_NAME }).trim();
    sh('psql', [
      url,
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `INSERT INTO app.entity (id, name, entity_type, certification_status)
       VALUES ('e0000000-0000-0000-0000-0000000000a1',
               'ADATA Technology Co., Ltd.', 'anchor', 'certified');`,
    ]);
    process.env.DATABASE_URL = url;
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('loads fixtures without colliding on the organisation name', async () => {
    const world = await readWorld();
    expect(world.clock.offsetDays).toBe(0);

    const anchors = await readEntities('anchor');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.id).toBe('e0000000-0000-0000-0000-0000000000a1');

    const personas = await readPersonas();
    const roles = new Set(personas.map((p) => p.role));
    expect(roles).toContain('adata_preparer');
    expect(roles).toContain('adata_checker');
    expect(roles).toContain('straitsx_admin');
  });
});

describe('a database whose owner cannot CREATE ROLE', () => {
  const DB_NAME = 'adata_test_unseeded_nocreaterole';
  let owner = '';

  beforeAll(async () => {
    await closePool();
    const created = createNocreateroleDatabase(DB_NAME);
    owner = created.owner;
    process.env.DATABASE_URL = created.url;
  }, 30_000);

  afterAll(async () => {
    await closePool();
    sh('psql', [ADMIN_URL, '-q', '-c', `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`]);
    sh('psql', [ADMIN_URL, '-q', '-c', `DROP ROLE IF EXISTS ${owner};`]);
  });

  it('schema.sql catches missing CREATEROLE instead of aborting the first request', () => {
    const sql = readFileSync('db/schema.sql', 'utf8');
    expect(sql).toContain('WHEN insufficient_privilege');
  });

  it('serves a world and lets the core create-payable path run', async () => {
    const createrole = sh('psql', [
      process.env.DATABASE_URL!,
      '-t',
      '-A',
      '-c',
      'SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user;',
    ]).trim();
    expect(createrole).toBe('f');
    await assertCoreProgrammeWorks();
  });
});
