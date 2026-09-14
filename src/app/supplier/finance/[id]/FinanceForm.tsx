'use client';

import { useMemo, useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { Notice } from '@/components/primitives';
import { publishListing } from '@/app/actions';
import { type BaseUnits, formatUnits, parseUnits } from '@/core/money';
import { formatPercent, priceFromPercent, quote } from '@/core/pricing';

/** PRD §12 keeps this labelled as a scenario assumption. */
const BANK_BENCHMARK_PERCENT = 18;
const INDICATIVE_BPS = 9785;

export function FinanceForm({
  payableId,
  sellerWallet,
  freeBase,
  faceBase,
  daysRemaining,
}: {
  payableId: string;
  sellerWallet: string;
  freeBase: string;
  faceBase: string;
  daysRemaining: number;
}) {
  const free = BigInt(freeBase) as BaseUnits;
  const invoiceFace = BigInt(faceBase) as BaseUnits;

  // PRD §7: the listed quantity defaults to the full holding.
  const [quantity, setQuantity] = useState(formatUnits(free, 4).replace(/,/g, ''));
  const [percent, setPercent] = useState((INDICATIVE_BPS / 100).toFixed(2));
  const [buyNow, setBuyNow] = useState('');

  const parsed = useMemo(() => {
    try {
      const q = parseUnits(quantity);
      const pct = Number(percent);
      if (q <= 0n) return { error: 'Enter a quantity greater than zero.' as const };
      if (q > free) {
        return { error: `You hold ${formatUnits(free, 4)} unlisted. Enter that or less.` as const };
      }
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return { error: 'Enter a price between 0 and 100 percent of face.' as const };
      }
      const price = priceFromPercent(q, Math.round(pct * 100));
      const buy = buyNow.trim() === '' ? null : parseUnits(buyNow);
      if (buy !== null && buy < price) {
        return { error: 'A buy-now price cannot be below the minimum price.' as const };
      }
      return { quantity: q, price, buy, quoted: quote(q, price, daysRemaining) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [quantity, percent, buyNow, free, daysRemaining]);

  const partial = 'quantity' in parsed && parsed.quantity !== invoiceFace;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Quantity to list (XUSD of face)
          </span>
          <input
            className="num w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={quantity}
            inputMode="decimal"
            aria-label="Quantity to list"
            onChange={(e) => setQuantity(e.target.value)}
          />
          <span className="mt-0.5 block text-[10.5px] text-ink-faint">
            You hold {formatUnits(free, 4)} unlisted. Minimum increment 0.0001.
          </span>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Minimum price (% of listed face)
          </span>
          <div className="flex items-center gap-1.5">
            <input
              className="num w-28 rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
              value={percent}
              inputMode="decimal"
              aria-label="Minimum price as a percentage of face"
              onChange={(e) => setPercent(e.target.value)}
            />
            <span className="text-[13px] text-ink-muted">%</span>
            <button
              type="button"
              className="ml-1 text-[11.5px] text-accent hover:underline"
              onClick={() => setPercent((INDICATIVE_BPS / 100).toFixed(2))}
            >
              use indicative
            </button>
          </div>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Buy-now price (XUSD, optional)
          </span>
          <input
            className="num w-full rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
            value={buyNow}
            inputMode="decimal"
            placeholder="leave blank for bids only"
            aria-label="Buy now price"
            onChange={(e) => setBuyNow(e.target.value)}
          />
        </label>
      </div>

      {'error' in parsed ? (
        <Notice tone="critical">{parsed.error}</Notice>
      ) : (
        <>
          <dl className="space-y-1 rounded-[4px] border border-rule bg-surface-sunken p-3">
            <Line label="Listed face">{formatUnits(parsed.quantity, 4)} XUSD</Line>
            {partial ? (
              <Line label="Remainder you keep">
                {formatUnits((free - parsed.quantity) as BaseUnits, 4)} XUSD
              </Line>
            ) : null}
            <Line label="You receive on sale">
              <strong>{formatUnits(parsed.price, 2)} XUSD</strong>
            </Line>
            <Line label="You give up">{formatUnits(parsed.quoted.discount, 2)} XUSD</Line>
            <Line label="Annualised financing cost">
              <strong className="text-positive">
                {formatPercent(parsed.quoted.annualisedDiscountCostPercent, 1)}
              </strong>
            </Line>
            <Line label="Buyer's yield">
              {formatPercent(parsed.quoted.lenderYieldPercent, 1)}
            </Line>
            <Line label="Your bank quotes">
              <span className="text-critical">{BANK_BENCHMARK_PERCENT}.0%</span>
            </Line>
            <Line label="Days to maturity">{daysRemaining}</Line>
          </dl>

          {partial ? (
            <Notice tone="info">
              The listed quantity is locked to this listing until it sells or you withdraw it. The
              remainder stays free to hold or transfer.
            </Notice>
          ) : null}

          <ActionButton
            label="Publish listing"
            confirm={
              <>
                Lists {formatUnits(parsed.quantity, 4)} XUSD of face at a minimum of{' '}
                {formatUnits(parsed.price, 2)} XUSD. Institutional lenders can then bid.
              </>
            }
            action={publishListing}
            args={[
              {
                payableId,
                sellerWallet,
                quantityBase: parsed.quantity.toString(),
                minPriceBase: parsed.price.toString(),
                ...(parsed.buy ? { buyNowPriceBase: parsed.buy.toString() } : {}),
              },
            ]}
          />
        </>
      )}

      <p className="text-[10.5px] text-ink-faint">
        Listings are always denominated in XUSD. The buyer selects a funding asset when they bid;
        you are credited XUSD either way. The 18% bank rate is a scenario assumption, not a quote.
      </p>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11.5px] text-ink-muted">{label}</dt>
      <dd className="num text-[12.5px]">{children}</dd>
    </div>
  );
}
