'use client';

/**
 * The persistent demo-controls bar. PRD §11.
 *
 * Everything here changes the shared world, so each control says what it
 * affects before it does it. "Reset world" in particular asks first, because
 * the PRD notes the world is shared and a reset lands on every connected
 * session, including a second screen someone else is presenting from.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { advanceClock, jumpToNextMaturity, switchPersona, topUp } from '@/app/actions';
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
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-1.5">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
          Demo controls
        </span>

        {/* Persona switcher. PRD §11 includes preparer/checker within ADATA. */}
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-muted">Acting as</span>
          <select
            aria-label="Switch persona"
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-1 text-[12px]"
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

        <span className="h-4 w-px bg-rule-strong" />

        {/* Fast-forward. Advancing time never funds an obligation (PRD §11). */}
        <div className="flex items-center gap-1.5">
          <span className="num text-[12px] font-medium" title="The demo clock">
            {worldDate}
          </span>
          <span className="text-[11px] text-ink-faint">
            {offsetDays === 0 ? 'T0' : `T0 + ${offsetDays}d`}
          </span>
          <button
            type="button"
            disabled={pending}
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-0.5 text-[11px] hover:bg-surface-sunken disabled:opacity-50"
            onClick={() => act(() => advanceClock(1))}
          >
            +1d
          </button>
          <button
            type="button"
            disabled={pending}
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-0.5 text-[11px] hover:bg-surface-sunken disabled:opacity-50"
            onClick={() => act(() => advanceClock(30))}
          >
            +30d
          </button>
          <button
            type="button"
            disabled={pending}
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-0.5 text-[11px] hover:bg-surface-sunken disabled:opacity-50"
            onClick={() => act(() => jumpToNextMaturity())}
          >
            Next maturity
          </button>
        </div>

        <span className="h-4 w-px bg-rule-strong" />

        <button
          type="button"
          disabled={pending}
          className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-0.5 text-[11px] hover:bg-surface-sunken disabled:opacity-50"
          onClick={() => setTopUpOpen((v) => !v)}
        >
          Simulate top-up
        </button>

        {/*
          PRD §11 "Trigger overdue": open or activate the designated overdue
          example without requiring a live default workflow. The seeded case is
          already past due at T0, so triggering it means opening it rather than
          manufacturing a default, which is exactly what §7 asks for when it
          calls recovery "a read-only scenario, not an operational workflow".
        */}
        <a
          href="/overdue"
          className="rounded-[3px] border border-caution/30 bg-caution-soft px-1.5 py-0.5 text-[11px] text-caution hover:bg-caution/10"
        >
          Trigger overdue
        </a>

        <a
          href="/reset"
          className="rounded-[3px] border border-critical/30 bg-critical-soft px-1.5 py-0.5 text-[11px] text-critical hover:bg-critical/10"
        >
          Reset world
        </a>

        {pending ? <span className="text-[11px] text-ink-faint">working…</span> : null}
        {note ? <span className="text-[11px] text-ink-muted">{note}</span> : null}
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
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-end gap-3 px-3 py-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10.5px] tracking-wide text-ink-muted uppercase">Wallet</span>
          <select
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-1 text-[12px]"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
          >
            {personas.map((p) => (
              <option key={p.userId} value={p.wallet}>
                {p.entityName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10.5px] tracking-wide text-ink-muted uppercase">Asset</span>
          <select
            className="rounded-[3px] border border-rule-strong bg-surface px-1.5 py-1 text-[12px]"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
          >
            {ASSETS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10.5px] tracking-wide text-ink-muted uppercase">Amount</span>
          <input
            className="num w-40 rounded-[3px] border border-rule-strong bg-surface px-1.5 py-1 text-[12px]"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={pending}
          className="rounded-[3px] bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          onClick={() =>
            startTransition(async () => {
              // Base units: the input is in display units, so scale by 10,000.
              const whole = Number(amount.replace(/,/g, ''));
              if (!Number.isFinite(whole) || whole <= 0) {
                onDone('Enter an amount greater than zero.');
                return;
              }
              const base = BigInt(Math.round(whole * 10_000)).toString();
              const result = await topUp(wallet, asset, base);
              onDone(result.message);
            })
          }
        >
          Add balance
        </button>
        <p className="text-[11px] text-ink-faint">
          Demo-only. Adds a simulated balance and records a mock transaction receipt.
        </p>
      </div>
    </div>
  );
}
