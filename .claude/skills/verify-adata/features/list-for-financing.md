# List for financing

List for financing lets a supplier take delivery of a payable issued to their wallet, read what selling it today costs against their bank's rate, and publish all or part of it to the marketplace at a minimum price, with an optional buy-now price.

## Sub-features

- `list-accept` accepts an incoming payable from the inbox, or declines it.
- `list-compare` shows proceeds, cost given up, annualised financing cost and the bank benchmark for each holding.
- `list-whole` publishes the full holding at a minimum price.
- `list-part` publishes part of a holding and keeps the remainder.
- `list-buy-now` attaches an optional buy-now price that the lender is offered unchanged.
- `list-locked` marks a listed holding as locked so it cannot be listed twice.

## How to get to it (user POV)

- As the supplier, choose `My tokenised payables` in the navigation, or open `/supplier`. An issued payable waits there under `Awaiting your acceptance`.
- Choose `Request financing` on a held, unlisted payable. It opens `/supplier/finance/<id>`.

## Driving it with drive.mjs

Preconditions:

- Acting as `Tang Mei-Hua`, the supplier at Chien Yu Precision.
- Fresh seed at T0: the supplier holds `TP-2026-0141`, already listed and locked, and 200,000.0000 of `TP-2026-0152`, held and unlisted with a `Request financing` link. The header XUSD balance is 378,723.50.
- For `list-accept`, a payable issued by [Issue a payable](./issue-payable.md) is waiting in the inbox. The other steps work on the seeded `TP-2026-0152` without it.

- **Accept delivery.** Open the inbox and accept. Run `node scripts/drive.mjs --run list-accept --as "Tang Mei-Hua" --go /supplier --in "{REF}" --expect "Awaiting your acceptance" --shot inbox --click Accept --in "" --go /supplier --in "{REF}" --absent "Awaiting your acceptance" --expect "Request financing"`. The payable becomes a holding with the financing comparison under it. A `Decline` button sits beside `Accept`.
- **Read the comparison.** Run `node scripts/drive.mjs --run list-compare --as "Tang Mei-Hua" --go /supplier --in TP-2026-0152 --expect "Sale proceeds at 97.85%" --expect "195,700.00" --expect "Annualised financing cost" --expect "7.8%" --expect "Your bank quotes" --expect "18.0%" --shot comparison`. For 200,000 held over 100 days the proceeds are 195,700.00, the cost is 7.8%, and the bank benchmark is 18%.
- **Open the form.** Continue with `--link "Request financing" --expect "Request financing" --shot form`. The form has `Quantity to list` defaulting to the full holding, `Minimum price as a percentage of face` defaulting to 97.85, and `Buy now price` reading `leave blank for bids only`.
- **List part of it.** Continue with `--fill "Quantity to list=100000" --expect "Remainder you keep" --expect "100,000.0000 XUSD"`. The preview shows `Listed face` 100,000.0000 XUSD and the remainder kept. Refill with `--fill "Quantity to list=200000"` to list the whole holding.
- **Set a buy-now price.** Continue with `--fill "Buy now price=196500" --shot buy-now-set`. The preview keeps `You receive on sale` at the minimum price; buy-now is what a lender may pay to take the lot at once.
- **Publish.** Continue with `--click "Publish listing" --go /supplier --in TP-2026-0152 --expect Listed --expect "Listed (locked)" --absent "Request financing" --shot listed`. The holding is marked listed and locked, and the link is gone.
- **Proof.** Run `node scripts/drive.mjs --run list-proof --as "Rina Okafor" --go /lender --in TP-2026-0152 --text --in "" --link TP-2026-0152 --expect "Buy now" --expect "196,500.00" --shot lender-sees-it --as "Tang Mei-Hua" --go /supplier/offers --in TP-2026-0152 --expect "listed at 97.85%" --expect "Withdraw listing" --shot offers-empty`. The marketplace shows the new lot, the lender's detail offers the buy-now price the supplier typed, and the offers screen shows the listing with no bids yet.

## Gotchas

- A listed holding cannot be listed again: `TP-2026-0141` shows `Listed (locked)` on a fresh seed and has no `Request financing` link. Use `TP-2026-0152` for a fresh-seed run.
- The price field is a percentage of face, not an amount. `97.85` is right; `244625` is wrong.
- The buy-now price is an amount in XUSD, not a percentage. It must beat the minimum price or the lender is offered nothing useful.
- Figures in the comparison depend on days remaining. Advance the clock and every figure changes; assert after checking `--text`.
- `Decline` on an inbox item returns the payable to ADATA. Do not decline the runbook's payable unless that is the behaviour under test.
- The supplier's header balance is the second view for every trade on this screen. Note it before and after.
