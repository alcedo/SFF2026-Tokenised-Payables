# Accept an offer

Accept an offer lets a supplier see every bid on a listing, with price, percentage of face, yield and funding asset, and accept one. Accepting settles the trade in one operation: the lender is debited in their funding asset, the supplier is credited in XUSD, the quantity moves, the listing closes and every competing bid expires.

## Sub-features

- `offer-table` lists each bid with bidder, quantity, offer, percent of face, days, yield, funding asset and whether the bidder can pay.
- `offer-accept` settles the chosen bid atomically.
- `offer-expire` expires the competing bids on the same listing.
- `offer-withdraw` withdraws a listing before any bid is accepted.

## How to get to it (user POV)

- As the supplier, choose `Offers received` in the navigation, or open `/supplier/offers`.

## Driving it with drive.mjs

Preconditions:

- Fresh seed at T0. `Tang Mei-Hua` has `TP-2026-0141` listed at 97.85% for 250,000.00 XUSD face, with no bids yet. Her header XUSD balance is 378,723.50.
- Two bids exist, placed as below. Without them the screen reads `No offers yet on this listing`.

- **Place a bid at the ask.** Run `node scripts/drive.mjs --run offer-bids --as "Rina Okafor" --go /lender --link TP-2026-0141 --press USDC --in "Buy or bid" --expect "Debited from you (USDC)" --click "Place bid"`. Meridian Trade Bank bids 244,625.00 funded in USDC.
- **Place a competing bid.** Continue with `--as "Sébastien Baptiste" --go /lender --link TP-2026-0141 --fill "Price as a percentage of face=97.50" --click "Place bid"`. Kestrel Credit Fund bids 243,750.00.
- **Read the offers.** Run `node scripts/drive.mjs --run offer-accept --as "Tang Mei-Hua" --go /supplier/offers --in TP-2026-0141 --expect "listed at 97.85%" --expect "Meridian Trade Bank" --expect "244,625.00" --expect "Kestrel Credit Fund" --expect "243,750.00" --expect USDC --expect yes --shot offers`. Both bids show with `Can pay` yes and an `Accept` button each. A `Withdraw listing` button sits above the table.
- **Accept the better one.** Continue with `--in "Meridian Trade Bank" --click Accept --in "" --shot after-accept`. The listing leaves the screen, which now reads `You have nothing listed`, and the header XUSD balance reads 623,348.50.
- **Proof, supplier side.** Continue with `--go /supplier --absent TP-2026-0141 --expect "623,348.50" --shot supplier-after`. The payable is gone from the holdings and the balance is up by exactly 244,625.00.
- **Proof, lender side.** Continue with `--as "Rina Okafor" --go /lender/portfolio --in "Holdings" --expect TP-2026-0141 --expect "244,625.00" --expect "8.9%" --shot portfolio`. The position shows the purchase price and entry yield. Her XUSD balance is unchanged at 6,520,000.00 because the bid was funded in USDC.
- **Proof, competing bid expired.** Continue with `--as "Sébastien Baptiste" --go /lender --absent TP-2026-0141`. The lot is no longer on the marketplace for the losing bidder. Open `/explorer` and the event history shows no second settlement.
- **Proof, the books.** Continue with `--go /explorer --in "Transaction log" --expect "trade settlement" --grab ROW=\d+\t2026-09-14\ttrade settlement\t[^\n]* --in "" --expect Balanced --shot explorer`. The captured row names Tang Mei-Hua as actor, `USDC` as funding and `244,625.0000` as the source debit. Books reads `Balanced`.
- **Withdraw instead.** On a fresh seed, run `node scripts/drive.mjs --run offer-withdraw --as "Tang Mei-Hua" --go /supplier/offers --in TP-2026-0141 --click "Withdraw listing" --in "" --go /supplier --in TP-2026-0141 --expect "Request financing" --absent "Listed (locked)"`. The holding unlocks and can be listed again.

## Gotchas

- Accepting re-renders the whole offers screen and the listing's section disappears with its success notice. `--expect Receipt` after `--click Accept` fails even when the trade succeeded. Prove it from the header balance, the supplier holdings, the lender portfolio and the explorer instead.
- Scope `--in` to the bidder's company name, not the reference: the reference matches the whole section and the first `Accept` on the page is Meridian's only by luck.
- The lender's XUSD balance does not move for a bid funded in USDC. Check the asset the bid named.
- A bid the lender cannot fund shows `Can pay` no, and accepting it is refused. That is behaviour, not a harness failure.
- The runbook's own payable, from [Issue a payable](./issue-payable.md), is a different listing from the seeded `TP-2026-0141`. Either works; do not mix their figures.
