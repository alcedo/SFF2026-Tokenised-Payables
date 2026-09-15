import { describe, expect, it } from 'vitest';

import {
  deriveNextAction,
  type NextActionSnapshot,
  sourceCreatePayable,
  sourceLifecycleWaiting,
} from '../next-action';
import type { Role } from '../lifecycle';

function actor(role: Role, wallet = '0xsupplier'): NextActionSnapshot['actor'] {
  return { role, name: 'Test', wallet };
}

function empty(role: Role): NextActionSnapshot {
  return { actor: actor(role), payables: [], holdings: [], listings: [] };
}

describe('deriveNextAction', () => {
  it('asks a supplier to accept a pending receipt', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('supplier'),
      payables: [],
      holdings: [
        {
          receipt: 'pending',
          freeBase: 100n,
          payable: { id: 'p1', ref: 'TP-2026-0141', status: 'issued', daysRemaining: 40 },
        },
      ],
      listings: [],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Accept TP-2026-0141',
      href: '/supplier',
      detail: 'ADATA has issued this payable to your wallet. Accept it before you can hold or sell it.',
    });
  });

  it('asks the checker to approve the payable that is waiting on them', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('adata_checker'),
      payables: [
        {
          id: 'p1',
          ref: 'TP-2026-0200',
          storedStatus: 'pending_approval',
          status: 'pending_approval',
          daysRemaining: 90,
          grade: null,
        },
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Approve TP-2026-0200',
      href: '/adata/approvals',
      detail: 'Next step: approve it.',
    });
  });

  it('sends ADATA to settlement when a payable is due, before create-payable', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('adata_preparer'),
      payables: [
        {
          id: 'p1',
          ref: 'TP-2026-0119',
          storedStatus: 'issued',
          status: 'overdue',
          daysRemaining: -45,
          grade: 'A',
        },
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Fund settlement of TP-2026-0119',
      href: '/adata/settlement',
      detail: 'Maturity does not pay anyone. Settlement is an explicit act.',
    });
  });

  it('asks a supplier to review offers when a listing has bids', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('supplier', '0xseller'),
      payables: [],
      holdings: [
        {
          receipt: 'accepted',
          freeBase: 0n,
          payable: { id: 'p1', ref: 'TP-2026-0142', status: 'issued', daysRemaining: 60 },
        },
      ],
      listings: [{ id: 'l1', targetRef: 'TP-2026-0142', sellerWallet: '0xseller', bidCount: 2 }],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Review 2 offers',
      href: '/supplier/offers',
      detail: 'Accepting one offer settles the trade and expires the rest on that listing.',
    });
  });

  it('asks a lender to review the first open lot', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('lender'),
      payables: [
        {
          id: 'p-overdue',
          ref: 'TP-2026-0119',
          storedStatus: 'issued',
          status: 'overdue',
          daysRemaining: -45,
          grade: 'A',
        },
      ],
      holdings: [],
      listings: [{ id: 'lot-1', targetRef: 'TP-2026-0143', sellerWallet: '0xseller', bidCount: 0 }],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Review TP-2026-0143',
      href: '/lender/lot-1',
      detail: 'Open lots are sorted for you on the marketplace. Start with this one.',
    });
  });

  it('sends the admin to the approval queue to issue a certified payable', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('straitsx_admin'),
      payables: [
        {
          id: 'p1',
          ref: 'TP-2026-0203',
          storedStatus: 'certified',
          status: 'certified',
          daysRemaining: 70,
          grade: 'A',
        },
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Issue TP-2026-0203',
      href: '/adata/approvals',
      detail: 'Next step: issue it to the supplier.',
    });
  });

  it('asks the admin to grade an approved payable that has no grade', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('straitsx_admin'),
      payables: [
        {
          id: 'p1',
          ref: 'TP-2026-0201',
          storedStatus: 'approved',
          status: 'approved',
          daysRemaining: 80,
          grade: null,
        },
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'yours',
      verb: 'Grade TP-2026-0201',
      href: '/admin/grading',
      detail: 'Assign a sample grade, then certify it under the programme.',
    });
  });

  it('falls back to create-payable for a preparer with an empty queue', () => {
    expect(deriveNextAction(empty('adata_preparer'))).toEqual({
      kind: 'yours',
      verb: 'Create a payable',
      href: '/adata/create',
      detail: 'Import an approved invoice from the ERP, or enter one by hand.',
    });
  });

  it('tells a checker who is waiting on the preparer', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('adata_checker'),
      payables: [
        {
          id: 'p1',
          ref: 'TP-2026-0202',
          storedStatus: 'draft',
          status: 'draft',
          daysRemaining: 90,
          grade: null,
        },
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveNextAction(snapshot)).toEqual({
      kind: 'waiting',
      heading: 'Waiting on ADATA preparer',
      detail:
        'ADATA preparer must submit it for approval (TP-2026-0202). Switch persona in the demo controls to act as them.',
    });
  });

  it('clears for an admin when nothing is in flight', () => {
    expect(deriveNextAction(empty('straitsx_admin'))).toEqual({
      kind: 'clear',
      heading: 'Programme is current.',
      detail: 'Open Explorer to show the trail, or Accounts to add a user.',
    });
  });
});

describe('source isolation', () => {
  it('create-payable is only a preparer source', () => {
    expect(sourceCreatePayable(empty('adata_checker'))).toBeNull();
    expect(sourceLifecycleWaiting(empty('adata_checker'))).toBeNull();
  });
});
