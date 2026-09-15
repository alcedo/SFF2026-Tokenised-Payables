import { describe, expect, it } from 'vitest';

import type { NextActionHolding, NextActionPayable, NextActionSnapshot } from '../next-action';
import type { Role } from '../lifecycle';
import { deriveTabCounts, tabCount } from '../tab-badges';

function actor(role: Role, wallet = '0xsupplier'): NextActionSnapshot['actor'] {
  return { role, name: 'Test', wallet };
}

function empty(role: Role): NextActionSnapshot {
  return { actor: actor(role), payables: [], holdings: [], listings: [] };
}

function payable(
  partial: Pick<NextActionPayable, 'id' | 'ref' | 'storedStatus'> & Partial<NextActionPayable>,
): NextActionPayable {
  return {
    status: partial.storedStatus,
    daysRemaining: 90,
    grade: null,
    ...partial,
  };
}

function pendingHolding(id: string, ref: string): NextActionHolding {
  return {
    receipt: 'pending',
    freeBase: 100n,
    payable: { id, ref, status: 'issued', daysRemaining: 40 },
  };
}

describe('deriveTabCounts', () => {
  it('hides every badge for an empty preparer, including create-payable', () => {
    expect(deriveTabCounts(empty('adata_preparer'))).toEqual({});
  });

  it('counts each pending_approval payable on the approval queue', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('adata_checker'),
      payables: [
        payable({ id: 'p1', ref: 'TP-1', storedStatus: 'pending_approval' }),
        payable({ id: 'p2', ref: 'TP-2', storedStatus: 'pending_approval' }),
        payable({ id: 'p3', ref: 'TP-3', storedStatus: 'pending_approval' }),
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveTabCounts(snapshot)).toEqual({ '/adata/approvals': 3 });
  });

  it('splits a draft and a clock-overdue issued payable across approvals and settlement', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('adata_preparer'),
      payables: [
        payable({ id: 'p1', ref: 'TP-DRAFT', storedStatus: 'draft' }),
        payable({
          id: 'p2',
          ref: 'TP-OVERDUE',
          storedStatus: 'issued',
          status: 'overdue',
          daysRemaining: -45,
          grade: 'A',
        }),
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveTabCounts(snapshot)).toEqual({
      '/adata/approvals': 1,
      '/adata/settlement': 1,
    });
  });

  it('gives the checker no badge on approved ungraded paper', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('adata_checker'),
      payables: [
        payable({ id: 'p1', ref: 'TP-APPROVED', storedStatus: 'approved', grade: null }),
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveTabCounts(snapshot)).toEqual({});
  });

  it('sends admin grade and certify to grading, and certified issue to approvals', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('straitsx_admin'),
      payables: [
        payable({ id: 'p1', ref: 'TP-UNGRADED', storedStatus: 'approved', grade: null }),
        payable({ id: 'p2', ref: 'TP-GRADED', storedStatus: 'approved', grade: 'A' }),
        payable({ id: 'p3', ref: 'TP-CERT', storedStatus: 'certified', grade: 'A' }),
      ],
      holdings: [],
      listings: [],
    };
    expect(deriveTabCounts(snapshot)).toEqual({
      '/admin/grading': 2,
      '/adata/approvals': 1,
    });
  });

  it('counts pending receipts on the supplier inbox', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('supplier'),
      payables: [],
      holdings: [pendingHolding('p1', 'TP-1'), pendingHolding('p2', 'TP-2')],
      listings: [],
    };
    expect(deriveTabCounts(snapshot)).toEqual({ '/supplier': 2 });
  });

  it('sums bidCount on the seller wallet listings, not the listing count', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('supplier', '0xseller'),
      payables: [],
      holdings: [],
      listings: [{ id: 'l1', targetRef: 'TP-2026-0142', sellerWallet: '0xseller', bidCount: 2 }],
    };
    expect(deriveTabCounts(snapshot)).toEqual({ '/supplier/offers': 2 });
  });

  it('does not badge the marketplace for a lender with open lots', () => {
    const snapshot: NextActionSnapshot = {
      actor: actor('lender'),
      payables: [],
      holdings: [],
      listings: [{ id: 'lot-1', targetRef: 'TP-2026-0143', sellerWallet: '0xseller', bidCount: 0 }],
    };
    expect(deriveTabCounts(snapshot)).toEqual({});
  });

  it('hides every badge for an empty admin', () => {
    expect(deriveTabCounts(empty('straitsx_admin'))).toEqual({});
  });

  it('looks up a count by href and ignores tabs that cannot badge', () => {
    const counts = deriveTabCounts({
      actor: actor('adata_checker'),
      payables: [
        payable({
          id: 'p1',
          ref: 'TP-OVERDUE',
          storedStatus: 'issued',
          status: 'overdue',
          daysRemaining: -1,
          grade: 'A',
        }),
      ],
      holdings: [],
      listings: [],
    });
    expect(tabCount(counts, '/adata/settlement')).toBe(1);
    expect(tabCount(counts, '/adata')).toBeUndefined();
    expect(tabCount(counts, '/adata/create')).toBeUndefined();
  });
});
