import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BidPanel } from './BidPanel';
import {
  Address,
  Amount,
  DaysRemaining,
  Field,
  GradeBadge,
  MockTxRef,
  Panel,
  Percent,
} from '@/components/primitives';
import { currentPersona } from '@/app/session';
import { formatUnits } from '@/core/money';
import {
  readBalances,
  readBids,
  readEvents,
  readHolders,
  readListing,
  readWorld,
} from '@/db/read';

/**
 * PRD §8 screen 10. Payable detail.
 *
 * "Lead with ADATA and the payment obligation." That instruction shapes the
 * whole page: the anchor and what it owes come first, the credit view second,
 * and the original supplier appears as context rather than as the thing being
 * underwritten. PRD §2 lists this as an acceptance criterion in its own right.
 */
export default async function PayableDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const listing = await readListing(id, world);
  if (!listing) notFound();

  const [holders, bids, balances, events] = await Promise.all([
    listing.targetKind === 'payable' ? readHolders(listing.targetId) : Promise.resolve([]),
    readBids(listing.id, listing.listedFaceBase, listing.quote.daysRemaining),
    readBalances(persona.wallet),
    listing.targetKind === 'payable'
      ? readEvents({ payableId: listing.targetId, limit: 25 })
      : readEvents({ limit: 25 }),
  ]);

  const openBids = bids.filter((b) => b.status === 'placed');
  const partial = listing.listedFaceBase !== listing.invoiceFaceBase;

  return (
    <div className="space-y-3">
      <Link href="/lender" className="text-[12px] text-accent hover:underline">
        ← Marketplace
      </Link>

      {/* The obligation, first and largest. */}
      <div className="rounded-[4px] border border-rule bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[10.5px] font-medium tracking-wide text-ink-muted uppercase">
              Anchor obligor
            </div>
            <h1 className="text-[20px] leading-tight font-semibold">{listing.anchorName}</h1>
            <p className="mt-1 max-w-xl text-[12.5px] text-ink-muted">
              owes{' '}
              <strong className="text-ink">
                {formatUnits(listing.listedFaceBase, 2)} XUSD
              </strong>{' '}
              on {listing.maturityDate}, payable to whoever holds this payable at maturity. That
              obligation is what you are underwriting.
            </p>
          </div>
          <div className="text-right">
            <div className="text-[10.5px] font-medium tracking-wide text-ink-muted uppercase">
              Indicative yield
            </div>
            <div
              className="text-[26px] leading-tight font-semibold"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              <Percent value={listing.quote.lenderYieldPercent} decimals={1} />
            </div>
            <div className="text-[11px] text-ink-faint">
              on purchase price, Actual/365
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-3">
          <Panel title="Credit">
            <dl>
              <Field label="Grade">
                {listing.grade ? <GradeBadge grade={listing.grade} /> : '—'}
              </Field>
              <Field label="Rationale">
                <span className="text-ink-muted">{listing.gradeRationale ?? '—'}</span>
              </Field>
              <Field label="Reference">{listing.targetRef}</Field>
              <Field label="Lot">
                {listing.targetKind === 'series'
                  ? `Series of ${listing.memberCount} invoices, one anchor, one maturity`
                  : 'Single invoice'}
              </Field>
              <Field label="Original supplier">
                <span className="text-ink-muted">{listing.sellerName}</span>
              </Field>
            </dl>
          </Panel>

          <Panel title="Terms">
            <dl>
              <Field label="Invoice face">
                <Amount value={listing.invoiceFaceBase} decimals={4} showAsset asset="XUSD" />
              </Field>
              <Field label="Listed quantity">
                <span className={partial ? 'font-semibold' : ''}>
                  <Amount value={listing.listedFaceBase} decimals={4} showAsset asset="XUSD" />
                </span>
              </Field>
              <Field label="Ask">
                <Amount value={listing.askBase} decimals={2} showAsset asset="XUSD" />
              </Field>
              <Field label="Price">
                <span className="num">{listing.quote.pricePercent.toFixed(2)}% of face</span>
              </Field>
              <Field label="Discount">
                <Amount value={listing.quote.discount} decimals={2} showAsset asset="XUSD" />
              </Field>
              <Field label="Maturity">{listing.maturityDate}</Field>
              <Field label="Days remaining">
                <DaysRemaining days={listing.quote.daysRemaining} />
              </Field>
              <Field label="Supplier financing cost">
                <Percent value={listing.quote.annualisedDiscountCostPercent} decimals={1} />
              </Field>
              <Field label="Your yield">
                <Percent value={listing.quote.lenderYieldPercent} decimals={1} />
              </Field>
            </dl>
            <p className="mt-2 text-[10.5px] text-ink-faint">
              The two annualised figures use different denominators. The supplier&apos;s cost is on
              face; your yield is on the price you pay.
            </p>
          </Panel>

          {holders.length > 0 ? (
            <Panel title="Current holders" dense>
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Holder</th>
                    <th>Wallet</th>
                    <th className="num">Quantity</th>
                    <th className="num">Free</th>
                    <th className="num">Listed</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((h) => (
                    <tr key={h.wallet}>
                      <td>{h.entityName}</td>
                      <td>
                        <Address value={h.wallet} />
                      </td>
                      <td>
                        <Amount value={h.quantityBase} decimals={4} />
                      </td>
                      <td>
                        <Amount value={h.freeBase} decimals={4} />
                      </td>
                      <td>
                        <Amount value={h.listedBase} decimals={4} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          <Panel title="Event history" dense>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Chain reference</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.entryId}>
                    <td className="num">{e.worldDate}</td>
                    <td>{e.kind.replace(/_/g, ' ')}</td>
                    <td className="text-ink-muted">{e.actorName}</td>
                    <td>
                      {e.txHash ? (
                        <MockTxRef hash={e.txHash} block={Number(e.blockNumber)} />
                      ) : (
                        <span className="text-[11px] text-ink-faint">audit event, no receipt</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <div className="space-y-3">
          <BidPanel
            listingId={listing.id}
            listedFaceBase={listing.listedFaceBase.toString()}
            askBase={listing.askBase.toString()}
            daysRemaining={listing.quote.daysRemaining}
            wallet={persona.wallet}
            eligible={persona.institutionalEligible}
            balances={{
              XUSD: balances.XUSD.toString(),
              USDC: balances.USDC.toString(),
              USDT: balances.USDT.toString(),
              XSGD: balances.XSGD.toString(),
            }}
            xsgdPerXusdE6={world.xsgdPerXusdE6.toString()}
            isSeller={persona.wallet === listing.sellerWallet}
          />

          {openBids.length > 0 ? (
            <Panel title={`Bids (${openBids.length})`} dense>
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Bidder</th>
                    <th className="num">Offer</th>
                    <th className="num">% face</th>
                    <th className="num">Yield</th>
                    <th>Funding</th>
                  </tr>
                </thead>
                <tbody>
                  {openBids.map((b) => (
                    <tr key={b.id}>
                      <td>{b.bidderName}</td>
                      <td>
                        <Amount value={b.priceBase} decimals={2} />
                      </td>
                      <td className="num">{b.quote.pricePercent.toFixed(2)}%</td>
                      <td>
                        <Percent value={b.quote.lenderYieldPercent} decimals={1} />
                      </td>
                      <td>{b.fundingAsset}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[10.5px] text-ink-faint">
                Bids do not reserve funds. Balance and ownership are rechecked when the seller
                accepts.
              </p>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
