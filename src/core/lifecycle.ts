/**
 * The payable obligation lifecycle. PRD section 7.
 *
 *   Draft -> Pending approval -> Approved -> Certified -> Issued -> Matured -> Settled
 *                                                                     |
 *                                                                     +-> Overdue
 *
 * PRD section 7 opens by insisting the obligation lifecycle is separate from
 * market activity and ownership history. That separation is structural here:
 * this module knows nothing about listings or bids, and market status is
 * derived from whether an active listing exists rather than stored as a second
 * field that must be kept in sync with this one.
 *
 * Transitions live in one table. Adding a state without saying who may move it
 * and from where is a compile error, which is the point.
 */

/** Who is acting. PRD section 5. */
export const ROLES = [
  'adata_preparer',
  'adata_checker',
  'supplier',
  'lender',
  'straitsx_admin',
] as const;
export type Role = (typeof ROLES)[number];

export const LIFECYCLE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'certified',
  'issued',
  'matured',
  'settled',
  'overdue',
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const LIFECYCLE_EVENTS = [
  'submit',
  'approve',
  'certify',
  'issue',
  'mature',
  'settle',
  'mark_overdue',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

interface Transition {
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  /**
   * Roles permitted to fire this event. The demo clock fires `mature` with no
   * human actor, so that row is empty and is driven by {@link dueStatusFor}.
   */
  readonly actors: readonly Role[];
  readonly label: string;
}

/**
 * The complete transition table.
 *
 * Maker-checker is enforced here as a role split (`adata_preparer` submits,
 * `adata_checker` approves) but the PRD also requires the two to be different
 * people, not merely different roles. That second half is an identity check the
 * caller performs, since this table sees roles rather than users.
 */
export const TRANSITIONS: Readonly<Record<LifecycleEvent, Transition>> = {
  submit: {
    from: 'draft',
    to: 'pending_approval',
    actors: ['adata_preparer'],
    label: 'Submitted for approval',
  },
  approve: {
    from: 'pending_approval',
    to: 'approved',
    actors: ['adata_checker'],
    label: 'Approved by ADATA checker',
  },
  certify: {
    from: 'approved',
    to: 'certified',
    actors: ['straitsx_admin'],
    label: 'Certified and graded by StraitsX',
  },
  issue: {
    from: 'certified',
    to: 'issued',
    actors: ['adata_preparer', 'adata_checker', 'straitsx_admin'],
    label: 'Issued to supplier wallet',
  },
  mature: {
    from: 'issued',
    to: 'matured',
    actors: [],
    label: 'Reached maturity',
  },
  settle: {
    from: 'matured',
    to: 'settled',
    actors: ['adata_preparer', 'adata_checker'],
    label: 'Settled to holders',
  },
  mark_overdue: {
    from: 'matured',
    to: 'overdue',
    actors: [],
    label: 'Passed due date unpaid',
  },
};

/** States from which nothing further can happen. PRD section 7. */
const TERMINAL: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['settled']);

export function isTerminal(status: LifecycleStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Whether tokens may move. PRD section 7: "each holder may hold, list, sell, or
 * transfer any quantity they own, up to their balance, before maturity."
 *
 * Maturity expires listings and bids, so only `issued` permits market activity.
 */
export function isTradeable(status: LifecycleStatus): boolean {
  return status === 'issued';
}

/** Whether the obligation is awaiting or has received its maturity payment. */
export function isDue(status: LifecycleStatus): boolean {
  return status === 'matured' || status === 'overdue';
}

export type TransitionResult =
  | { readonly ok: true; readonly to: LifecycleStatus; readonly label: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Check one transition.
 *
 * Returns a result rather than throwing because every caller is an API route
 * that must turn a refusal into inline feedback (PRD section 14), and an
 * exception would erase the reason on the way up.
 */
export function attempt(
  from: LifecycleStatus,
  event: LifecycleEvent,
  actor: Role,
): TransitionResult {
  const transition = TRANSITIONS[event];
  if (transition.from !== from) {
    return {
      ok: false,
      reason: `cannot ${event} a payable that is ${from.replace(/_/g, ' ')}; it must be ${transition.from.replace(/_/g, ' ')}`,
    };
  }
  if (transition.actors.length > 0 && !transition.actors.includes(actor)) {
    return { ok: false, reason: `${actor.replace(/_/g, ' ')} may not ${event} a payable` };
  }
  return { ok: true, to: transition.to, label: transition.label };
}

/**
 * What the clock says the status should be, independent of who has acted.
 *
 * PRD section 7: "Matured: the payable is due, regardless of who holds it or
 * whether it was ever financed." Maturity is a function of time, so it is
 * derived here rather than waiting for someone to press a button. Advancing the
 * clock does not fund the obligation, so a matured payable stays matured until
 * ADATA settles it.
 */
export function dueStatusFor(current: LifecycleStatus, daysRemaining: number): LifecycleStatus {
  if (current !== 'issued') return current;
  return daysRemaining <= 0 ? 'matured' : 'issued';
}

/**
 * Whether a matured obligation has sat unpaid long enough to read as overdue.
 *
 * PRD section 7 defines overdue as "an unpaid obligation has passed its due
 * date" and section 11 provides a demo control to trigger the example case
 * directly, so the grace period is a presentation threshold rather than a
 * contractual term.
 */
export const OVERDUE_GRACE_DAYS = 0;

export function isOverdueByClock(status: LifecycleStatus, daysRemaining: number): boolean {
  return status === 'matured' && daysRemaining < -OVERDUE_GRACE_DAYS;
}

/**
 * Whether the supplier has taken delivery of the payable they were issued.
 *
 * PRD section 3 question 7 gives the supplier "an option to accept the
 * tokenised payable or reject it", but the section 7 lifecycle has no state for
 * it and the PRD never says what a rejection does to the obligation. Modelling
 * acceptance as receipt state on the first holding rather than as a lifecycle
 * state keeps the two questions separate and leaves the obligation diagram
 * exactly as the PRD draws it. See docs/ASSUMPTIONS.md for the rejection rule.
 */
export const RECEIPT_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * A supplier may only trade what they have accepted. PRD section 8 screen 6
 * presents the inbox and holdings together, so an unaccepted payable is visible
 * but not yet actionable.
 */
export function canTradeReceipt(receipt: ReceiptStatus): boolean {
  return receipt === 'accepted';
}

/** Human labels for the status chips. */
export const STATUS_LABELS: Readonly<Record<LifecycleStatus, string>> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  certified: 'Certified',
  issued: 'Issued',
  matured: 'Matured',
  settled: 'Settled',
  overdue: 'Overdue',
};
