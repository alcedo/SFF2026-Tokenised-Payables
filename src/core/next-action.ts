import { pendingStep, ROLE_LABELS, type LifecycleStatus, type ReceiptStatus, type Role } from './lifecycle';

export type NextAction =
  | { readonly kind: 'yours'; readonly verb: string; readonly href: string; readonly detail: string }
  | { readonly kind: 'waiting'; readonly heading: string; readonly detail: string }
  | { readonly kind: 'clear'; readonly heading: string; readonly detail?: string };

export interface NextActionActor {
  readonly role: Role;
  readonly name: string;
  readonly wallet: string;
}

export interface NextActionPayable {
  readonly id: string;
  readonly ref: string;
  readonly storedStatus: LifecycleStatus;
  readonly status: LifecycleStatus;
  readonly daysRemaining: number;
  readonly grade: string | null;
}

export interface NextActionHolding {
  readonly receipt: ReceiptStatus;
  readonly freeBase: bigint;
  readonly payable: {
    readonly id: string;
    readonly ref: string;
    readonly status: LifecycleStatus;
    readonly daysRemaining: number;
  };
}

export interface NextActionListing {
  readonly id: string;
  readonly targetRef: string;
  readonly sellerWallet: string;
  readonly bidCount: number;
}

export interface NextActionSnapshot {
  readonly actor: NextActionActor;
  readonly payables: readonly NextActionPayable[];
  readonly holdings: readonly NextActionHolding[];
  readonly listings: readonly NextActionListing[];
}

export type NextActionSource = (snapshot: NextActionSnapshot) => NextAction | null;

function yours(verb: string, href: string, detail: string): NextAction {
  return { kind: 'yours', verb, href, detail };
}

export function sourcePendingReceipt(snapshot: NextActionSnapshot): NextAction | null {
  if (snapshot.actor.role !== 'supplier') return null;
  const holding = snapshot.holdings.find((h) => h.receipt === 'pending');
  if (!holding) return null;
  return yours(
    `Accept ${holding.payable.ref}`,
    '/supplier',
    'ADATA has issued this payable to your wallet. Accept it before you can hold or sell it.',
  );
}

export function lifecycleActionHref(
  payable: NextActionPayable,
  role: Role,
): '/adata/approvals' | '/admin/grading' | null {
  const { storedStatus } = payable;
  if (
    storedStatus !== 'draft' &&
    storedStatus !== 'pending_approval' &&
    storedStatus !== 'approved' &&
    storedStatus !== 'certified'
  ) {
    return null;
  }
  const step = pendingStep(storedStatus);
  if (!step || !step.actors.includes(role)) return null;
  if (storedStatus === 'approved' && role === 'straitsx_admin') return '/admin/grading';
  return '/adata/approvals';
}

export function sourceLifecycleYours(snapshot: NextActionSnapshot): NextAction | null {
  const { role } = snapshot.actor;
  for (const payable of snapshot.payables) {
    const href = lifecycleActionHref(payable, role);
    if (href === null) continue;
    if (payable.storedStatus === 'approved' && payable.grade === null) {
      return yours(
        `Grade ${payable.ref}`,
        href,
        'Assign a sample grade, then certify it under the programme.',
      );
    }
    const step = pendingStep(payable.storedStatus);
    if (!step) continue;
    const verb =
      payable.storedStatus === 'draft'
        ? `Submit ${payable.ref}`
        : payable.storedStatus === 'pending_approval'
          ? `Approve ${payable.ref}`
          : payable.storedStatus === 'approved'
            ? `Certify ${payable.ref}`
            : `Issue ${payable.ref}`;
    return yours(verb, href, `Next step: ${step.action}.`);
  }
  return null;
}

export function sourceSettlementDue(snapshot: NextActionSnapshot): NextAction | null {
  // app.lifecycle_edge names one role for issued -> settled, and pendingStep
  // carries it, so this reads the same table the settlement button is disabled
  // by rather than repeating the pair.
  const settle = pendingStep('matured');
  if (!settle || !settle.actors.includes(snapshot.actor.role)) return null;
  const due = snapshot.payables.filter((p) => p.status === 'matured' || p.status === 'overdue');
  if (due.length === 0) return null;
  const verb = due.length === 1 ? `Fund settlement of ${due[0]!.ref}` : `Fund settlement of ${due.length} payables`;
  return yours(verb, '/adata/settlement', 'Maturity does not pay anyone. Settlement is an explicit act.');
}

