'use client';

/**
 * A button that performs one write and shows what happened.
 *
 * Every mutating control in the product goes through this, which is what makes
 * three PRD rules hold everywhere rather than per screen: an idempotency key is
 * minted when the control is armed rather than when it is clicked (so a
 * double-click is one effect), a refusal renders inline with its reason (§14),
 * and a chain-relevant action shows its simulated receipt immediately (§10).
 */

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { ActionResult } from '@/app/actions';
import { MockTxRef, Notice } from './primitives';

export function ActionButton({
  label,
  confirm,
  action,
  args = [],
  variant = 'primary',
  disabled,
  disabledReason,
}: {
  label: string;
  /** Shown before the action fires. Omit for a control that needs no warning. */
  confirm?: React.ReactNode;
  /**
   * The server action to call, and its arguments.
   *
   * Deliberately not a closure. A server component cannot hand a closure to a
   * client component, so a `run: (key) => action(id, key)` prop works from a
   * client page and throws from a server one. Taking the action itself plus
   * serialisable arguments works from both, which means a screen never has to
   * become a client component just to own a button.
   *
   * The idempotency key is appended as the final argument; every action in
   * src/app/actions.ts takes it there.
   */
  action: (...args: never[]) => Promise<ActionResult>;
  args?: readonly unknown[];
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [armed, setArmed] = useState(!confirm);
  const [result, setResult] = useState<ActionResult | null>(null);
  // Minted once, when the control is first armed. A second click reuses it, so
  // the ledger collapses the two into one effect and returns the same receipt.
  const key = useRef<string>('');

  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-hover',
    secondary: 'border border-rule-strong bg-surface text-ink hover:bg-surface-sunken',
    danger: 'border border-critical/30 bg-critical-soft text-critical hover:bg-critical/10',
  }[variant];

  if (result) {
    return (
      <div className="space-y-1.5">
        <Notice tone={result.ok ? 'positive' : 'critical'}>
          {result.message}
          {result.detail ? (
            <span className="mt-0.5 block text-[11px] opacity-80">{result.detail}</span>
          ) : null}
        </Notice>
        {result.receipt ? (
          <div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
            <span>Receipt</span>
            <MockTxRef hash={result.receipt.txHash} block={Number(result.receipt.blockNumber)} />
          </div>
        ) : null}
        <button
          type="button"
          className="text-[11.5px] text-accent hover:underline"
          onClick={() => {
            setResult(null);
            setArmed(!confirm);
            router.refresh();
          }}
        >
          Close
        </button>
      </div>
    );
  }

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled || pending}
        title={disabled ? disabledReason : undefined}
        className={`inline-flex items-center rounded-[3px] px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-45 ${styles}`}
        onClick={() => {
          key.current = crypto.randomUUID();
          setArmed(true);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      {confirm ? <div className="text-[12px] text-ink-muted">{confirm}</div> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || pending}
          title={disabled ? disabledReason : undefined}
          className={`inline-flex items-center rounded-[3px] px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-45 ${styles}`}
          onClick={() =>
            startTransition(async () => {
              if (!key.current) key.current = crypto.randomUUID();
              const call = action as unknown as (...a: unknown[]) => Promise<ActionResult>;
              const r = await call(...args, key.current);
              setResult(r);
              router.refresh();
            })
          }
        >
          {pending ? 'Working…' : confirm ? `Confirm: ${label}` : label}
        </button>
        {confirm ? (
          <button
            type="button"
            className="text-[11.5px] text-ink-muted hover:underline"
            onClick={() => setArmed(false)}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
