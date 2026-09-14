# PRD — ADATA Tokenised Payables Demo

**Product:** Clickable web demo of the ADATA tokenised payables programme
**Partners:** StraitsX × ADATA × BaaS Innovations
**Target:** Token2049 Singapore, 7–8 Oct 2026, Marina Bay Sands
**Requirements lock:** 19 Sep 2026 (see §18 — this is earlier than the SFF date and it matters)
**Chain:** Mocked now, testnet later
**Status:** Draft for review

---

## 0. Read this first

This is a **mock**. No chain, no money, no real ADATA data. It exists so a BaaS or bank person can click through the whole flow and understand the product in five minutes.

Two naming points, so nobody repeats them at a booth:

- **BLOOM is MAS's initiative, not ours.** MAS launched BLOOM in Oct 2025 (Borderless, Liquid, Open, Online, Multi-currency) for tokenised bank liabilities and regulated stablecoins. Aligning with it is an ambition. We have no BLOOM status to claim, and §17 says the demo must not imply MAS approval. So the programme is "StraitsX × ADATA × BaaS tokenised payables", not "Project BLOOM".
- **It is "tokenised payables" by habit, "receivables" by substance.** Daniel raised this on 6 Aug. The instrument is the supplier's receivable. We keep the TP name because every deck and channel already uses it, but don't let a banker catch us using both loosely in one sentence.

---

## 1. The problem

ADATA buys components from hundreds of small Taiwanese suppliers and pays on 30–180 day terms. Those suppliers need cash now, so they borrow against the invoice.

| Who | Cost of money | Source |
|---|---|---|
| Supplier borrowing from a bank | ~18% | 12 Aug ADATA discussion |
| ADATA's own cost of funds | ~5% | 12 Aug ADATA discussion, off a ~$400M net profit base |

**The spread is the product.** The supplier is being priced on their own small balance sheet when the money is actually owed by a Taiwan-listed company. Tokenise the payable and the lender underwrites ADATA's credit instead, so the supplier gets financed somewhere in between.

ADATA gains too: supplier terms get extended without new debt on its balance sheet, and well-financed suppliers mean supply security.

Everything in this demo exists to make that one paragraph land in five minutes.

---

## 2. Audience and success

**Who this is for, in order:**

1. **Banks and FIs at the booth** — the people who might fund a pilot tranche. They are the hardest audience and the reason the credit screens have to be right.
2. **BaaS's Singapore client list** — the prospects BaaS and ADATA have already lined up. James (BaaS CEO) is at Token2049 representing both.
3. **Ourselves** — the demo forces us to decide the product, which is the real deadline (§18).

**Success looks like:**

A BaaS or bank person clicks through it alone, without James narrating, and comes away able to explain the product to their own credit team. If they need us standing next to them, the demo failed.

Concretely, on screen:

- **It looks like a working product, not a prototype.** Real-looking data everywhere, no lorem ipsum, no empty states, no "coming soon" buttons. Every screen has seeded history behind it so nothing looks like it was born five seconds ago.
- **Banker-grade, not crypto-grade.** Reads like a treasury or trade-finance portal. Muted, dense, tabular. No gradients, no glow, no wallet-connect aesthetic, no token tickers scrolling. A credit officer should recognise the furniture.
- **The credit story is the loudest thing on the lender screens.** Payable detail leads with the anchor obligor and grade, not the supplier. If a banker looks at that screen for ten seconds and thinks they're underwriting a small Taiwanese vendor, we've lost the pitch.
- **The supplier contrast is visible without clicking.** 8.9% vs 18% sits on the supplier dashboard, not buried in a flow.
- **Five minutes, end to end**, issue → accept → list → bid → accept → fast-forward → settle, with no dead ends, no errors, no page a persona can reach that isn't built.
- **Obviously a demo, never mistakable for live.** Permanent "Demo environment — no real funds" ribbon, demo controls visually separated from product UI. Nobody should walk away thinking this is in production or MAS-approved.
- **Recoverable in one click.** Reset world puts it back to seed between pitches, so a botched run costs nothing.
- **Fast.** Under 500ms per action. Lag reads as a broken product, not a mock.

Failure looks like: a pretty landing page with a "Launch app" button and three screens behind it.

---

## 3. The questions the demo must answer

