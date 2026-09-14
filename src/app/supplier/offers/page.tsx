import { ActionButton } from '@/components/ActionButton';
import {
  Amount,
  DaysRemaining,
  EmptyState,
  LedgerScroll,
  Panel,
  Percent,
} from '@/components/primitives';
import { acceptBid, cancelListing } from '@/app/actions';
import { currentPersona } from '@/app/session';
import { formatUnits } from '@/core/money';
import { readBalances, readBids, readMarketplace, readWorld } from '@/db/read';

/**
 * PRD §8 screen 8. Offers received.
 *
 * "The seller accepts one offer." The screen shows what §8 asks for per bid:
 * bidder, listed quantity, XUSD offer, price as a percentage of listed face,
 * days remaining, implied yield, and the funding asset they chose.
 *
 * Each row also shows whether that bidder can still pay, because §9 rechecks
 * balance at acceptance and a seller should see a doomed bid before clicking
 * rather than after.
 */
export default async function OffersPage() {
  const [persona, world] = await Promise.all([currentPersona(), readWorld()]);
  const listings = (await readMarketplace(world)).filter((l) => l.sellerWallet === persona.wallet);

  const withBids = await Promise.all(
    listings.map(async (l) => {
      const bids = await readBids(l.id, l.listedFaceBase, l.quote.daysRemaining);
      const open = bids.filter((b) => b.status === 'placed');
      const funded = await Promise.all(
        open.map(async (b) => {
          const balances = await readBalances(b.bidderWallet);
          const needed =
            b.fundingAsset === 'XSGD'
              ? (b.priceBase * world.xsgdPerXusdE6 + 500_000n) / 1_000_000n
              : b.priceBase;
          return { bid: b, canPay: balances[b.fundingAsset] >= needed, needed };
        }),
      );
      return { listing: l, bids: funded };
    }),
  );

  const anyBids = withBids.some((l) => l.bids.length > 0);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Offers received</h1>
        <p className="text-[11.5px] text-ink-muted">
          You choose which offer to accept. Accepting settles the trade and expires every competing
          offer on that listing in the same operation.
        </p>
      </div>

      {withBids.length === 0 ? (
        <Panel dense>
          <EmptyState
            title="You have nothing listed."
            hint="List a payable from My tokenised payables to start receiving offers."
          />
        </Panel>
      ) : (
        withBids.map(({ listing, bids }) => (
          <Panel
            key={listing.id}
            title={`${listing.targetRef} — ${formatUnits(listing.listedFaceBase, 2)} XUSD listed at ${listing.quote.pricePercent.toFixed(2)}%`}
            action={
              <ActionButton
                label="Withdraw listing"
                variant="secondary"
                confirm="Returns the listed quantity to your free balance and expires every open offer."
                action={cancelListing}
                args={[listing.id]}
              />
            }
          >
            {bids.length === 0 ? (
              <EmptyState title="No offers yet on this listing." />
            ) : (
              <LedgerScroll label="Offers">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Bidder</th>
                      <th className="num">Listed quantity</th>
                      <th className="num">Offer</th>
                      <th className="num">% of face</th>
                      <th className="num">Days</th>
                      <th className="num">Their yield</th>
                      <th>Funding</th>
                      <th>Can pay</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {bids.map(({ bid, canPay, needed }) => (
                      <tr key={bid.id}>
                        <td className="font-medium">{bid.bidderName}</td>
                        <td>
                          <Amount value={listing.listedFaceBase} decimals={2} />
                        </td>
                        <td className="font-medium">
                          <Amount value={bid.priceBase} decimals={2} />
                        </td>
                        <td className="num">{bid.quote.pricePercent.toFixed(2)}%</td>
                        <td>
                          <DaysRemaining days={bid.quote.daysRemaining} />
                        </td>
                        <td>
                          <Percent value={bid.quote.lenderYieldPercent} decimals={1} />
                        </td>
                        <td>
                          {bid.fundingAsset}
                          {bid.fundingAsset === 'XSGD' ? (
                            <span className="ml-1 text-[10.5px] text-ink-faint">
                              {formatUnits(needed as never, 2)} debited
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {canPay ? (
                            <span className="text-[11.5px] text-positive">yes</span>
                          ) : (
                            <span className="text-[11.5px] text-critical">short</span>
                          )}
                        </td>
                        <td className="text-right">
                          <ActionButton
                            label="Accept"
                            disabled={!canPay}
                            disabledReason="This bidder no longer holds enough of their funding asset."
                            confirm={
                              <>
                                You receive {formatUnits(bid.priceBase, 2)} XUSD and{' '}
                                {bid.bidderName} receives{' '}
                                {formatUnits(listing.listedFaceBase, 2)} of face. Competing offers
                                expire.
                              </>
                            }
                            action={acceptBid}
                            args={[listing.id, bid.id]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </LedgerScroll>
            )}
          </Panel>
        ))
      )}

      {!anyBids && withBids.length > 0 ? (
        <p className="text-[11px] text-ink-faint">
          Switch to a lender persona in the demo controls to place an offer, then switch back here
          to accept it.
        </p>
      ) : null}
    </div>
  );
}
