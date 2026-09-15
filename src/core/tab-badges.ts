import { lifecycleActionHref, type NextActionSnapshot } from './next-action';

export type TabHref =
  | '/adata/approvals'
  | '/adata/settlement'
  | '/supplier'
  | '/supplier/offers'
  | '/admin/grading';

export type TabCounts = { readonly [H in TabHref]?: number };

const TAB_COUNTERS: readonly {
  readonly href: TabHref;
  readonly count: (snapshot: NextActionSnapshot) => number;
}[] = [
  {
    href: '/adata/approvals',
    count: (snapshot) =>
      snapshot.payables.filter((p) => lifecycleActionHref(p, snapshot.actor.role) === '/adata/approvals')
        .length,
  },
  {
    href: '/adata/settlement',
    count: (snapshot) => {
      const { role } = snapshot.actor;
      if (role !== 'adata_preparer' && role !== 'adata_checker') return 0;
      return snapshot.payables.filter((p) => p.status === 'matured' || p.status === 'overdue').length;
    },
  },
  {
    href: '/supplier',
    count: (snapshot) => {
      if (snapshot.actor.role !== 'supplier') return 0;
      return snapshot.holdings.filter((h) => h.receipt === 'pending').length;
    },
  },
  {
    href: '/supplier/offers',
    count: (snapshot) => {
      if (snapshot.actor.role !== 'supplier') return 0;
      return snapshot.listings
        .filter((l) => l.sellerWallet === snapshot.actor.wallet && l.bidCount > 0)
        .reduce((n, l) => n + l.bidCount, 0);
    },
  },
  {
    href: '/admin/grading',
    count: (snapshot) =>
      snapshot.payables.filter((p) => lifecycleActionHref(p, snapshot.actor.role) === '/admin/grading')
        .length,
  },
];

export function deriveTabCounts(snapshot: NextActionSnapshot): TabCounts {
  const counts: { [H in TabHref]?: number } = {};
  for (const { href, count } of TAB_COUNTERS) {
    const n = count(snapshot);
    if (n > 0) counts[href] = n;
  }
  return counts;
}
