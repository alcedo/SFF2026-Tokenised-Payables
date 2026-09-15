/**
 * Reset world, once into each target it offers.
 *
 * The Record in src/db/reset.ts is a compile-time guarantee that every target
 * has a loader. It says nothing about which world each one leaves behind, and
 * that is the thing a presenter is choosing between. So both are loaded for
 * real and read back through the functions the screens use.
 */

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool } from '@/db/client';
import { readErpInbox, readMarketplace, readPayables, readPersonas, readWorld } from '@/db/read';
import { resetWorld } from '@/db/reset';

/** Its own database: vitest runs files in parallel and a shared reset is a race. */
const DB_NAME = 'adata_test_reset';

beforeAll(() => {
  const env = { ...process.env, DB_NAME };
  execFileSync('scripts/db.sh', ['bare'], { cwd: process.cwd(), stdio: 'pipe', env });
  process.env.DATABASE_URL = execFileSync('scripts/db.sh', ['url'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  }).trim();
}, 60_000);

afterAll(async () => {
  await closePool();
});

describe("reset to 'seed'", () => {
  it('leaves the demo catalogue on the market', async () => {
    await resetWorld('seed');

    const world = await readWorld();
    expect(world.clock.offsetDays).toBe(0);

    const refs = (await readMarketplace(world)).map((l) => l.targetRef).sort();
    expect(refs).toEqual([
      'SERIES-2026-Q4-30D',
      'TP-2026-0141',
      'TP-2026-0142',
      'TP-2026-0143',
      'TP-2026-0149',
    ]);
  }, 120_000);
});

describe("reset to 'fixtures'", () => {
  it('leaves the counterparties and the ERP register, with nothing issued', async () => {
    await resetWorld('fixtures');

    const world = await readWorld();
    expect(world.clock.offsetDays).toBe(0);
    expect(await readPayables(world)).toEqual([]);
    expect(await readMarketplace(world)).toEqual([]);

    // Empty on their own would also be the answer for a world that failed to
    // load, so the same test names what this one does have.
    expect(await readErpInbox()).toHaveLength(24);
    expect((await readPersonas()).map((p) => p.role).sort()).toEqual([
      'adata_checker',
      'adata_preparer',
      'lender',
      'lender',
      'straitsx_admin',
      'supplier',
      'supplier',
    ]);
  }, 120_000);
});
