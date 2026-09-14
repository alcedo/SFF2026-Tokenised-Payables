# ADATA Tokenised Payables verification map

This directory is the maintained source for verifying the user-facing behaviour of the ADATA tokenised payables demo. Read this index before driving the app, then use the matching feature file as the recipe. Each file is written for an agent that has never seen the app.

The harness is `scripts/drive.mjs`. Its header lists every step. `node scripts/drive.mjs` with no steps prints usage.

## Baseline preconditions

- The app is serving at `http://127.0.0.1:3100`. `scripts/serve.sh` resets the database, builds, starts, and waits for `/lender` to answer. `scripts/serve.sh --keep` starts without resetting.
- The world is at T0 with the seed from `db/seed.sql`: `scripts/db.sh reset`, or the admin persona's Reset world screen. Every recipe assumes a fresh seed unless its preconditions say otherwise.
- Only one instance runs at a time. There is one database, one port, and the demo clock and Reset world land on every connected session. Never drive a server this run did not start.
- The five acting personas, selected by name fragment with `--as`:
  - `Wei-Ling Chen` is the ADATA preparer.
  - `Hsu Po-Chun` is the ADATA checker.
  - `Tang Mei-Hua` is the supplier at Chien Yu Precision.
  - `Rina Okafor` is the lender at Meridian Trade Bank. `Sébastien Baptiste` at Kestrel Credit Fund is the second lender.
  - `Nadia Rahman` is the StraitsX admin.

## Driving conventions

- Every step is a `--flag value` pair, run in the order given. `--as` switches persona through the real control and reloads. `--go` opens a path.
- `--click` presses a named button and confirms it when a `Confirm: <name>` button appears. Every write in the app is armed then confirmed, so `--click` is the verb for anything that changes state.
- `--press` is for buttons with no confirm step: asset pickers, grade filters, `+30d`, `Next maturity`. `--select "Label=option text"` is for dropdowns. `--tap "text"` clicks anything else by its visible text, such as a disclosure summary.
- `--disabled "name"` asserts a button is shown but disabled. The app refuses by disabling and explaining, not by hiding, so `--absent` on the button's name is the wrong check.
- `--in "text"` scopes the following steps to the smallest section or table row containing that text. `--in ""` clears it. A `--go` or `--link` also clears it.
- `--expect` and `--absent` match case-insensitively, because the stylesheet uppercases labels and `innerText` reflects that.
- `--grab NAME=regex` captures text; later steps may write `{NAME}`. Use it for the reference the system assigns to a new payable.
- Prefer `--expect` on a state over `--wait`. Use `--text` to read a state you did not predict, before asserting on it.
- Every seeded figure quoted below was read from the running app at T0. If a figure does not match, read the page with `--text` before deciding the app is wrong.

## Proof and skip reporting

- Name each run with `--run <feature>-<what>`. Evidence lands in `out/drive/<run>/`: a numbered `steps.log`, screenshots from `--shot`, accessibility snapshots from `--aria`, and `fail.png` on a failed step. The harness never deletes evidence.
- Capture the action and the resulting state, not only the final screen: a `--shot` before the `--click` and one after.
- Every write must be proved from a second, read-only view: the counterparty's screen, the explorer's transaction log, or the balance in the header. A success notice alone is not proof, and on some screens the notice disappears with the re-render.
- The explorer's Books figure must read `Balanced` after every mutation. It is the live journal proof, and an unbalanced book is a defect however the screens look.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behaviour.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with drive.mjs` starts with `Preconditions:` and uses labelled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

These five make up the PRD's headline path, issue → list → bid → accept → advance time → settle. Run them in order for the whole demo, or any one alone from the preconditions it names.

- [Issue a payable](./issue-payable.md) covers ERP import and manual entry, maker-checker approval, grading, certification, the programme-limit refusal, and issuance to the supplier wallet.
- [List for financing](./list-for-financing.md) covers accepting delivery from the inbox, the financing comparison, listing whole or part, and the optional buy-now price.
- [Bid or buy now](./bid-or-buy-now.md) covers the marketplace filters, series expansion, the payable detail, bidding in any of four funding assets, and buying outright.
- [Accept an offer](./accept-offer.md) covers the offers table, atomic settlement of the chosen bid, expiry of competing bids, and withdrawing a listing.
- [Advance time and settle](./advance-and-settle.md) covers the demo clock, the settlement screen, funding in any asset with its conversion, and the explorer's redemption record.

Not yet mapped, and so not yet proven through the browser: transfer between wallets, onboarding and account removal, the reset guards, Trigger overdue and recovery, issuer suspension, wallet top-up, and Jump to next maturity. `scripts/runbook.mjs` drives some of these inside its fixed sequence.