| # | Key question | Screen / flow that answers it | Description |
|---|---|---|---|
| 1 | How does a supplier receive a tokenised payable? | Payables inbox / supplier dashboard | The issuer (ADATA) issues the tokenised payable on the platform. The supplier receives and views it on their dashboard. |
| 2 | How does a supplier sell a tokenised payable for financing? | Marketplace listing flow / supplier action | After accepting it, the supplier lists it **in XUSD** on the central marketplace so banks and FIs can bid to finance it. Listing currency is XUSD only. |
| 3 | How do banks and FIs select payables to finance, and what do they see? | Lender marketplace / payable and credit detail | Banks and FIs browse the marketplace, review the payable and credit details, and bid or offer directly on it. |
| 4 | How does a supplier transfer a payable without listing it? | Transfer / wallet assignment | The supplier can send the token to another wallet on the platform (group treasury, another party) instead of listing it. |
| 5 | What if the supplier does not sell? | Hold-to-maturity / payable detail | The supplier keeps the token until maturity. The issuer must then repurchase it at full face value. |
| 6 | How is a tokenised payable created and issued? | Issuer create / approval flow | The issuer creates the payable from an approved invoice and sets terms (amount, due date). **Currency is always XUSD** — the payable cannot be issued or listed in another asset. |
| 7 | Does the supplier have to accept it? | Accept / reject inbox action | **Yes.** The supplier confirms the payable is correct before it can be listed, transferred, or held. This is the opt-in moment and the consent record legal wants. Rejection returns it to the issuer. |
| 8 | How does bidding close and who wins? | Bid book / accept offer | The supplier accepts a bid; other bids expire. Show rate, amount, tenor, and bidder. |
| 9 | How does the supplier get paid after a sale? | Settlement / funding confirmation | The winning FI pays the discounted **XUSD** price from an allowed funding source (**USDC / USDT / XSGD / XUSD**); the token moves to the FI; the supplier is credited in XUSD. |
| 10 | What happens at maturity? | Maturity / issuer redemption | The issuer **must repurchase the entire token at face value** from the current holder. If an FI bought at a discount, profit = face value − purchase price. If the supplier held it, they receive full face value. |
| 11 | What can an FI do after they buy? | Lender portfolio / position detail | Hold to maturity for the issuer buyback and the discount profit, or re-list or transfer the token. Show purchase price, face value, implied yield, and days to redemption. |
| 12 | How is the tokenised payable represented on-chain? | Token standard / token detail | Each tokenised payable is an **ERC-1155** token, one token id per invoice. For this demo, **4 decimal places**: XUSD 1.0000 face = **10,000 base units**. UI amounts are human-readable XUSD; on-chain balances are base units (`amount × 10⁴`). ERC-1155 has no native decimals field, so this is a metadata convention we set, not a standard feature. |
| 13 | What is the payable listed in, and how is it funded? | Listing / bid / fund settlement | The TP is **always listed, priced, bid, and redeemed in XUSD**. The payer (lender on purchase, ADATA at maturity) picks a **funding source**: **USDC, USDT, XSGD, or XUSD**. Funding is a payment rail, not a second listing currency. |
| 14 | What gives the lender a claim against ADATA? | Assignment record on the sale confirmation | On sale, the platform generates a Contract of Assignment and a notice of assignment to ADATA, both shown and stored against the payable. See §6 — this is the answer to "what's my recourse", and our own pitch deck already promises it. |

Out of demo scope: disputed or wrong invoices, cancellation after mint, and issuer non-payment beyond the single seeded overdue example.

---

## 4. Scope

### In
- Four personas, switchable (§5)
- Signup, mock KYC, custodial wallet with a displayed 0x address
- Mock ERP invoice import → payable creation → maker-checker approval → mint
- StraitsX certification and credit grading
- Supplier accept / reject on receipt
- Supplier: hold to maturity, or list for financing
- Marketplace: listings, bids, accept-bid, buy-now — **listings locked to XUSD**
- Funding source picker on buy and on maturity settlement: **USDC / USDT / XSGD / XUSD**
- Contract of Assignment and notice-of-assignment artefacts on sale (mock PDF plus event, §6)
- Peer-to-peer transfer by wallet address
- Per-asset stablecoin balances with a "simulate top-up" button (pick which asset)
- Maturity, settlement to whoever holds it, and one overdue example
- Time fast-forward, world reset, seeded history

### Out
- Any real chain, wallet signing, or gas
- Real KYC/AML, sanctions, accreditation checks
- Real money, on-ramp, off-ramp, fiat
- Actual ERP integration (we mock the import screen only)
- A real credit model — grades are assigned by hand in the admin view
- Aave vault / XTP rolling-token phase 2
- Fractional ownership of a single invoice (see §6, we bundle instead)
- Multi-tenancy, multiple anchor buyers beyond ADATA
- Real legal docs, real e-signature, invoice verification
- Listing or issuing a payable in USDC, USDT, or XSGD (funding only)

