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

## Removing a user, when the PRD says "delete"

Section 5 says "the admin account can delete all other users from the platform"
and does not say what happens to what they did.

**Built:** removal deactivates the account rather than deleting the row. Every
journal entry names the user who made it, so deleting the row would break the
audit trail at the first entry that person authored — and section 10 requires a
receipt reopened from history to be identical to the one shown at confirmation.
A removed account leaves the persona switcher, cannot act again, and its history
stays readable under its name. The accounts screen shows how many entries each
account authored, so an admin can see what they are leaving behind.

**Two removals are refused.** The StraitsX administrator, because section 5 says
there is exactly one. And the last live account of an organisation, because a
wallet is reached through its users: removing the last one would leave whatever
that organisation holds on the books with nobody able to act on it. The seed
gives four organisations a second account so the control is demonstrable on a
fresh world.

## Suppliers on the ERP register versus suppliers on the platform

Not every supplier ADATA buys from has an account. The seed has twelve tier-2
suppliers who originated the invoices in the series lot, sold their whole
position, and have no live account — which is a real state, not a broken one.

**Built:** manual entry only offers suppliers with a live account, and
`ledger.post()` refuses a payable raised against one without. A payable issues
to its supplier's wallet and then waits for that supplier to accept delivery
(section 3 question 7), so a supplier who cannot sign in could never take it and
the payable would strand at issuance. The ERP import path cannot reach this,
because the register only names onboarded suppliers.

## Onboarding without documents

Section 8 screen 5 says "mark the account KYC verified on submit. No document
upload and no external wallet connection required," and notes that real
production would need documents.

**Built:** onboarding creates the organisation, mints a custodial wallet in the
same shape as every seeded address, marks the account verified, and switches the
session to it. The screen says plainly that a real launch would require
documents and that this marks the account verified on submit so the flow can be
shown end to end. Only a supplier or a lender can be onboarded; the anchor and
the platform are fixtures of this programme, and section 5 names exactly one of
each.

## What a programme limit is a limit on

Section 8 screen 14 asks for "configurable programme limits" and section 5 gives
the StraitsX admin the power to "set programme limits", but neither says what a
limit caps or what happens when it is reached.

**Built:** a cap on the anchor's **currently outstanding** face, not on
cumulative issuance. An issuance that would take the anchor over it is refused
at `ledger.post()`, and redemption returns face to the unissued account and
frees the headroom again. Outstanding is the reading the certification screen
already used when it showed "currently outstanding" and "headroom"; capping
cumulative issuance instead would mean a programme that eventually stops
working however promptly it pays.

**Also enforced:** the issuer's certification status. A suspended or uncertified
anchor cannot issue. Payables already issued are untouched and still settle at
maturity, because suspending an issuer is a statement about new business, not a
repudiation of existing obligations.

**Lowering a limit below what is outstanding is allowed.** An issuer being wound
down should stop issuing, not have its existing obligations invalidated. The
screen warns before the change and shows the breach afterwards rather than
hiding it; issuance stays blocked until the book falls back under the limit.

**A cleared limit is null, not zero.** Null means uncapped; zero would mean no
issuance at all. The screen says "none set, issuance uncapped" and shows no
headroom figure rather than showing zero.

**Why this was worth doing at all:** before this, the limit was stored,
displayed, and enforced nowhere. A number on a screen that no code consults is
worse than no number, because it invites a viewer to believe a control exists.
