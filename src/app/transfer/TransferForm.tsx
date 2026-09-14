'use client';

import { useMemo, useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { Address, Notice } from '@/components/primitives';
import { transferQuantity } from '@/app/actions';
import { type BaseUnits, formatUnits, parseUnits } from '@/core/money';

interface Holding {
  payableId: string;
  ref: string;
  anchorName: string;
  freeBase: string;
  listedBase: string;
  maturityDate: string;
}

export function TransferForm({
  sender,
  holdings,
  recipients,
  preselect,
}: {
  sender: string;
  holdings: Holding[];
  recipients: { wallet: string; label: string }[];
  preselect?: string;
}) {
  const [payableId, setPayableId] = useState(
    holdings.find((h) => h.payableId === preselect)?.payableId ?? holdings[0]!.payableId,
  );
  const holding = holdings.find((h) => h.payableId === payableId)!;
  const free = BigInt(holding.freeBase) as BaseUnits;

  // PRD §8: the quantity defaults to the full holding.
  const [quantity, setQuantity] = useState(formatUnits(free, 4).replace(/,/g, ''));
  const [recipient, setRecipient] = useState(recipients[0]?.wallet ?? '');

  const parsed = useMemo(() => {
    try {
      const q = parseUnits(quantity);
      if (q <= 0n) return { error: 'Enter a quantity greater than zero.' };
      if (q > free) {
        return {
          error: `That is more than you hold unlisted. You can send up to ${formatUnits(free, 4)}.`,
        };
      }
      return { quantity: q };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [quantity, free]);

  const resolved = recipients.find((r) => r.wallet === recipient);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Payable
          </span>
          <select
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={payableId}
            aria-label="Payable to send"
            onChange={(e) => {
              const next = holdings.find((h) => h.payableId === e.target.value)!;
              setPayableId(next.payableId);
              setQuantity(formatUnits(BigInt(next.freeBase) as BaseUnits, 4).replace(/,/g, ''));
            }}
          >
            {holdings.map((h) => (
              <option key={h.payableId} value={h.payableId}>
                {h.ref} — {formatUnits(BigInt(h.freeBase) as BaseUnits, 2)} available
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Recipient wallet
          </span>
          <select
            className="w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={recipient}
            aria-label="Recipient wallet"
            onChange={(e) => setRecipient(e.target.value)}
          >
            {recipients.map((r) => (
              <option key={r.wallet} value={r.wallet}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Quantity (XUSD of face)
          </span>
          <input
            className="num w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={quantity}
            inputMode="decimal"
            aria-label="Quantity to send"
            onChange={(e) => setQuantity(e.target.value)}
          />
          <span className="mt-0.5 block text-[10.5px] text-ink-faint">
            {formatUnits(free, 4)} unlisted
            {BigInt(holding.listedBase) > 0n
              ? `, ${formatUnits(BigInt(holding.listedBase) as BaseUnits, 4)} locked to a listing`
              : ''}
          </span>
        </label>
      </div>

      {/* PRD §8 screen 13: "show the resolved recipient". */}
      <div className="rounded-[4px] border border-rule bg-surface-sunken p-3">
        <div className="text-[10.5px] tracking-wide text-ink-muted uppercase">Resolved recipient</div>
        {resolved ? (
          <>
            <div className="text-[13px] font-medium">{resolved.label}</div>
            <Address value={resolved.wallet} full />
          </>
        ) : (
          <div className="text-[12px] text-critical">No eligible recipient selected.</div>
        )}
        <div className="mt-2 flex items-baseline justify-between border-t border-rule pt-2">
          <span className="text-[11.5px] text-ink-muted">From</span>
          <Address value={sender} />
        </div>
      </div>

      {'error' in parsed ? (
        <Notice tone="critical">{parsed.error}</Notice>
      ) : (
        <ActionButton
          label="Send payable"
          disabled={!resolved}
          confirm={
            <>
              Moves {formatUnits(parsed.quantity, 4)} XUSD of {holding.ref} to {resolved?.label}. No
              payment changes hands. The transfer is recorded with a simulated receipt.
            </>
          }
          action={transferQuantity}
          args={[payableId, sender, recipient, parsed.quantity.toString()]}
        />
      )}

      <p className="text-[10.5px] text-ink-faint">
        All transfers happen within the platform, between registered wallets. A transfer that would
        drop your holding below a listed quantity is refused; withdraw the listing first.
      </p>
    </div>
  );
}