---

## 5. Personas

**1. ADATA finance (anchor buyer / issuer)**
Owes money to suppliers on 30–180 day terms. Issues the payable **in XUSD**. Pays XUSD face value at maturity to whoever holds it, funded from USDC / USDT / XSGD / XUSD. Never receives cash from this product.

*For anyone writing screen copy:* ADATA Technology Co., Ltd. is Taipei Exchange listed (ticker 3260), founded 2001, New Taipei City. It makes memory and storage — DRAM modules, SSDs, flash — and is the second-largest maker of DRAM modules and branded SSDs globally. Internal notes have called it "the largest semiconductor distributor in Asia Pacific"; public sources don't support that phrasing, so keep it off the screens and out of the script.

**2. Supplier (first holder)**
A small vendor supplying ADATA on credit. Currently borrows at roughly 18%. Receives the TP, accepts it, then chooses: hold to maturity for full XUSD face value, or sell now at a discount for XUSD today. The buyer may fund that purchase in USDC / USDT / XSGD / XUSD. The framing to keep in mind: a large company orders from a small supplier, and the small supplier has to find its own financing to fulfil that order.

**3. Lender / investor (bank, fund, corporate treasury)**
Buys the TP at a discount, priced in XUSD. Pays with USDC / USDT / XSGD / XUSD. Gets XUSD face value at maturity. Underwriting the anchor's credit, not the supplier's — that's the pitch.

**4. StraitsX admin (platform)**
Onboards and certifies issuers, assigns credit grade, admits payables to the marketplace, oversees settlement. The 12 Aug strategy calls the standard-setter role the durable moat, so it should be visible, not hidden.

Persona switching is one dropdown in the demo control bar. No logging in and out during a pitch.

---

## 6. The instrument

**One invoice = one token.** Non-fungible by design, ERC-1155, one token id per invoice.

**Priced as a discount to face, not principal plus interest.** Buy at 97.85, receive 100 at maturity. Two reasons: it's the market convention for receivables, and it keeps us away from "interest" language. On 3 Sep, Legal read the new MAS stablecoin regulation as prohibiting licensed e-money players from paying interest. The UI shows implied annualised yield alongside the price so lenders can compare, but the instrument pays no coupon.

> ⚠️ **The pitch deck contradicts this.** The current deck says the buyer "auto-settl[es] principal + interest to lender". That is the exact word Legal flagged. Fix the deck before Token2049, or the demo and the deck disagree in front of a bank.

**Bullet only.** Single payment at maturity. No coupon schedule. Invoices don't work that way and it doubles the state machine.

**Listed in XUSD only.** Face value, ask, bid, buy-now, and the maturity repurchase are all XUSD. The supplier cannot list in USDC, USDT, or XSGD. A Series is the same: one XUSD face for the bundle.

**Funding source is a payment rail, not the instrument.** When a lender buys, and when ADATA funds maturity, the payer picks one of: **USDC, USDT, XSGD, XUSD**. USD stables (USDC, USDT, XUSD) convert **1:1** into the XUSD obligation. XSGD converts at a **mocked FX rate** shown on the confirmation screen. The token and the books stay in XUSD; the current holder is credited in XUSD.

**No fractionalisation, and the reason is legal, not technical.** For the lender to enforce the debt directly against the buyer, the assignment has to cover the entire debt, not a portion of it (Feb 2025 legal review). Splitting one invoice breaks that. Bundling does not.

**Bundles.** Small invoices can be grouped into a Series by shared maturity date — for example `SERIES-2026-Q4-30D`, twelve invoices, XUSD 180k total. MUFG asked for exactly this on the Amazon deal in Dec 2024: bundle by maturity date so the ticket is big enough to be worth a bank's time, their example being invoices under ~$1,000 grouped up to ~$10,000. A Series is bought and settled as one unit. This gets us the economics of fractionalisation without the fractionalisation wrapper.

**The assignment chain.** Every sale generates two artefacts, both mocked but both visible:

1. **Contract of Assignment (COA)** — generated on sale, shown before confirm, stored against the payable with a mock hash.
2. **Notice of assignment to ADATA** — generated at the same time, telling ADATA to pay the new holder at maturity.

The Feb 2025 legal review set three conditions for a valid legal assignment: a written assignment contract, notice to the corporate buyer, and assignment of the whole debt. The demo shows all three. The pitch deck already promises this, and "what's my recourse" is the first question a credit officer asks.

**Fields on every TP:**

Listing price, bid, and implied yield are marketplace fields, not instrument fields.

