# Assumptions and open questions

Every entry is a place the PRD is silent, self-contradictory, or points at a
section that does not exist. Each one records what was built and what it would
cost to change. Nothing here was decided to save effort; these are all cases
where the document ran out before the build did.

## Dangling cross-references in the PRD — resolved

The PRD used to point at a §16 and a §19 that were never written. Confirmed with
the author that both were left in by mistake; the references have been removed
from the PRD itself.

The five-minute presenter script the "Complete story" criterion needs is
`docs/RUNBOOK.md`, written from the flow the rest of the PRD describes and
verified end to end by `npm run verify:runbook`.

The advance-rate / LTV mapping is still genuinely undefined. Nothing displays
one.

## Supplier acceptance of receipt

Section 3 question 7 says the supplier "will have an option to accept the
tokenised payable or reject it". The section 7 lifecycle diagram has no state
for it, and no section says what a rejection does to the obligation.

**Built:** `app.payable.receipt_status` (`pending`, `accepted`, `rejected`), set
to `pending` at issuance. It is delivery state on the payable, not a lifecycle
state, so the section 7 obligation diagram stays exactly as the PRD draws it. A
pending payable appears in the supplier's inbox with Accept and Decline, and
cannot be listed or transferred until accepted. Declining returns the full
quantity to the anchor's wallet and records an event; the obligation stays
`issued`, held by ADATA.

**Why this way:** returning the quantity keeps the section 13 rule that holdings
sum to outstanding face. Burning it would break that rule, and section 4 puts
operational cancellation out of scope, so there is no cancelled state to move to.

**If wrong:** the change is confined to the `reject_receipt` branch of
`ledger.post()` and the two acceptance gates on listing and transfer.

## Overdue grace period

Section 7 asks the overdue view to show "grace-period information" but never
gives a number.

**Built:** the grace period is zero days, so a matured payable reads as overdue
the day after its due date. Section 11's "Trigger overdue" control activates the
seeded example directly, which is how the demo is meant to reach this screen.

## Direct purchase, not a lending pool — settled

No longer an assumption. Confirmed with the author: a lender buys the payable
and holds it, and ADATA pays whoever holds it at maturity. Lending through a
pool with licensed intermediaries is **not** being built, now or later. The PRD
§9 text has been updated to say so.

## Advance rate / LTV

Section 15 says an advance-rate/LTV mapping is "pending definition" and warns
against presenting grades as an external rating or guarantee.

**Built:** nothing. Grades are shown as assigned demo values with their
rationale, and no advance rate is displayed anywhere.

## Duplicate transfer screen

Section 8 lists "Transfer" as screen 13 under Lender, then lists "Send payable"
again as item 1 under "Common to all users". The two describe the same flow with
the same rules.

**Built:** one shared transfer flow reachable by both supplier and lender, which
is what screen 13 already says it is ("shared supplier/lender flow").

## Seed figures the PRD asks us to derive

Section 12 states two rows incompletely and explicitly delegates the rest:

- **TP-2026-0128 (settled), 320,000 face, 9.2% realised.** The PRD says this row
  "needs a historical purchase price and holding period that support the
  displayed 9.2%". Built as purchased at 312,900 XUSD (97.78% of face) and held
  90 days, which yields 9.203% and rounds to the stated 9.2%.
- **TP-2026-0119 (overdue), 75,000 face.** The PRD says this row "needs an
  explicit due date and sample recovery timeline". Built with a due date 45 days
  before T0 and a fictional recovery timeline on the overdue screen.

## The XSGD rate reads two ways, and one of them is wrong by 72%

Not an assumption. A trap, recorded because a careful reader will hit it and a
careless one will ship the wrong number.

Section 6 states the rate as **"1 XUSD = 1.31 XSGD"**. Section 10 states the
arithmetic as **"source debit = XUSD obligation / rate, where rate is XUSD per
1 XSGD"**.

Those agree. Section 10's rate is XUSD per XSGD, which is 1/1.31 = 0.7634, so
dividing by it multiplies by 1.31. Discharging a 244,625 XUSD obligation costs
**320,458.7500 XSGD**, and the payer needs more XSGD than XUSD, which is the
sanity check.

The trap is reading section 10's "rate" as the 1.31 from section 6 and dividing
by it. That gives 186,735.88 XSGD, understating the debit by a factor of
1.31² = 1.716. It looks plausible on screen and would be caught by nobody in
the room.

`src/core/fx.ts` holds the rate in the section 6 orientation (XSGD per XUSD,
13,100 scaled) and multiplies, because a multiplication is harder to invert by
accident than a division. The 320,458.7500 figure is asserted in
`src/core/__tests__/pricing.test.ts`.

## Series membership and partial holdings

Section 6 says series membership is a lot-grouping mechanism and section 13
requires every member to be wholly held by one wallet. Section 6 also says
"split holdings are ineligible" for a series.

**Built:** a payable whose quantity is split across wallets cannot join a series,
and a transfer or sale that would split a series member is refused while that
member is in an active series listing.

## Who may reset the shared world

Section 11 asks for a "Reset world" control and warns that the world is shared,
but does not say who may press it. The demo is going out on a public URL that
anyone can open.

**Built:** three gates. `/reset` and the server action both require the
StraitsX admin persona; the phrase RESET must be typed exactly; and if
`ADATA_RESET_PIN` is set in the environment, it must match. Non-admin personas
do not see the control on the demo bar at all.

**What each is worth, honestly:** the persona switcher is open, because section
11 asks for it, so a stranger can become the admin in two clicks. The role gate
therefore stops accidents, not attackers. The typed phrase is what actually
prevents the realistic failure — someone clicking a red button mid-presentation
to see what it does. The PIN is the only real lock, and it is optional so a
laptop demo is not made tedious. When no PIN is set the screen says so rather
than implying a protection it does not have.
