import { describe, expect, it } from 'vitest';

import {
  attempt,
  dueStatusFor,
  isOverdueByClock,
  isTradeable,
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
  TRANSITIONS,
} from '../lifecycle';

/** Walk the happy path exactly as PRD section 7 draws it. */
describe('PRD section 7 obligation lifecycle', () => {
  it('runs draft to settled through the prescribed actors', () => {
    let status: LifecycleStatus = 'draft';
    const path = [
      { event: 'submit', actor: 'adata_preparer', to: 'pending_approval' },
      { event: 'approve', actor: 'adata_checker', to: 'approved' },
      { event: 'certify', actor: 'straitsx_admin', to: 'certified' },
      { event: 'issue', actor: 'adata_preparer', to: 'issued' },
    ] as const;

    for (const step of path) {
      const result = attempt(status, step.event, step.actor);
      expect(result, `${step.event} from ${status}`).toMatchObject({ ok: true, to: step.to });
      if (result.ok) status = result.to;
    }
    expect(status).toBe('issued');

    const matured = attempt(status, 'mature', 'adata_preparer');
    expect(matured).toMatchObject({ ok: true, to: 'matured' });

    expect(attempt('matured', 'settle', 'adata_checker')).toMatchObject({ ok: true, to: 'settled' });
  });

  it('branches matured to overdue', () => {
    expect(attempt('matured', 'mark_overdue', 'straitsx_admin')).toMatchObject({
      ok: true,
      to: 'overdue',
    });
  });
});

describe('maker-checker is enforced by role', () => {
  it('refuses the preparer their own approval', () => {
    const result = attempt('pending_approval', 'approve', 'adata_preparer');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/may not approve/);
  });

  it('refuses a supplier the checker approval', () => {
    expect(attempt('pending_approval', 'approve', 'supplier')).toMatchObject({ ok: false });
  });

  it('refuses ADATA the StraitsX certification', () => {
    expect(attempt('approved', 'certify', 'adata_checker')).toMatchObject({ ok: false });
  });
});

describe('out-of-order transitions are refused with a usable reason', () => {
  it('will not issue a payable that was never certified', () => {
    const result = attempt('approved', 'issue', 'adata_preparer');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/must be certified/);
  });

  it('will not settle a payable that has not matured', () => {
    expect(attempt('issued', 'settle', 'adata_checker')).toMatchObject({ ok: false });
  });

  it('will not settle twice', () => {
    expect(attempt('settled', 'settle', 'adata_checker')).toMatchObject({ ok: false });
  });

  it('will not re-approve an approved payable', () => {
    expect(attempt('approved', 'approve', 'adata_checker')).toMatchObject({ ok: false });
  });
});

describe('only an issued payable is tradeable', () => {
  it('permits market activity while issued', () => {
    expect(isTradeable('issued')).toBe(true);
  });

  it('refuses market activity in every other state', () => {
    const others = LIFECYCLE_STATUSES.filter((s) => s !== 'issued');
    expect(others.filter(isTradeable)).toEqual([]);
  });
});

describe('maturity is derived from the clock, not from an action', () => {
  it('matures an issued payable once days remaining hits zero', () => {
    expect(dueStatusFor('issued', 1)).toBe('issued');
    expect(dueStatusFor('issued', 0)).toBe('matured');
    expect(dueStatusFor('issued', -5)).toBe('matured');
  });

  it('leaves a settled payable alone however far the clock advances', () => {
    expect(dueStatusFor('settled', -900)).toBe('settled');
  });

  it('does not resurrect a draft', () => {
    expect(dueStatusFor('draft', -900)).toBe('draft');
  });

  it('reads a matured payable as overdue only after the due date passes', () => {
    expect(isOverdueByClock('matured', 0)).toBe(false);
    expect(isOverdueByClock('matured', -1)).toBe(true);
    expect(isOverdueByClock('issued', -1)).toBe(false);
    expect(isOverdueByClock('settled', -30)).toBe(false);
  });
});

describe('the transition table is internally consistent', () => {
  it('names only known states', () => {
    for (const [event, transition] of Object.entries(TRANSITIONS)) {
      expect(LIFECYCLE_STATUSES, `${event}.from`).toContain(transition.from);
      expect(LIFECYCLE_STATUSES, `${event}.to`).toContain(transition.to);
    }
  });

  it('leaves every state except draft reachable', () => {
    const reachable = new Set(Object.values(TRANSITIONS).map((t) => t.to));
    const unreachable = LIFECYCLE_STATUSES.filter((s) => s !== 'draft' && !reachable.has(s));
    expect(unreachable).toEqual([]);
  });
});