| Field | Example | Notes |
|---|---|---|
| Reference | `TP-2026-0141` | Human-readable id. Series use `SERIES-…` |
| Anchor obligor | ADATA Technology Co., Ltd. | Must repurchase at face on maturity |
| Supplier | Chien Yu Precision | Fictional name, §12 |
| Currency | XUSD | Locked. Funding source is separate (USDC / USDT / XSGD / XUSD), §6 and §10 |
| Face value | 250,000.0000 | UI XUSD; on-chain = `× 10⁴`, Q12 |
| Issue date | T+0 | Relative to demo clock |
| Maturity date | T+90 | |
| Tenor | 90 days | Derived, not stored |
| Credit grade | AA | Assigned by StraitsX admin, §8 screen 16 |
| Invoice ref | INV-TW-88213 | Fictional |
| Series | — | Nullable. Set when bundled |
| Status | Listed | Lifecycle in §7 |
| Holder wallet | `0x7a3f…c21d` | Current holder, not original supplier |
| Mint tx | mock hash | Payable-level. Later events live on `Event.chain_ref`, §10 and §13 |

---

## 7. Lifecycle

Happy path, which is also the runbook path:

```
Draft ─▶ Pending approval ─▶ Certified ─▶ Issued ─▶ Accepted ─▶ Listed ─▶ Financed ─▶ Matured ─▶ Settled
         (ADATA checker)     (StraitsX    (minted   (supplier   (on        (sold to
                              grades it)   to        confirms)   market)    lender)
                                           supplier)
```

Branches off that line:

| From | To | Trigger | Note |
|---|---|---|---|
| Draft / Pending approval | Cancelled | Issuer withdraws | Only possible before mint |
| Issued | Rejected → Draft | Supplier rejects | Returns to issuer, §3 Q7 |
| Accepted | Held | Supplier does nothing | Default. Hold to maturity |
| Accepted / Held / Financed | Transferred | Any holder sends to a wallet | Peer-to-peer, no money moves on-platform. Lands back in Held for the new holder |
| Listed | Accepted | Supplier pulls the listing | Unsold listing returns |
| Financed | Listed | Lender re-lists | Secondary, still XUSD |
| Matured | Settled | ADATA funds settlement | Pays XUSD face to the **current holder**, whoever that is. Funded from USDC / USDT / XSGD / XUSD. The moment worth pausing on in a pitch |
| Matured | Overdue | Grace period passes unfunded | One pre-seeded example |
| Overdue | Recovery | Liquidator appointed | One screen, not a built workflow |

**Overdue and Recovery** are a single seeded example, not a real workflow. Banks will ask what happens on default, and "we don't show that" is a bad answer. One screen with grace period, recovery status, and appointed liquidator is enough.

---

## 8. Screens

### ADATA (issuer)
1. **Dashboard** — outstanding payables, total face value, next settlement date, financed vs unfinanced split.
2. **Create payable** — two entry paths: manual form, or **"Import from ERP"** which shows a fake SAP-style file picker, then a parsed list of invoices with tick boxes. Currency is **XUSD**, not editable. The import path answers Mark's Q2 and costs almost nothing to fake.
3. **Approval queue** — maker-checker. Preparer submits, approver signs off. Shows who did what and when.
4. **Settlement** — payables coming due, one-click "Fund settlement". Payer picks a **funding source** (USDC / USDT / XSGD / XUSD). Shows the XUSD face being funded, any 1:1 or FX conversion, and payment going to the current holder's wallet in XUSD — not back to the original supplier.

### Supplier
5. **Onboarding** — three steps: company details, upload docs, connect wallet (auto-generated custodial 0x address). Auto-approves in a few seconds with a Verified badge.
6. **Payables inbox** — incoming TPs with **Accept** and **Reject**. Accepting is the opt-in moment. Together with screen 5 this answers Mark's Q1.
7. **My payables** — TPs held, each showing XUSD face value, days to maturity, and a live "sell now for X XUSD" figure.
8. **Request financing** — pick a payable, set a minimum acceptable **XUSD** price or accept the indicative rate, publish to the marketplace. Listing currency is XUSD; there is no currency picker. Show the comparison plainly: *financing cost 8.9% p.a. vs your current bank rate 18%*. That contrast is the entire supplier pitch.
9. **Offers received** — bids from lenders in XUSD, with each bidder's chosen funding source shown; accept one.

