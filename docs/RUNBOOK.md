# Five-minute demo runbook

The PRD's headline acceptance criterion (section 2) reads: "A viewer can issue →
list → bid → accept → advance time → settle within five minutes, following §19."
Section 19 does not exist; the PRD ends at section 15. This runbook is written
from the flow the rest of the document describes. If a real section 19 turns up,
reconcile the two before the dry runs.

The run uses the seeded unissued ERP invoice from section 12, which exists
precisely so the pitch can issue and list a new position without colliding with
the three payables already listed at T0.

**Before starting:** press **Reset world** in the demo controls. Every step below
assumes the clock is at T0 and balances are seeded.

---

## 0. Set the scene (20 seconds)

Stay on the marketplace as the lender persona.

> "Three approved ADATA invoices, already tokenised, already for sale. A bank can
> see what it is underwriting before it commits: the anchor obligor, the grade,
> the tenor, the yield."

Point at the ribbon. Everything here is simulated; no funds move.

## 1. Issue (60 seconds)

Switch to **ADATA preparer**.

1. **Create payable** → **Import from ERP**. Pick the seeded 250,000 XUSD invoice
   payable to the active supplier, 90 days.
2. Submit for approval.
3. Switch to **ADATA checker**. Open the approval queue and approve it.

> "Maker and checker are different people. The preparer cannot approve their own
> submission."

4. Switch to **StraitsX admin**. Certify it and assign grade AA with a rationale.
5. Issue. The full quantity mints to the supplier's wallet.

> "One invoice, one token ID. The whole face value lands with the supplier."

## 2. List (45 seconds)

Switch to **supplier**.

1. **My Tokenised Payables** → accept the incoming payable from the inbox.
2. Open **Request financing**. The listed quantity defaults to the full holding.
3. Enter **97.85%** as the price.

Stop here and read the comparison out loud. This is the number the audience came
for:

> "Face 250,000. At 97.85% the supplier receives **244,625 XUSD today**, giving up
> **5,375**. Annualised, that financing costs **8.7%**. Their bank quotes 18%."

4. Publish. It appears on the marketplace.

## 3. Bid (45 seconds)

Switch to **lender** (the bank, funded mostly in USDC).

1. Open the new listing from the marketplace. The detail screen leads with ADATA
   as the anchor obligor, not with the supplier.
2. **Place bid** at 97.85%. Select **USDC** as the funding asset.
3. Confirm. Note the conversion line: USDC funds an XUSD obligation 1:1, so the
   debit is 244,625 USDC and the seller is credited 244,625 XUSD.

> "The lender is not underwriting a small Taiwanese supplier. They are
> underwriting ADATA's obligation to pay in 90 days."

Optionally switch to the second lender and bid slightly lower, so the seller has
a choice to make on the next screen.

## 4. Accept (30 seconds)

Switch back to **supplier**.

1. **Offers received** shows the bids with price, percentage of face, implied
   yield and funding asset.
2. Accept the 97.85% bid.

One operation moves everything: the lender is debited, the supplier is credited
244,625 XUSD, the quantity moves, the listing closes, and any competing bid
expires. Show the transaction receipt, labelled simulated.

> "The supplier has their cash. Ninety days early."

## 5. Advance time (20 seconds)

Open **Demo controls** → **Jump to next maturity**, or press **+30 days** three
times.

Every days-remaining figure and every yield on screen re-ages at once. The
payable moves to **Matured**.

> "Nothing else changed. Maturity does not depend on who holds it or whether it
> was ever financed."

## 6. Settle (45 seconds)

Switch to **ADATA preparer** (or checker).

1. **Settlement** lists what is due, with the current holder and quantity.
2. **Fund settlement**. Choose the funding asset, review the conversion and the
   per-holder credit, confirm.

The lender receives 250,000 XUSD against the 244,625 they paid. The payable is
marked **Settled** and cannot move or settle again.

> "The lender's gross return is the 5,375 discount. The supplier got paid
> early. ADATA paid once, on the date it always owed."

---

## The partial-quantity variation (add 60 seconds if asked)

The seeded listings are whole holdings so the story above stays a clean
full-invoice narrative. Partial quantities are live in the product, and this is
the strongest follow-up when a bank asks about ticket size:

1. As the supplier, list **100,000** of a 250,000 holding rather than all of it.
2. Sell that portion to one lender.
3. Transfer **50,000** of the remaining 150,000 to another supplier wallet.
4. Fast-forward to maturity.

At settlement ADATA funds 250,000 once and it splits three ways, in proportion to
quantity held, to the three current holders. The credits reconcile to the debit
exactly.

## The overdue case (add 30 seconds)

**Demo controls** → **Trigger overdue** opens the seeded recovery example
(TP-2026-0119, 75,000 face, past due). It is a read-only scenario with a grace
period, recovery status, and a fictional appointed liquidator. There is no
operational recovery workflow behind it, and the screen says so.

---

## If something goes wrong at the booth

- **A figure looks wrong.** Every yield on screen comes from one function. Check
  the days remaining first; the clock is the usual culprit.
- **The world looks wrong.** Reset restores everything including the clock and
  the FX rate. It affects every connected session, so warn anyone else on a
  second screen first.
- **An action is refused.** The refusal states its reason inline. Insufficient
  balance and a stale listing are the two that come up; neither changes any
  balance or position.
