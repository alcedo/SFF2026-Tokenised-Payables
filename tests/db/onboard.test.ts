/**
 * Onboarding must land on the account it created. Person names are not unique.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { personaAfterOnboarding } from '@/app/onboard-persona';
import { closePool } from '@/db/client';
import { post } from '@/db/post';
import { readPersonas } from '@/db/read';

const DB_NAME = 'adata_test_onboard';

beforeAll(() => {
  const env = { ...process.env, DB_NAME };
  execFileSync('scripts/db.sh', ['reset'], { cwd: process.cwd(), stdio: 'pipe', env });
  process.env.DATABASE_URL = execFileSync('scripts/db.sh', ['url'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  }).trim();
}, 60_000);

afterAll(async () => {
  await closePool();
});

describe('onboarding a namesake', () => {
  it('switches to the new company, not the seeded user who already has that name', async () => {
    const actor = (await readPersonas()).find((p) => p.role === 'straitsx_admin');
    expect(actor?.name).toBe('Nadia Rahman');

    const company = 'Formosa Precision Works';
    const result = await post({
      key: randomUUID(),
      actorUserId: actor!.userId,
      intent: {
        kind: 'onboard_entity',
        name: company,
        entityType: 'supplier',
        userName: 'Lin Ya-Ting',
        role: 'supplier',
      },
    });
    expect(result.ok).toBe(true);

    const personas = await readPersonas();
    const namesakes = personas.filter((p) => p.name === 'Lin Ya-Ting');
    expect(namesakes.map((p) => p.entityName).sort()).toEqual([
      'Formosa Precision Works',
      'Hsin Ta Electronics',
    ]);

    const chosen = personaAfterOnboarding(personas, 'Lin Ya-Ting', company);
    expect(chosen?.entityName).toBe(company);
    expect(chosen?.wallet).toBe(
      namesakes.find((p) => p.entityName === company)?.wallet,
    );
    expect(chosen?.wallet).not.toBe(
      namesakes.find((p) => p.entityName === 'Hsin Ta Electronics')?.wallet,
    );
  });
});
