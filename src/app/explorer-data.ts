'use server';

import { readEvents, readProgrammeTotals, readSimulatedReceipt, readWorld, serializeEvent, serializeReceipt } from '@/db/read';

export async function loadExplorerLog() {
  const world = await readWorld();
  const [events, totals] = await Promise.all([readEvents({ limit: 200 }), readProgrammeTotals(world)]);
  return {
    events: events.map(serializeEvent),
    totals: {
      bookDrift: totals.bookDrift,
      issuedCount: totals.issuedCount,
    },
    worldDate: world.today,
    epoch: String(world.epoch),
  };
}

export async function loadSimulatedReceipt(txHash: string) {
  const receipt = await readSimulatedReceipt(txHash);
  return receipt ? serializeReceipt(receipt) : null;
}
