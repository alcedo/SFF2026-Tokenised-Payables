# Bid or buy now

Bid or buy now lets a lender find a lot on the marketplace, read the anchor obligation they would be underwriting, and either bid at a price of their choosing or take the lot outright at the seller's published buy-now price, funding either in any of four assets.

## Sub-features

- `bid-filter` narrows the book by grade, tenor, ticket size, yield and maturity date, carries the filter in the address, and clears it.
- `bid-series` opens a series lot and expands its member invoices.
- `bid-detail` shows the anchor obligor first, the grade and rationale, terms, current holders and event history.
- `bid-asset` chooses the funding asset and shows the debit and conversion in that asset.
- `bid-place` places a bid at a percentage of face.
- `bid-buy-now` takes a lot outright at the published price, settling at once with a receipt.

## How to get to it (user POV)

- As a lender, choose `Marketplace` in the navigation, or open `/lender`.
- Choose a lot's reference in the open listings table. It opens `/lender/<id>`.
- Choose a `SERIES-` reference to open a series lot.

## Driving it with drive.mjs

Preconditions:

- Acting as `Rina Okafor`, the lender at Meridian Trade Bank. Her header balances at T0 are 6,520,000.00 XUSD and 1,400,000.00 XSGD.
- Fresh seed at T0: nine open lots. `TP-2026-0141` is listed at 97.85% for 244,625.00 with no bids. `TP-2026-0149` carries a buy-now price of 86,372.00 XUSD. `SERIES-2026-Q4-30D` is a 12-invoice series lot.

- **Filter by grade.** Run `node scripts/drive.mjs --run bid-filter --as "Rina Okafor" --go /lender --grab ALL="Open lots\n\d+" --press AAA --url grade=AAA --shot filtered --press Clear --absent "Lots matching"`. The heading changes from `Open lots` to `Lots matching`, fewer rows show, and the address carries the grade. Clear restores the whole book.
- **Filter by dropdown.** Continue with `--select "Tenor=61 to 90 days" --url tmin=61 --select "Yield=8% or more" --url ymin --select "Sort=Maturity, soonest first" --shot filtered-dropdowns --press Clear`. The dropdowns are `Tenor`, `Ticket size`, `Yield` and `Sort`, and `Matures by` is a date textbox. Every choice lands in the address.
- **Expand a series.** Continue with `--link /^SERIES-/ --expect "Series members (12)" --shot series --tap "Show the 12 invoices" --in "Series members" --expect "one holder across every member" --shot series-members`. The members are behind a disclosure reading `Show the 12 invoices in this lot`; opened, the table shows twelve invoices, each with its own reference, and the holder line under it.
- **Read the detail.** Run `node scripts/drive.mjs --run bid-detail --as "Rina Okafor" --go /lender --link TP-2026-0141 --expect "Anchor obligor" --expect "ADATA Technology Co., Ltd." --expect "owes 250,000.00 XUSD" --expect "Your yield" --expect "8.9%" --aria detail --shot detail`. The screen leads with ADATA, then `Credit`, `Terms`, `Current holders` and `Event history`.
- **Choose the funding asset.** Continue with `--press XSGD --in "Buy or bid" --expect "Debited from you (XSGD)" --expect Conversion --shot xsgd --press USDC --expect "Debited from you (USDC)" --expect "244,625.0000"`. USDC funds an XUSD obligation 1:1, so the debit equals the ask; XSGD shows a conversion line and a larger debit.
- **Place a bid.** Continue with `--shot before-bid --click "Place bid" --shot after-bid`. A notice confirms the bid. Lower the price first with `--fill "Price as a percentage of face=97.50"` to bid under the ask; the preview updates `Your offer`, `Discount` and `Your yield` as you type.
- **Buy now.** Run `node scripts/drive.mjs --run bid-buy-now --as "Rina Okafor" --go /lender --link TP-2026-0149 --in "Buy or bid" --expect "Buy now 86,372.00 XUSD" --expect "98.15% of face" --shot buy-now-offered --click "Buy now" --in "" --expect Receipt --shot receipt --go /lender/portfolio --in TP-2026-0149 --text --shot portfolio`. The receipt carries a simulated chain reference. The portfolio shows the lot at once with `Purchase price` 86,372.00.
- **Proof.** Continue with `--go /lender --absent TP-2026-0149 --go /explorer --in "Transaction log" --expect "trade settlement" --in "" --expect Balanced --shot explorer`. The lot has left the marketplace, the explorer records a `trade settlement` funded in the chosen asset, and Books reads `Balanced`. For a placed bid, the second view is the supplier's offers screen in [Accept an offer](./accept-offer.md).

## Gotchas

- The panel is titled `Buy or bid` when the seller set a buy-now price and `Place a bid` otherwise. Read the heading with `--text` before scoping with `--in`.
- Listings sort by yield, highest first. Open a lot by its reference link, never by row position.
- Grade filters are buttons named `AAA`, `AA`, `A`; the rest are dropdowns. `--press` for the buttons, `--select` for the dropdowns.
- The series disclosure is a summary element, not a button. `--press` and `--click` cannot find it; `--tap` on its text can.
- The address parameters are short: `grade`, `tmin`, `tmax`, `ymin`. Assert on those, not on the label text.
- A bid does not move money until the supplier accepts. A bid only creates a row on the offers screen; buy now settles at once.
- If the chosen asset's balance is short, the button is disabled and names the asset. That is a behaviour, not a harness failure.
- The same reference can appear in several tables on one page, such as the portfolio's holdings and its maturity ladder. `--in` picks the smallest match; use `--text` to confirm which row it chose.
