'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { advanceClock, jumpToNextMaturity, switchPersona, topUp } from '@/app/actions';
import { parseAmount } from '@/core/input';
import { ASSETS } from '@/core/money';

export interface PersonaOption {
  userId: string;
  name: string;
  role: string;
  entityName: string;
  wallet: string;
}

const ROLE_LABEL: Record<string, string> = {
  adata_preparer: 'ADATA · preparer',
  adata_checker: 'ADATA · checker',
  supplier: 'Supplier',
  lender: 'Lender',
  straitsx_admin: 'StraitsX admin',
};

export function DemoControls({
  personas,
  current,
  worldDate,
  offsetDays,
}: {
  personas: PersonaOption[];
  current: PersonaOption;
  worldDate: string;
  offsetDays: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);

  function act(fn: () => Promise<{ message: string } | void>) {
    setNote(null);
    startTransition(async () => {
      const result = await fn();
      if (result && 'message' in result) setNote(result.message);
      router.refresh();
    });
  }

  return (
    <div className="border-b border-rule-strong bg-surface-raised">
      <div className="chrome-tools mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
        <span className="font-semibold tracking-[0.04em] text-ink-muted uppercase">
          Demo controls
        </span>

        <label className="control-fit flex items-center gap-1.5">
          <span className="shrink-0 text-ink-muted">Acting as</span>
          <select
            aria-label="Switch persona"
            className="control-fit"
            value={current.userId}
            disabled={pending}
            onChange={(e) => {
              const id = e.target.value;
              act(async () => {
                await switchPersona(id);
              });
            }}
          >
            {personas.map((p) => (
              <option key={p.userId} value={p.userId}>
                {ROLE_LABEL[p.role] ?? p.role} — {p.name}, {p.entityName}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="num font-medium" title="The demo clock">
            {worldDate}
          </span>
          <span className="text-ink-faint">
            {offsetDays === 0 ? 'T0' : `T0 + ${offsetDays}d`}
          </span>
          <button
            type="button"
            disabled={pending}
            className="chrome-tools-btn"
            onClick={() => act(() => advanceClock(1))}
          >
            +1d
          </button>
          <button
            type="button"
            disabled={pending}
            className="chrome-tools-btn"
            onClick={() => act(() => advanceClock(30))}
          >
            +30d
          </button>
          <button
            type="button"
            disabled={pending}
            className="chrome-tools-btn"
            onClick={() => act(() => jumpToNextMaturity())}
          >
            Next maturity
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={pending}
            className="chrome-tools-btn"
            onClick={() => setTopUpOpen((v) => !v)}
          >
            Simulate top-up
          </button>

          <a href="/onboarding" className="chrome-tools-btn">
            New account
          </a>

          <a href="/overdue" className="chrome-tools-btn is-caution">
            Trigger overdue
          </a>

          {current.role === 'straitsx_admin' ? (
            <a href="/reset" className="chrome-tools-btn is-critical">
              Reset world
            </a>
          ) : null}
        </div>

        {pending ? <span className="text-ink-faint">working…</span> : null}
        {note ? <span className="text-ink-muted">{note}</span> : null}
      </div>

      {topUpOpen ? (
        <TopUpPanel
          personas={personas}
          current={current}
          onDone={(message) => {
            setNote(message);
            setTopUpOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function TopUpPanel({
  personas,
  current,
  onDone,
}: {
  personas: PersonaOption[];
  current: PersonaOption;
  onDone: (message: string) => void;
}) {
  const [wallet, setWallet] = useState(current.wallet);
  const [asset, setAsset] = useState<string>('XUSD');
  const [amount, setAmount] = useState('100000');
  const [pending, startTransition] = useTransition();

  return (
    <div className="border-t border-rule bg-surface">
      <div className="chrome-topup mx-auto flex max-w-[1600px] flex-wrap items-end gap-3 px-3 py-2">
        <label className="flex flex-col gap-0.5">
          <span className="tracking-wide text-ink-muted uppercase">Wallet</span>
          <select value={wallet} onChange={(e) => setWallet(e.target.value)}>
            {personas.map((p) => (
              <option key={p.userId} value={p.wallet}>
                {p.entityName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="tracking-wide text-ink-muted uppercase">Asset</span>
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="tracking-wide text-ink-muted uppercase">Amount</span>
          <input
            className="num w-40"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={pending}
          className="chrome-topup-submit"
          onClick={() =>
            startTransition(async () => {
              const parsed = parseAmount(amount);
              if (!parsed.ok) {
                onDone(parsed.reason);
                return;
              }
              const result = await topUp(wallet, asset, parsed.value.toString());
              onDone(result.message);
            })
          }
        >
          Add balance
        </button>
        <p className="text-ink-faint">
          Demo-only. Adds a simulated balance and records a mock transaction receipt.
        </p>
      </div>
    </div>
  );
}
