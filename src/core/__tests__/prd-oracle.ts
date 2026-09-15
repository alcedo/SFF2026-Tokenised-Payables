import type { LifecycleEvent, LifecycleStatus, Role } from '../lifecycle';

export interface PrdEdge {
  readonly event: LifecycleEvent;
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  /** Empty means the demo clock fires it; any role may call `attempt`. */
  readonly actors: readonly Role[];
}

export const PRD_EDGES: readonly PrdEdge[] = [
  { event: 'submit', from: 'draft', to: 'pending_approval', actors: ['adata_preparer'] },
  { event: 'approve', from: 'pending_approval', to: 'approved', actors: ['adata_checker'] },
  { event: 'certify', from: 'approved', to: 'certified', actors: ['straitsx_admin'] },
  {
    event: 'issue',
    from: 'certified',
    to: 'issued',
    actors: ['adata_preparer', 'adata_checker', 'straitsx_admin'],
  },
  { event: 'mature', from: 'issued', to: 'matured', actors: [] },
  { event: 'settle', from: 'matured', to: 'settled', actors: ['adata_preparer', 'adata_checker'] },
  { event: 'mark_overdue', from: 'matured', to: 'overdue', actors: [] },
];

export const PRD_HAPPY_PATH: readonly LifecycleEvent[] = [
  'submit',
  'approve',
  'certify',
  'issue',
  'mature',
  'settle',
];

export function prdAttempt(
  from: LifecycleStatus,
  event: LifecycleEvent,
  actor: Role,
): { ok: true; to: LifecycleStatus } | { ok: false } {
  const edge = PRD_EDGES.find((e) => e.event === event);
  if (!edge || edge.from !== from) return { ok: false };
  if (edge.actors.length > 0 && !edge.actors.includes(actor)) return { ok: false };
  return { ok: true, to: edge.to };
}

export type Receipt = 'pending' | 'accepted' | 'rejected';

export function prdCanTrade(status: LifecycleStatus, receipt: Receipt): boolean {
  return status === 'issued' && receipt === 'accepted';
}
