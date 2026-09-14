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
  readSeriesMembers,
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

  const [holders, members, bids, balances, events] = await Promise.all([
    listing.targetKind === 'payable' ? readHolders(listing.targetId) : Promise.resolve([]),
    listing.targetKind === 'series'
      ? readSeriesMembers(listing.targetId, world)
      : Promise.resolve([]),
    readBids(listing.id, listing.listedFaceBase, listing.quote.daysRemaining),
    readBalances(persona.wallet),
    listing.targetKind === 'payable'
      ? readEvents({ payableId: listing.targetId, limit: 25 })
      : readEvents({ seriesId: listing.targetId, limit: 25 }),
  ]);

  const membersFace = members.reduce<bigint>((acc, m) => acc + m.outstandingBase, 0n);
  const oneHolder = new Set(members.map((m) => m.holderWallet)).size <= 1;

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

          {/*
            PRD §8 screen 10: "Expand a Series to inspect its members."
            A <details> rather than a client component: the rows are already
            on the page, so expanding is a browser affordance and costs no
            round trip. Collapsed by default because twelve invoices sharing
            one anchor and one maturity is a detail, not the headline.
          */}
          {members.length > 0 ? (
            <Panel title={`Series members (${members.length})`} dense>
              <details className="group">
                <summary className="cursor-pointer list-none px-3 py-2 text-[12px] text-accent hover:bg-surface-sunken">
                  <span className="group-open:hidden">
                    Show the {members.length} invoices in this lot →
                  </span>
                  <span className="hidden group-open:inline">Hide the member invoices</span>
                </summary>
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Invoice</th>
                      <th>Original supplier</th>
                      <th>Grade</th>
                      <th className="num">Face</th>
                      <th>Maturity</th>
                      <th>Held by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id}>
                        <td className="font-medium">{m.ref}</td>
                        <td className="text-ink-muted">{m.invoiceRef}</td>
                        <td className="text-ink-muted">{m.supplierName}</td>
                        <td>{m.grade ? <GradeBadge grade={m.grade} /> : '—'}</td>
                        <td>
                          <Amount value={m.outstandingBase} decimals={2} />
                        </td>
                        <td className="num">{m.maturityDate}</td>
                        <td>
                          {m.holderName ? (
                            <span className="text-ink-muted">{m.holderName}</span>
                          ) : (
                            <span className="text-ink-faint">unissued</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="text-ink-muted">
                        Total, which is the listed face
                      </td>
                      <td className="font-semibold">
                        <Amount value={membersFace as never} decimals={2} />
                      </td>
                      <td colSpan={2} className="text-ink-faint">
                        {oneHolder
                          ? 'one holder across every member, as a series requires'
                          : 'members are held by more than one wallet'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </details>
              <p className="px-3 py-2 text-[10.5px] text-ink-faint">
                A series is a lot-grouping mechanism, not a new instrument. Every member shares one
                anchor and one maturity, is wholly held by a single wallet, and trades only as part
                of the whole lot.
              </p>
            </Panel>
          ) : null}

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
            buyNowBase={listing.buyNowBase?.toString() ?? null}
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
