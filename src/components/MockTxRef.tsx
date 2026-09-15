'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ledgerHref } from '@/core/ledger-view';

function MockTxLook({ hash, block }: { hash: string; block?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="addr">{hash.length > 13 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash}</span>
      {block !== undefined ? <span className="text-[10px] text-ink-faint">block {block}</span> : null}
      <span className="rounded-[3px] border border-caution/30 bg-caution-soft px-1 py-px text-[10px] font-medium text-caution">
        Simulated
      </span>
    </span>
  );
}

function MockTxLink({ hash, block }: { hash: string; block?: number }) {
  const params = useSearchParams();
  const href = ledgerHref(params, { mode: 'receipt', txHash: hash });
  return (
    <Link href={href} scroll={false} className="inline-flex items-center gap-1.5 hover:underline">
      <MockTxLook hash={hash} block={block} />
    </Link>
  );
}

export function MockTxRef({ hash, block }: { hash: string; block?: number }) {
  return (
    <Suspense fallback={<MockTxLook hash={hash} block={block} />}>
      <MockTxLink hash={hash} block={block} />
    </Suspense>
  );
}
