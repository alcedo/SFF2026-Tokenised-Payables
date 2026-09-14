# Advance time and settle

Advance time and settle moves the demo clock so payables mature, then lets ADATA fund settlement of what is due in any of four assets, paying face to whoever holds each payable. Advancing the clock never funds anything; settlement is always an explicit act with a chain receipt, and the explorer's books must still balance afterwards.

## Sub-features

- `clock-advance` moves the world date by a day, by thirty days, or to the next maturity, and every tenor and yield on screen re-ages at once.
- `settle-due` lists matured and overdue payables with their current holders and quantities.
- `settle-asset` chooses the funding asset and shows the conversion and source debit for it.
- `settle-fund` pays face to every holder and removes the payable from the due list.
- `settle-short` disables funding in an asset ADATA cannot cover, naming the asset.
- `settle-realised` shows the lender's position as realised at face.

## How to get to it (user POV)

- The clock is in the `Demo controls` bar on every screen: `+1d`, `+30d` and `Next maturity`.
- As the ADATA preparer, choose `Settlement` in the navigation, or open `/adata/settlement`.
- The result is read on the lender's `Portfolio`, `/lender/portfolio`, and on the `Explorer`, `/explorer`.

## Driving it with drive.mjs

Preconditions:

- Fresh seed at T0. One payable is already due: `TP-2026-0119`, 75,000.00 XUSD, overdue 45 days, held by Fu Hsing Plastics. The settlement screen reads `Payables due` 1 and `Total obligation` 75,000.00 XUSD.
- ADATA's header balances at T0 are 38,657,000.00 XUSD and 5,000,000.00 XSGD, with no USDC or USDT.
- For `settle-realised`, a lender holds a payable that matures within the advance, such as `TP-2026-0141` bought in [Accept an offer](./accept-offer.md), which matures at T0 + 90.

- **Read what is due.** Run `node scripts/drive.mjs --run settle-due --as "Wei-Ling Chen" --go /adata/settlement --expect "Payables due" --in TP-2026-0119 --expect Overdue --expect "Fu Hsing Plastics" --expect "75,000.0000" --shot due`. The section for the payable lists its holder, wallet, quantity and XUSD credit, then the funding asset buttons.
- **Choose XSGD and read the conversion.** Continue with `--press XSGD --expect "Conversion" --expect "1 XUSD = 1.3100 XSGD" --expect "Source debit" --expect "98,250.0000 XSGD" --expect "ADATA XSGD balance" --shot xsgd`. 75,000 XUSD of face costs 98,250.0000 XSGD at 1.31.
- **Try an asset ADATA cannot cover.** Continue with `--press USDC --expect "ADATA USDC balance" --expect "0.00 USDC" --expect "ADATA holds less USDC than this settlement costs" --disabled "Fund settlement" --shot short`. The notice names the asset and points at `Simulate top-up`, and the funding button is disabled. Press `XSGD` again before funding.
- **Fund settlement.** Continue with `--press XSGD --shot before-fund --click "Fund settlement" --in "" --go /adata/settlement --absent TP-2026-0119 --expect "Nothing is due" --shot after-fund`. The payable leaves the due list.
- **Proof, holder paid.** Continue with `--as "Hsieh Wan-Ju" --go /supplier --grab AFTER="XUSD balance\n[\d,]+\.\d\d" --shot holder-balance`. Fu Hsing Plastics' XUSD balance is up by 75,000.00. Grab the same figure as `BEFORE` at the start of the run to have both in `steps.log`.
- **Proof, the record.** Continue with `--go /explorer --in "Transaction log" --expect redemption --grab ROW=\d+\t\d{4}-\d\d-\d\d\tredemption\tTP-2026-0119[^\n]* --in "" --expect Balanced --shot explorer`. The captured row reads `redemption`, `TP-2026-0119`, `Wei-Ling Chen`, `XSGD`, `98,250.0000`, and Books reads `Balanced`.
- **Advance the clock.** Run `node scripts/drive.mjs --run clock-advance --as "Wei-Ling Chen" --go /adata --grab T0="T0" --press +30d --press +30d --press +30d --expect "T0 + 90d" --shot t90 --go /adata/settlement --text`. The demo bar reads `T0 + 90d` and every payable maturing within 90 days is now listed as due. `Next maturity` jumps straight to the next due date instead.
- **Settle a lender-held payable.** With `TP-2026-0141` bought by Meridian Trade Bank, continue with `--in TP-2026-0141 --expect "Meridian Trade Bank" --expect "250,000.0000" --press XSGD --expect "327,500.0000 XSGD" --shot runbook-settlement --click "Fund settlement" --in "" --go /adata/settlement --absent TP-2026-0141`. 250,000 XUSD of face costs 327,500.0000 XSGD.
- **Proof, realised.** Continue with `--as "Rina Okafor" --go /lender/portfolio --in "Realised" --expect TP-2026-0141 --expect "250,000.00" --expect Settled --shot realised`. The position moved from holdings to realised at face, and her XUSD balance is up by 250,000.00 to 6,770,000.00.

## Gotchas

- Advancing the clock funds nothing. The due list grows; balances do not move until `Fund settlement`.
- The clock is global. Every connected session and every later run sees T0 + 90d until the world is reset. Reset before a run that assumes T0.
- Several seeded payables mature at T0 + 90. Scope every step to one reference with `--in`; the first `Fund settlement` on the page is not necessarily yours.
- The funding buttons on the settlement screen have no confirm step; `Fund settlement` does. Use `--press` for the asset and `--click` for the funding.
- Conversion figures are exact to four decimals and rounding is stated on the confirmation. Assert the figure as printed, not a rounded one.
- The holder of a payable is whoever holds it at settlement, which after a trade is the lender, not the original supplier. Check `Current holders` on the settlement section before predicting whose balance moves.
- An unseeded deployment gives ADATA no XSGD, so every asset but XUSD reads short. That is the fixtures path, not a defect.
