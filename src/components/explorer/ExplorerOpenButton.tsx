'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ledgerHref } from '@/core/ledger-view';

function ExplorerOpenLink() {
  const params = useSearchParams();
  const href = ledgerHref(params, { mode: 'log' });
  return (
    <Link
      href={href}
      scroll={false}
      className="rounded-[3px] border border-rule-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-surface-sunken"
    >
      Explorer
    </Link>
  );
}

export function ExplorerOpenButton() {
  return (
    <Suspense
      fallback={
        <span className="rounded-[3px] border border-rule-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-ink">
          Explorer
        </span>
      }
    >
      <ExplorerOpenLink />
    </Suspense>
  );
}
