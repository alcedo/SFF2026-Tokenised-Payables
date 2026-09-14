'use client';

/**
 * PRD §8 screen 11. Place bid / buy now.
 *
 * "Enter price as a percentage of the listed quantity's face and show the
 * equivalent XUSD amount. Select the funding asset before confirmation. Show
 * conversion, source debit, available balance, and XUSD seller credit."
 *
 * Every one of those appears before the button is armed, which is the point:
 * the lender should never have to confirm to find out what they are charged.
 */

import { useMemo, useState } from 'react';

import { ActionButton } from '@/components/ActionButton';
import { AssetPicker } from '@/components/AssetPicker';
import { Notice, Panel } from '@/components/primitives';
import { buyNow, placeBid } from '@/app/actions';
import { convert, formatRate } from '@/core/fx';
import { type Asset, formatUnits, type BaseUnits } from '@/core/money';
import { formatPercent, priceFromPercent, quote } from '@/core/pricing';

export function BidPanel({
  listingId,
  listedFaceBase,
  askBase,
  buyNowBase,
  daysRemaining,
  wallet,
  eligible,
  balances,
  xsgdPerXusdE6,
  isSeller,
}: {
  listingId: string;
  listedFaceBase: string;
  askBase: string;
  buyNowBase: string | null;
  daysRemaining: number;
  wallet: string;
  eligible: boolean;
  balances: Record<string, string>;
  xsgdPerXusdE6: string;
  isSeller: boolean;
}) {
  const face = BigInt(listedFaceBase) as BaseUnits;
  const ask = BigInt(askBase) as BaseUnits;
  const rate = BigInt(xsgdPerXusdE6);
  const askPercent = (Number(ask) / Number(face)) * 100;

  const [percent, setPercent] = useState(askPercent.toFixed(2));
  const [asset, setAsset] = useState<Asset>('USDC');

  const parsed = Number(percent);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= 100;

  const priced = useMemo(() => {
    if (!valid) return null;
    // Percent entry converts to base units immediately; the base-unit value is
    // what is stored and what the confirmation shows.
    const bps = Math.round(parsed * 100);
    const price = priceFromPercent(face, bps);
    const q = quote(face, price, daysRemaining);
    const debit = convert(price, asset, rate).sourceDebit;
    return { price, q, debit };
  }, [valid, parsed, face, daysRemaining, asset, rate]);

  const available = BigInt(balances[asset] ?? '0');
  const short = priced !== null && available < priced.debit;

  // Buy-now is charged at the seller's published price, not at whatever is
  // typed in the bid box, so it needs its own debit and its own balance check.
  const takeNow = useMemo(() => {
    if (buyNowBase === null) return null;
    const price = BigInt(buyNowBase) as BaseUnits;
    const debit = convert(price, asset, rate).sourceDebit;
    return {
      price,
      debit,
      short: available < debit,
      percent: (Number(price) / Number(face)) * 100,
    };
  }, [buyNowBase, asset, rate, available, face]);

  if (isSeller) {
    return (
      <Panel title="Your listing">
        <Notice tone="info">
          This is your own listing. Offers received appear on the seller&apos;s Offers screen.
        </Notice>
      </Panel>
    );
  }

  if (!eligible) {
    return (
      <Panel title="Place a bid">
        <Notice tone="caution">
          Only institutional lender accounts can bid or buy. Switch persona in the demo controls to
          act as a lender. Marketplace access here is a demo permission, not real accreditation.
        </Notice>
      </Panel>
    );
  }

  if (daysRemaining <= 0) {
    return (
      <Panel title="Place a bid">
        <Notice tone="caution">
          This payable has reached maturity. Listings close at maturity.
        </Notice>
      </Panel>
    );
  }

  return (
    <Panel title={buyNowBase ? 'Buy or bid' : 'Place a bid'}>
      <div className="space-y-3">
        <AssetPicker value={asset} onChange={setAsset} />

        {/*
          PRD §8 screen 11 pairs buy-now with bidding on one screen. It leads,
          because it is the faster path: a lender happy with the published price
          should not have to read the bid mechanics to find out they can skip
          them. The funding asset is shared with the bid form below, so choosing
          one reprices both.
        */}
        {takeNow ? (
          <div className="rounded-[4px] border border-accent/25 bg-accent-soft p-2.5">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="text-[11.5px] font-medium text-accent">Buy now</span>
              <span className="num text-[13px] font-semibold">
                {formatUnits(takeNow.price, 2)} XUSD
              </span>
            </div>
            <p className="mb-2 text-[11px] text-ink-muted">
              Takes the whole lot immediately at the seller&apos;s published price, with no bidding.
              That is {takeNow.percent.toFixed(2)}% of face, for a yield of{' '}
              {formatPercent(quote(face, takeNow.price, daysRemaining).lenderYieldPercent, 1)} over{' '}
              {daysRemaining} days.
            </p>
            <dl className="mb-2 space-y-1 border-t border-accent/20 pt-1.5">
              <Line label={`Debited from you (${asset})`}>
                <strong>{formatUnits(takeNow.debit, 4)}</strong> {asset}
              </Line>
              <Line label={`Your ${asset} balance`}>
                <span className={takeNow.short ? 'text-critical' : ''}>
                  {formatUnits(available as BaseUnits, 2)} {asset}
                </span>
              </Line>
            </dl>
            {takeNow.short ? (
              <Notice tone="critical">
                You hold less {asset} than this costs. Switch funding asset, or use Simulate top-up
                in the demo controls.
              </Notice>
            ) : (
              <ActionButton
                label="Buy now"
                confirm={
                  <>
                    Buys {formatUnits(face, 2)} XUSD of face for {formatUnits(takeNow.price, 2)}{' '}
                    XUSD, debiting {formatUnits(takeNow.debit, 4)} {asset}. This
                    settles immediately; the seller does not need to accept.
                  </>
                }
                action={buyNow}
                args={[listingId, wallet, asset]}
              />
            )}
          </div>
        ) : null}

        <label className="block">
          <span className="mb-0.5 block text-[10.5px] tracking-wide text-ink-muted uppercase">
            Price, as a percentage of listed face
          </span>
          <div className="flex items-center gap-1.5">
            <input
              className="num w-28 rounded-[3px] border border-rule-strong bg-surface px-2 py-1.5 text-[13px]"
              value={percent}
              inputMode="decimal"
              aria-label="Price as a percentage of face"
              onChange={(e) => setPercent(e.target.value)}
            />
            <span className="text-[13px] text-ink-muted">%</span>
            <button
              type="button"
              className="ml-1 text-[11.5px] text-accent hover:underline"
              onClick={() => setPercent(askPercent.toFixed(2))}
            >
              match ask ({askPercent.toFixed(2)}%)
            </button>
          </div>
        </label>

        {!valid ? (
          <Notice tone="critical">Enter a price between 0 and 100 percent of face.</Notice>
        ) : priced ? (
          <dl className="space-y-1 rounded-[4px] border border-rule bg-surface-sunken p-2.5">
            <Line label="Listed face">{formatUnits(face, 2)} XUSD</Line>
            <Line label="Your offer">{formatUnits(priced.price, 2)} XUSD</Line>
            <Line label="Discount">{formatUnits(priced.q.discount, 2)} XUSD</Line>
            <Line label="Your yield">
              {formatPercent(priced.q.lenderYieldPercent, 1)} over {daysRemaining} days
            </Line>
            <div className="my-1 border-t border-rule" />
            <Line label="Conversion">{asset === 'XSGD' ? formatRate(rate) : '1:1 with XUSD'}</Line>
            <Line label={`Debited from you (${asset})`}>
              <strong>{formatUnits(priced.debit, 4)}</strong> {asset}
            </Line>
            <Line label={`Your ${asset} balance`}>
              <span className={short ? 'text-critical' : ''}>
                {formatUnits(available as BaseUnits, 2)} {asset}
              </span>
            </Line>
            <Line label="Seller receives">{formatUnits(priced.price, 2)} XUSD</Line>
          </dl>
        ) : null}

        {short ? (
          <Notice tone="critical">
            You hold less {asset} than this bid would need. Bids do not reserve funds, so you can
            still place it, but it cannot be accepted until the balance covers it. Use Simulate
            top-up in the demo controls.
          </Notice>
        ) : null}

        <ActionButton
          label="Place bid"
          disabled={!valid}
          confirm={
            priced ? (
              <>
                Offers {formatUnits(priced.price, 2)} XUSD for {formatUnits(face, 2)} of face,
                funded in {asset}. The seller decides whether to accept.
              </>
            ) : null
          }
          action={placeBid}
          args={[listingId, wallet, String(priced?.price ?? 0n), asset]}
        />

        <p className="text-[10.5px] text-ink-faint">
          Placing a bid reserves nothing. Balance, ownership and listing status are all rechecked at
          the moment the seller accepts.
        </p>
      </div>
    </Panel>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11.5px] text-ink-muted">{label}</dt>
      <dd className="num text-[12px]">{children}</dd>
    </div>
  );
}