### Lender
10. **Marketplace** — filterable list. Filters: maturity, tenor, credit grade, size, yield. All listings are XUSD, so no listing-currency filter. Sort by yield. Header carries the "Institutional lenders only" label (§9).
11. **Payable detail** — the money screen for banks. Anchor obligor and its credit standing, grade and what the grade means, supplier, invoice reference, face (XUSD), price (XUSD), implied yield, days to maturity, allowed funding sources, the assignment artefacts (§6), and a full event log of every state change with its mock tx hash. This is Mark's Q3.
12. **Place bid / buy now** — prices entered in XUSD. Before confirm, pick **funding source**: USDC / USDT / XSGD / XUSD. Confirmation shows XUSD amount due, source asset, conversion (1:1 or mocked XSGD FX), and the Contract of Assignment to review.
13. **Portfolio** — holdings, weighted average yield, maturity ladder, realised returns, plus the one overdue position.
14. **Transfer** — send a held TP to another wallet address. Confirmation screen, then an event in the log.

### StraitsX admin
15. **Issuer certification** — onboard ADATA, set programme limits.
16. **Grading** — assign AAA / AA / A to each payable, with the LTV mapping shown (AAA ≈ 97%). Only graded payables reach the marketplace.
17. **Programme oversight** — total issued, financed, settled, overdue.

---

## 9. Marketplace mechanics

**Recommendation for v1: bid-and-accept, plus optional buy-now.** Not a full order book with depth.

- A supplier lists a payable **in XUSD** with an optional buy-now price (XUSD). There is no other listing currency.
- Lenders place bids as a price (% of XUSD face). The UI shows implied yield next to each.
- On bid or buy-now, the lender picks a **funding source**: USDC / USDT / XSGD / XUSD. The bid itself is still an XUSD price.
- Supplier accepts a bid, or a lender hits buy-now. Settlement of the trade converts the chosen funding asset into XUSD for the seller.
- Secondary works identically: any holder can relist, still in XUSD.

An order book with live depth and a price chart looks better on a screen but is roughly a week of extra work for something nobody at a booth will read. If we want visual richness cheaply, add a **historical yield chart per grade** using seeded data instead.

**One thing to flag.** The 12 Aug discussion proposed avoiding securities classification by having investors lend into a pool rather than buy the instrument directly, with licensed intermediaries in between. An open marketplace where anyone bids shows the opposite of that structure. Suggested compromise for the demo: gate the marketplace to **whitelisted institutional lenders**, show an "Institutional lenders only" label on the marketplace header, and keep retail out of the story entirely. Costs nothing, and stops the demo contradicting our own legal position in front of a bank. Restricted transferability and holder whitelisting were already on the mitigating-controls list from the Feb 2025 review, so this is consistent with prior work, not a new position.

---

## 10. Wallets and money

- Every account gets a custodial wallet with a displayed `0x` address on signup. Platform holds the keys. No seed phrases, no signing.
- Each wallet holds four balances: **USDC, USDT, XSGD, XUSD**. The **tokenised payable is always XUSD**. The other three are **funding sources** only — they pay for a purchase or a maturity settlement; they are not listing currencies.
- Conversion: **USDC / USDT / XUSD → XUSD at 1:1**. **XSGD → XUSD at a mocked FX rate** shown on the confirm screen. Semiconductor trade is USD-denominated; XSGD is on the MOU as a funding option, not as a listing currency.
- **"Simulate top-up"** adds a chosen asset (USDC / USDT / XSGD / XUSD) to the balance. Visible only in demo mode, styled as a demo control so nobody mistakes it for a product feature.
- Every state change writes an event with a **plausible-looking tx hash** and a fake block number, and a mock explorer drawer shows the event.

**Building for the testnet swap.** Keep every chain artefact behind a single `chain_ref` field and one `ChainAdapter` interface with two implementations: `MockChain` now, `TestnetChain` later. Nothing else in the app should know whether the hash is real. That way phase 2 is swapping one module, not rewriting the app. State it explicitly in the build so it doesn't get shortcut under deadline.

---

## 11. Demo controls

A persistent bar, clearly marked as demo-only:

- **Persona switcher** — jump between the four roles instantly
- **Fast-forward** — +1 day / +30 days / jump to next maturity. Nobody waits ninety days at a booth. This is the single most important control in the build.
- **Reset world** — back to seed state between pitches
- **Simulate top-up** — pick USDC / USDT / XSGD / XUSD
- **Trigger overdue** — for when a banker asks about default

Plus a permanent **"Demo environment — no real funds"** ribbon. The ADATA announcement is still pending MAS and ADATA sign-off, so nothing on screen should imply this is live.

---

## 12. Seed data

Everything is fictional. No real ADATA supplier names, no real invoice numbers. Dates are relative to demo T0 so it never goes stale.

