import { describe, expect, it } from 'vitest';

import { personaAfterOnboarding } from '@/app/onboard-persona';

describe('personaAfterOnboarding', () => {
  const seeded = { name: 'Lin Ya-Ting', entityName: 'Hsin Ta Electronics', userId: 'seed' };
  const created = { name: 'Lin Ya-Ting', entityName: 'Formosa Precision Works', userId: 'new' };

  it('picks the new organisation when a seeded user already has that name', () => {
    expect(
      personaAfterOnboarding([seeded, created], 'Lin Ya-Ting', 'Formosa Precision Works')?.userId,
    ).toBe('new');
  });

  it('still finds a unique name', () => {
    expect(personaAfterOnboarding([seeded, created], 'Rina Okafor', 'Northwind')?.userId).toBeUndefined();
    expect(
      personaAfterOnboarding(
        [...[seeded, created], { name: 'Rina Okafor', entityName: 'Northwind Credit', userId: 'bank' }],
        'Rina Okafor',
        'Northwind Credit',
      )?.userId,
    ).toBe('bank');
  });

  it('trims the form values the way onboard stores them', () => {
    expect(
      personaAfterOnboarding([created], '  Lin Ya-Ting  ', '  Formosa Precision Works  ')?.userId,
    ).toBe('new');
  });
});
