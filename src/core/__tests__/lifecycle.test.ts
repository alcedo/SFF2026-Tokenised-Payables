import { describe, expect, it } from 'vitest';

import {
  attempt,
  dueStatusFor,
  isOverdueByClock,
  isTradeable,
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
  pendingStep,
  ROLE_LABELS,
  ROLES,
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
      { event: 'issue', actor: 'straitsx_admin', to: 'issued' },
    ] as const;

    for (const step of path) {
      const result = attempt(status, step.event, step.actor);
      expect(result, `${step.event} from ${status}`).toMatchObject({ ok: true, to: step.to });
      if (result.ok) status = result.to;
    }
    expect(status).toBe('issued');

    const matured = attempt(status, 'mature', 'adata_preparer');
    expect(matured).toMatchObject({ ok: true, to: 'matured' });

    expect(attempt('matured', 'settle', 'adata_preparer')).toMatchObject({ ok: true, to: 'settled' });
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
    const result = attempt('approved', 'issue', 'straitsx_admin');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/must be certified/);
  });

  it('will not settle a payable that has not matured', () => {
    expect(attempt('issued', 'settle', 'adata_preparer')).toMatchObject({ ok: false });
  });

  it('will not settle twice', () => {
    expect(attempt('settled', 'settle', 'adata_preparer')).toMatchObject({ ok: false });
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

/**
 * The approval queue asks the obligation who it is waiting for. PRD section 8
 * screen 3 shows certification and issuance status after approval, so the
 * question is live for four of the eight states and must answer honestly for
 * the other four rather than inventing an actor.
 */
describe('who the queue is waiting on', () => {
  it('names the next actor and the ask for each state a person moves', () => {
    expect(pendingStep('draft')).toEqual({
      event: 'submit',
      to: 'pending_approval',
      actors: ['adata_preparer'],
      action: 'submit it for approval',
    });
    expect(pendingStep('pending_approval')).toEqual({
      event: 'approve',
      to: 'approved',
      actors: ['adata_checker'],
      action: 'approve it',
    });
    expect(pendingStep('approved')).toEqual({
      event: 'certify',
      to: 'certified',
      actors: ['straitsx_admin'],
      action: 'certify it',
    });
    expect(pendingStep('certified')).toEqual({
      event: 'issue',
      to: 'issued',
      actors: ['straitsx_admin'],
      action: 'issue it to the supplier',
    });
  });

  it('prefers the settlement a person owes over the overdue mark the clock makes', () => {
    expect(pendingStep('matured')).toEqual({
      event: 'settle',
      to: 'settled',
      actors: ['adata_preparer'],
      action: 'settle it to the holders',
    });
  });

  it('waits on nobody where the clock moves it, it is finished, or recovery is out of scope', () => {
    expect(pendingStep('issued')).toBeNull();
    expect(pendingStep('settled')).toBeNull();
    expect(pendingStep('overdue')).toBeNull();
  });

  /**
   * The screen disables a button using `attempt` and explains it using
   * `pendingStep`. Two derivations of the same rule that disagree would show a
   * live button under a line saying someone else has to act.
   */
  it('agrees with the transition checker on who may act', () => {
    for (const status of LIFECYCLE_STATUSES) {
      const step = pendingStep(status);
      if (!step) continue;
      for (const role of ROLES) {
        expect(attempt(status, step.event, role).ok, `${role} on ${status}`).toBe(
          step.actors.includes(role),
        );
      }
    }
  });

  it('writes every role the way the PRD names it', () => {
    expect(ROLE_LABELS.adata_preparer).toBe('ADATA preparer');
    expect(ROLE_LABELS.adata_checker).toBe('ADATA checker');
    expect(ROLE_LABELS.straitsx_admin).toBe('StraitsX admin');
    expect(ROLES.filter((r) => !ROLE_LABELS[r])).toEqual([]);
  });
});