| Ref | Supplier | Face (XUSD) | Tenor | Grade | Ask | Implied yield | State |
|---|---|---|---|---|---|---|---|
| TP-2026-0143 | Ming Kuo Components | 1,200,000 | 30d | AAA | 99.42 | 7.1% | Listed |
| TP-2026-0141 | Chien Yu Precision | 250,000 | 90d | AA | 97.85 | 8.9% | Listed |
| TP-2026-0142 | Hsin Ta Electronics | 48,000 | 60d | A | 98.40 | 9.9% | Listed |
| SERIES-2026-Q4-30D | 12 suppliers bundled | 180,000 | 30d | A | 99.20 | 9.8% | Listed |
| TP-2026-0128 | Yung Sheng Metals | 320,000 | 60d | AA | — | 9.2% realised | Settled |
| TP-2026-0119 | Fu Hsing Plastics | 75,000 | 90d | A | — | — | Overdue, recovery |

**Yield convention, so the numbers survive a banker checking them.** Implied yield = (face − price) / price × 365 / days. TP-2026-0141: price 244,625, discount 5,375, 5,375 / 244,625 × 365 / 90 = 8.9%. Every row in the table follows that formula. Use the same formula in the app so a hand-calculation matches the screen. If anyone prefers discount-on-face instead, change it once, here, and regenerate the table.

**Mocked FX:** XSGD/XUSD = 0.7800, fixed on the demo clock, shown on every XSGD confirm screen.

Seeded accounts: one ADATA finance user plus one approver, three suppliers, two lenders (one bank, one fund) with pre-funded **USDC / USDT / XSGD / XUSD** balances and existing portfolio history, one StraitsX admin. Seed at least one lender heavy in USDC and one heavy in XUSD so the funding-source picker is not a no-op during the pitch.

All seed payables are **XUSD-listed**. Ask and implied yield are against XUSD face.

The supplier comparison numbers to keep visible throughout: **supplier's current cost of borrowing ~18%, ADATA's cost of funds ~5%.** The spread is the product.

---

## 13. Data model

```
User          id, name, entity_type, role, kyc_status, wallet_address
Wallet        address, user_id, usdc_balance, usdt_balance, xsgd_balance, xusd_balance
Payable       ref, anchor_id, supplier_id, face, currency (= XUSD), issue_date,
              maturity_date, grade, invoice_ref, status, holder_wallet,
              series_id (nullable), mint_tx
Series        id, ref, maturity_date, grade, member_payable_ids
Listing       id, payable_id, seller_wallet, buy_now_price (XUSD), min_price (XUSD), status
Bid           id, listing_id, bidder_wallet, price_pct, implied_yield,
              funding_source (USDC|USDT|XSGD|XUSD), status
Assignment    id, payable_id, from_wallet, to_wallet, coa_ref, notice_sent_at, chain_ref
Settlement    id, payable_id, xusd_amount, funding_source, fx_rate (nullable), status
Event         id, payable_id, type, actor, timestamp, chain_ref, payload
DemoClock     current_date, offset_days, xsgd_xusd_rate
```

`Payable.currency` is constrained to `XUSD`. `funding_source` lives only on the payment (bid / buy-now / maturity settlement), never on the instrument.

`Assignment` is written on every sale and every transfer. It's what screen 11 renders and what answers the recourse question.

`Event` is the audit trail and drives both the mock explorer and the lender's event log. Every meaningful action writes one. Funding conversions write an event with source asset, XUSD amount, and rate.

---

## 14. Non-functional

| | Default |
|---|---|
| Devices | Desktop first, responsive down to iPad. Booth pitches run off a laptop. |
| Persistence | Shared demo world on a light backend, so a listing made on one device shows up on another. Needed if two people demo side by side. |
| Language | English. Mandarin toggle on the supplier and issuer screens is a nice-to-have — ADATA and BaaS are Taiwanese, and it lands well, but it's the first thing to cut. |
| Branding | Neutral platform name, "Powered by StraitsX" in the footer, logo swappable by config so BaaS can front it. Strategy is BaaS customer-facing, Fazz behind. |
| Performance | Any action under 500ms. A laggy demo reads as a broken product. |
| Accounts | No email verification. Signup is instant. |

---

## 15. Assumption register

These are the defaults taken. Override any and the doc gets redrafted.