export function sourceSupplierOffers(snapshot: NextActionSnapshot): NextAction | null {
  if (snapshot.actor.role !== 'supplier') return null;
  const withBids = snapshot.listings.filter(
    (l) => l.sellerWallet === snapshot.actor.wallet && l.bidCount > 0,
  );
  if (withBids.length === 0) return null;
  const bids = withBids.reduce((n, l) => n + l.bidCount, 0);
  const noun = bids === 1 ? 'offer' : 'offers';
  return yours(
    `Review ${bids} ${noun}`,
    '/supplier/offers',
    'Accepting one offer settles the trade and expires the rest on that listing.',
  );
}

export function sourceSupplierFinance(snapshot: NextActionSnapshot): NextAction | null {
  if (snapshot.actor.role !== 'supplier') return null;
  const holding = snapshot.holdings.find(
    (h) => h.receipt === 'accepted' && h.freeBase > 0n && h.payable.daysRemaining > 0,
  );
  if (!holding) return null;
  return yours(
    `Request financing on ${holding.payable.ref}`,
    `/supplier/finance/${holding.payable.id}`,
    'List some or all of the free quantity. You choose the ask.',
  );
}

export function sourceLenderReview(snapshot: NextActionSnapshot): NextAction | null {
  if (snapshot.actor.role !== 'lender') return null;
  const lot = snapshot.listings[0];
  if (!lot) return null;
  return yours(
    `Review ${lot.targetRef}`,
    `/lender/${lot.id}`,
    'Open lots are sorted for you on the marketplace. Start with this one.',
  );
}

export function sourceCreatePayable(snapshot: NextActionSnapshot): NextAction | null {
  if (snapshot.actor.role !== 'adata_preparer') return null;
  return yours(
    'Create a payable',
    '/adata/create',
    'Import an approved invoice from the ERP, or enter one by hand.',
  );
}

export function sourceLifecycleWaiting(snapshot: NextActionSnapshot): NextAction | null {
  for (const payable of snapshot.payables) {
    const step = pendingStep(payable.storedStatus);
    if (!step) continue;
    if (step.actors.includes(snapshot.actor.role)) continue;
    const holders = step.actors.map((role) => ROLE_LABELS[role]).join(' or ');
    return {
      kind: 'waiting',
      heading: `Waiting on ${holders}`,
      detail: `${holders} must ${step.action} (${payable.ref}). Switch persona in the demo controls to act as them.`,
    };
  }
  return null;
}

export const NEXT_ACTION_SOURCES: readonly NextActionSource[] = [
  sourcePendingReceipt,
  sourceLifecycleYours,
  sourceSettlementDue,
  sourceSupplierOffers,
  sourceSupplierFinance,
  sourceLenderReview,
  sourceCreatePayable,
  sourceLifecycleWaiting,
];

function clearFor(role: Role): NextAction {
  switch (role) {
    case 'adata_preparer':
    case 'adata_checker':
      return { kind: 'clear', heading: 'Nothing is waiting on you.', detail: 'Create a payable, or open Explorer to show the trail.' };
    case 'supplier':
      return { kind: 'clear', heading: 'Nothing is waiting on you.', detail: 'Hold to maturity, or open Explorer to show the trail.' };
    case 'lender':
      return { kind: 'clear', heading: 'No lots are listed right now.', detail: 'A supplier lists a payable from Request financing.' };
    case 'straitsx_admin':
      return { kind: 'clear', heading: 'Programme is current.', detail: 'Open Explorer to show the trail, or Accounts to add a user.' };
  }
}

export function deriveNextAction(snapshot: NextActionSnapshot): NextAction {
  const produced: NextAction[] = [];
  for (const source of NEXT_ACTION_SOURCES) {
    const action = source(snapshot);
    if (action) produced.push(action);
  }
  const yoursAction = produced.find((a) => a.kind === 'yours');
  if (yoursAction) return yoursAction;
  const waiting = produced.find((a) => a.kind === 'waiting');
  if (waiting) return waiting;
  return clearFor(snapshot.actor.role);
}
