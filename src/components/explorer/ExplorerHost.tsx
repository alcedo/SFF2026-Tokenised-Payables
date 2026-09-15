'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { loadExplorerLog, loadSimulatedReceipt } from '@/app/explorer-data';
import { applyLedgerView, parseLedgerSearch, transition } from '@/core/ledger-view';
import type { SerialEventRow, SerialReceipt } from '@/db/read';
import { ExplorerLogPanel } from './ExplorerLogPanel';
import { ExplorerReceiptPanel } from './ExplorerReceiptPanel';

function ExplorerDialog() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = parseLedgerSearch(params);
  const dialog = useRef<HTMLDialogElement>(null);
  const [log, setLog] = useState<{
    events: SerialEventRow[];
    bookDrift: number;
    worldDate: string;
    epoch: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<SerialReceipt | null | undefined>(undefined);

  function go(next: ReturnType<typeof transition>) {
    const href = applyLedgerView(new URLSearchParams(params.toString()), next).toString();
    router.replace(href === '' ? pathname : `${pathname}?${href}`, { scroll: false });
  }

  const txHash = view.mode === 'receipt' ? view.txHash : null;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (view.mode === 'closed') {
      if (el.open) el.close();
      return;
    }
    if (!el.open) el.showModal();
  }, [view.mode]);

  useEffect(() => {
    if (view.mode === 'closed') return;
    let cancelled = false;
    void loadExplorerLog().then((data) => {
      if (cancelled) return;
      setLog({
        events: data.events,
        bookDrift: data.totals.bookDrift,
        worldDate: data.worldDate,
        epoch: data.epoch,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [view.mode]);

  useEffect(() => {
    if (txHash === null) {
      setReceipt(undefined);
      return;
    }
    let cancelled = false;
    setReceipt(undefined);
    void loadSimulatedReceipt(txHash).then((data) => {
      if (!cancelled) setReceipt(data);
    });
    return () => {
      cancelled = true;
    };
  }, [txHash]);

  const backHref = `?${applyLedgerView(new URLSearchParams(params.toString()), { mode: 'log' }).toString()}`;
  const title = view.mode === 'receipt' ? 'Transaction' : 'Explorer';

  return (
    <dialog
      ref={dialog}
      className="explorer-overlay"
      onClose={() => {
        if (view.mode !== 'closed') go(transition(view, { type: 'close' }));
      }}
    >
      {view.mode === 'closed' ? null : (
        <div className="flex max-h-[min(90vh,840px)] w-full flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-rule px-3 py-2">
            <h2 className="text-[13px] font-semibold tracking-wide text-ink uppercase">{title}</h2>
            <button
              type="button"
              className="text-[12px] text-ink-muted hover:text-ink hover:underline"
              onClick={() => go(transition(view, { type: 'close' }))}
            >
              Close
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {view.mode === 'log' ? (
              log ? (
                <ExplorerLogPanel
                  events={log.events}
                  bookDrift={log.bookDrift}
                  worldDate={log.worldDate}
                  epoch={log.epoch}
                />
              ) : (
                <p className="text-[12px] text-ink-muted">Loading the transaction log…</p>
              )
            ) : receipt === undefined ? (
              <p className="text-[12px] text-ink-muted">Loading receipt…</p>
            ) : (
              <ExplorerReceiptPanel receipt={receipt} txHash={view.txHash} backHref={backHref} />
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

export function ExplorerHost() {
  return (
    <Suspense fallback={null}>
      <ExplorerDialog />
    </Suspense>
  );
}