| # | Question | Default taken |
|---|---|---|
| 1 | Coupons or bullet? | Bullet at maturity |
| 2 | Fractional? | No. Bundle into a Series instead. Legal reason in §6 |
| 3 | Bundling by maturity? | Yes, one Series in seed data |
| 4 | Currency? | **Listed in XUSD only.** Funding source: USDC / USDT / XSGD / XUSD |
| 5 | Supplier as third persona? | Yes |
| 6 | ADATA maker-checker? | Yes |
| 7 | StraitsX admin / grading? | Yes, visible |
| 8 | Mock KYC? | Yes, 3 steps, auto-approve |
| 9 | Supplier must accept? | Yes. It's the opt-in and consent moment |
| 10 | Whitelisted lenders? | Yes, institutional only |
| 11 | Order book? | No. Bid-and-accept plus buy-now |
| 12 | Primary and secondary? | Both |
| 13 | Assignment artefacts shown? | Yes, COA plus notice to ADATA, both mocked |
| 14 | Price chart? | Yield-by-grade chart, seeded. Cut if tight |
| 15 | Fast-forward? | Yes, essential |
| 16 | Settlement funding? | ADATA clicks "Fund settlement", picks USDC / USDT / XSGD / XUSD, no escrow |
| 17 | Default / liquidation? | One seeded overdue example, one screen |
| 18 | Early buyback? | No |
| 19 | Chain? | Mocked, behind a swappable adapter |
| 20 | Which chain named? | None named on screen. Avoids a Monad vs XLayer argument we don't need this month |
| 21 | Shared state? | Yes, light backend |
| 22 | Reset and seed? | Yes |
| 23 | Branding? | Neutral plus swappable logo |
| 24 | Mandarin? | Nice-to-have, first to cut |
| 25 | Device? | Desktop first |
| 26 | Claims? | Demo ribbon everywhere, nothing implying live, MAS-approved, or part of BLOOM |

---

## 16. Open questions for legal and commercial

Not blockers for the build, but they'll come up at the booth and someone should have an answer.

1. **Does the demo need to match the pool structure?** The 12 Aug discussion proposed investors lending to a pool rather than buying the instrument, with licensed intermediaries in between. This demo shows direct purchase. Which one are we actually pitching at Token2049? Institutional-only gating (§9) narrows the gap but doesn't close it.
2. **What must live inside the smart contract** so it maps to ADATA's legal invoice? Open since the 3 Sep thread. Doesn't block a mock, blocks the real thing.
3. **Enforceability in Taiwan.** The Feb 2025 analysis was built Singapore-first, for a Singapore issuer under MAS. ADATA is Taiwan-domiciled, so the characterisation needs redoing for Taiwan and for wherever the lenders sit. If a banker asks "what's my recourse", what's the line?
4. **Who is the named lender in the pilot?** DBS, UOB, OCBC — none of them appear to have a banking relationship with ADATA. Still the hard part.
5. **Has ADATA committed a number?** As of 4 Sep, no. Still the hard part.
6. **Grading authority.** We say StraitsX sets the standard. On what basis, and does anyone external validate it? Daniel is separately settling a credit standard with Aave; if those two definitions of AAA diverge we'll get caught.
7. **Does the deck get fixed?** The "principal + interest" wording in §6 contradicts the instrument and the MAS reading. Needs an owner and a date.

---

## 17. Risks

| Risk | Handling |
|---|---|
| Demo mistaken for a live product | Permanent demo ribbon, no MAS or bank logos, no claims of approval |
| Demo read as MAS-endorsed via BLOOM | BLOOM is MAS's initiative, not ours (§0). Not named anywhere on screen |
| Marketplace contradicts our legal structure | Institutional-only gating and label (§9) |
| Deck and demo disagree on interest vs discount | Flagged in §6 and §16.7, needs a deck edit before 7 Oct |
| "Tokenised deposit" naming collision internally | Use TP consistently, correct it in channels |
| Real ADATA or supplier data leaking into seed | All names fictional, flagged in §12 |
| Unverified claims about ADATA on screen | Real company profile in §5, the "largest distributor" phrasing dropped |
| Three weeks is short | Phase the build (§18), cut list already identified |
| Someone asks about default and we have nothing | Seeded overdue example |
| Someone asks about recourse and we have nothing | COA and notice of assignment on screen (§6) |
| Booth confuses listing currency with funding asset | Lock listing to XUSD on every screen; funding source only appears on confirm |

---

## 18. Build plan

**The calendar, precisely.** Today is 14 Sep. Token2049 is 7 Oct. That is 23 days.

The 24 Sep requirements lock in circulation came from the 3 Sep thread and was set against **SFF in November**, not Token2049. Reusing it here doesn't work: locking on 24 Sep leaves 13 days to build, and the plan below needs three weeks. So either requirements lock by **19 Sep** and the build starts immediately, or Token2049 gets a thinner demo than this document describes. That decision is the real deadline, and it's a decision for this week.

