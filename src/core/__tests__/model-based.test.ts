import { describe, expect, it } from 'vitest';

import {
  attempt,
  LIFECYCLE_EVENTS,
  type LifecycleStatus,
  ROLES,
} from '../lifecycle';
import { PRD_EDGES, prdAttempt } from './prd-oracle';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

describe('random walks agree with the PRD oracle', () => {
  it('never diverges, and covers every documented edge', () => {
    const covered = new Set<string>();
    const rand = rng(20261001);

    for (const edge of PRD_EDGES) {
      const actor = edge.actors[0] ?? 'straitsx_admin';
      const actual = attempt(edge.from, edge.event, actor);
      expect(actual.ok, `${edge.event}`).toBe(true);
      if (actual.ok) covered.add(`${edge.from}:${edge.event}:${actual.to}`);
    }

    for (let walk = 0; walk < 400; walk += 1) {
      let status: LifecycleStatus = 'draft';
      for (let step = 0; step < 12; step += 1) {
        const event = pick(rand, LIFECYCLE_EVENTS);
        const actor = pick(rand, ROLES);
        const expected = prdAttempt(status, event, actor);
        const actual = attempt(status, event, actor);
        expect(actual.ok, `${actor} ${event} from ${status}`).toBe(expected.ok);
        if (expected.ok && actual.ok) {
          expect(actual.to).toBe(expected.to);
          covered.add(`${status}:${event}:${actual.to}`);
          status = actual.to;
        }
      }
    }

    for (const edge of PRD_EDGES) {
      expect(covered.has(`${edge.from}:${edge.event}:${edge.to}`), `${edge.event}`).toBe(true);
    }
  });
});
