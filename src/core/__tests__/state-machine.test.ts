import { describe, expect, it } from 'vitest';

import {
  attempt,
  dueStatusFor,
  isOverdueByClock,
  isTerminal,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
  ROLES,
} from '../lifecycle';
import { PRD_EDGES, PRD_HAPPY_PATH } from './prd-oracle';

describe('obligation machine: happy path', () => {
  it('walks draft to settled through the PRD sequence', () => {
    let status: LifecycleStatus = 'draft';
    const actorFor: Record<string, (typeof ROLES)[number]> = {
      submit: 'adata_preparer',
      approve: 'adata_checker',
      certify: 'straitsx_admin',
      issue: 'adata_preparer',
      mature: 'adata_preparer',
      settle: 'adata_checker',
    };

    for (const event of PRD_HAPPY_PATH) {
      const result = attempt(status, event, actorFor[event]!);
      expect(result.ok, `${event} from ${status}`).toBe(true);
      if (result.ok) status = result.to;
    }
    expect(status).toBe('settled');
    expect(isTerminal(status)).toBe(true);
  });

  it('branches matured to overdue instead of settled', () => {
    const result = attempt('matured', 'mark_overdue', 'straitsx_admin');
    expect(result).toMatchObject({ ok: true, to: 'overdue' });
    expect(isTerminal('overdue')).toBe(false);
  });
});

describe('obligation machine: every PRD edge and no extras', () => {
  it('fires each documented edge', () => {
    for (const edge of PRD_EDGES) {
      const actor = edge.actors[0] ?? 'straitsx_admin';
      const result = attempt(edge.from, edge.event, actor);
      expect(result, `${edge.event}`).toMatchObject({ ok: true, to: edge.to });
    }
  });

  it('refuses every other status × event pair', () => {
    for (const status of LIFECYCLE_STATUSES) {
      for (const event of LIFECYCLE_EVENTS) {
        const documented = PRD_EDGES.some((e) => e.event === event && e.from === status);
        if (documented) continue;
        for (const role of ROLES) {
          expect(attempt(status, event, role).ok, `${role} ${event} from ${status}`).toBe(false);
        }
      }
    }
  });
});

describe('clock-driven maturity', () => {
  it('issued stays issued with one day remaining and matures at zero', () => {
    expect(dueStatusFor('issued', 1)).toBe('issued');
    expect(dueStatusFor('issued', 0)).toBe('matured');
    expect(dueStatusFor('issued', -1)).toBe('matured');
  });

  it('does not move a status the clock does not own', () => {
    for (const status of LIFECYCLE_STATUSES.filter((s) => s !== 'issued')) {
      expect(dueStatusFor(status, -90)).toBe(status);
    }
  });

  it('overdue is the day after due, and only while unpaid', () => {
    expect(isOverdueByClock('matured', 0)).toBe(false);
    expect(isOverdueByClock('matured', -1)).toBe(true);
    expect(isOverdueByClock('settled', -1)).toBe(false);
  });
});