**Week 1 (to 26 Sep) — spine.** Data model, four personas, auth, four-asset wallets, ERP-import mock, payable creation (XUSD locked), maker-checker, supplier accept/reject, grading, mint. Chain adapter interface in from day one.

**Week 2 (to 3 Oct) — the story.** Marketplace, bids, accept, buy-now, funding-source picker and conversion, assignment artefacts, transfers, settlement, demo clock, top-up.

**Week 3 (to 6 Oct) — make it presentable.** Seed data and history, overdue example, yield chart if time, polish, write the runbook, two dry runs with James. Ship-ready the evening of 6 Oct, not the morning of 7 Oct.

**Resourcing.** The blockchain roadmap is full, so this needs an external builder or the NUS students route rather than the squad. That was already the conclusion on 3 Sep for the SFF booth build. Whoever it is needs to be booked this week, not after the requirements lock.

---

## 19. Demo runbook (5 minutes)

OCBC asked for a runbook on their SFF demo and they were right to. Same discipline here. James should be able to run this cold.

| # | Beat | Time | What to do and say |
|---|---|---|---|
| 1 | Set up | 20s | "ADATA buys components from hundreds of Taiwanese suppliers and pays in 90 days. Those suppliers borrow at 18% to bridge the gap. ADATA borrows at 5%. That gap is the product." |
| 2 | ADATA issues | 55s | Import invoices from ERP, tick three, submit, approve as checker. Payables mint to supplier wallets. "ADATA didn't receive any cash. It issued a promise." |
| 3 | Supplier accepts and finances | 60s | Switch persona. Accept the payable in the inbox — that's the opt-in. Show the 250k XUSD, 90-day payable: "sell today for 244,625 XUSD, cost 8.9%, versus your bank at 18%." List it — listing currency is XUSD, no other option. |
| 4 | Lender buys | 85s | Switch persona. Marketplace, filter by grade, open the detail. Walk the credit view: obligor is ADATA, not the small supplier. Show the assignment contract. Place a bid in XUSD, pay from **USDC**. Switch back, accept. Supplier is credited in XUSD. |
| 5 | Fast-forward | 45s | Jump 90 days. ADATA funds settlement, picking a funding source again. XUSD face value pays to the lender, not the supplier. "The obligation followed the token. The listing was XUSD; they funded it in USDC." |
| 6 | The awkward question | 20s | Open the overdue example. Grace period, recovery, liquidator. |
| 7 | Ask | 15s | Bank: would you look at a pilot tranche. Corporate: how much do you pay out on terms each month. |

Total 5:00. Rehearse to that, because the beat that always overruns is 4 and it's also the one that matters most.

---

## Appendix — where this came from

- `#tf-taiwan-adata-tokenised-payables`, Mark Hew 11–12 Sep 2026 — Token2049 ask, the three questions (supplier opt-in, ERP approval, what the FI sees), pitch deck
- `#tf-adata-baas-partnership`, ADATA Tokenized Deposit discussion, 12 Aug 2026 — model, ~5% vs ~18% spread, pool structure, AAA ≈ 97% LTV, StraitsX as standard-setter, MVP vs Aave phasing
- `#tf-taiwan-adata-tokenised-payables`, Samson Leo 27 Jul 2026 — Feb 2025 legal framework: assignment conditions, securities characterisation, AML perimeter, whitelisting, Singapore-first caveat for Taiwan
- `#tf-taiwan-adata-tokenised-payables`, Daniel Oon 6–7 Aug 2026 — XTP rolling-token counterproposal to Aave, receivables vs payables naming
- `#tf-amazon-2025-partnership-tokenised-payables`, Gloria 20 Dec 2024 — MUFG feedback on bundling by maturity and on custody
- Notion: *Amazon tokenized payable* RFC — TP definition, exchange components, EIP-1155 options
- Notion: *KR3.4 tokenised payables design for ADATA* — NFT standard, lifecycle, settlement flow, testnet prototype by Q4
- Notion: *StraitsX x ADATA x BaaS MOU*, *ADATA MOU Signing*
- Daily Work Log 3 Sep 2026 — MAS interest restriction for e-money licensees, 3-week requirements lock, smart-contract-to-legal-invoice mapping, blockchain roadmap full
- TP Whiteboarding Session deck, Feb 2025 — roles, MVP flow, legal requirements to embed in the smart contract
- ADATA Tokenized Payables pitch deck, Sep 2026 — the deck James is presenting
- Token2049 Singapore: 7–8 Oct 2026, Marina Bay Sands (token2049.com)
- MAS BLOOM initiative, announced 16 Oct 2025 (mas.gov.sg media release)
