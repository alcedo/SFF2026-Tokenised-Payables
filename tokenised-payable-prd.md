# PRD — ADATA Tokenised Payables Demo

**Product:** Clickable web demo of the ADATA tokenised payables programme
**Programme:** Project BLOOM · StraitsX × ADATA × BaaS Innovations
**Target:** Token2049, early Oct 2026
**Chain:** Mocked now, testnet later


---

## 0. Read this first

This is a **mock**. No chain, no money, no real ADATA data. It exists so a BaaS or bank person can click through the whole flow and understand the product in five minutes.
---

## 2. Audience and success


**Success looks like:**

A BaaS or bank person clicks through it alone, without James narrating, and comes away able to explain the product to their own credit team. If they need us standing next to them, the demo failed.

Concretely, on screen:

- **It looks like a working product, not a prototype.** Real-looking data everywhere, no lorem ipsum, no empty states, no "coming soon" buttons. Every screen has seeded history behind it so nothing looks like it was born five seconds ago.
- **Banker-grade, not crypto-grade.** Reads like a treasury or trade-finance portal. Muted, dense, tabular. No gradients, no glow, no wallet-connect aesthetic, no token tickers scrolling. A credit officer should recognise the furniture.
- **The credit story is the loudest thing on the lender screens.** Payable detail leads with the anchor obligor and grade, not the supplier. If a banker looks at that screen for ten seconds and thinks they're underwriting a small Taiwanese vendor, we've lost the pitch.
- **The supplier contrast is visible without clicking.** 9.1% vs 18% sits on the supplier dashboard, not buried in a flow.
- **Five minutes, end to end**, issue → list → bid → accept → fast-forward → settle, with no dead ends, no errors, no page a persona can reach that isn't built.
- **Obviously a demo, never mistakable for live.** Permanent "Demo environment — no real funds" ribbon, demo controls visually separated from product UI. Nobody should walk away thinking this is in production or MAS-approved.
- **Recoverable in one click.** Reset world puts it back to seed between pitches, so a botched run costs nothing.
- **Fast.** Under 500ms per action. Lag reads as a broken product, not a mock.

Failure looks like: a pretty landing page with a "Launch app" button and three screens behind it.

---
## 3. The questions the demo must answer / demonstrate

| # | Key Question | Screen/Flow That Answers It | Description |
|---|---|---|---|
| 1 | How does a supplier receive a tokenised payable? | Payables inbox / Supplier dashboard | The issuer (e.g. ADATA) issues the tokenised payable on the platform. The supplier receives and views it on their dashboard. |
| 2 | How does a supplier sell a tokenised payable for financing? | Marketplace listing flow / Supplier action | After receiving it, the supplier lists it **in XUSD** on the central marketplace so banks and FIs can bid to finance it. Listing currency is XUSD only. |
| 3 | How do banks/FIs select payables to finance, and what do they see? | Lender marketplace / Payable & credit detail | Banks and FIs browse the marketplace, review the payable and credit details, and bid or offer directly on it. |
| 4 | How does a supplier transfer a payable without listing it? | Transfer / wallet assignment | The supplier can send the token to another wallet on the platform (e.g. group treasury or another party) instead of listing it. |
| 5 | What if the supplier does not sell? | Hold-to-maturity / Payable detail | The supplier keeps the token until maturity. The issuer must then repurchase it at full face value. |
| 6 | How is a tokenised payable created and issued? | Buyer issue / Approval flow | The issuer creates the payable from an approved invoice and sets terms (amount, due date). **Currency is always XUSD** — the payable cannot be issued or listed in another asset. |
| 7 | Does the supplier have to accept it? | Accept / reject inbox action | If required: the supplier confirms the payable is correct before it can be listed, transferred, or held. Rejection returns it to the issuer. |
| 8 | How does bidding close and who wins? | Bid book / Accept offer | The supplier (or the platform, if it is an auction) accepts a bid; other bids expire. Show rate, amount, tenor, and bidder. |
| 9 | How does the supplier get paid after a sale? | Settlement / Funding confirmation | The winning FI pays the discounted **XUSD** price from an allowed funding source (**USDC / USDT / XSGD / XUSD**); the token moves to the FI; the supplier is credited in XUSD. |
| 10 | What happens at maturity? | Maturity / Issuer redemption | The issuer **must repurchase the entire token at face value** from the current holder. If an FI bought it at a discount, profit = face value − purchase price. If the supplier held it, they receive full face value. |
| 11 | What can an FI do after they buy? | Lender portfolio / Position detail | Hold to maturity for the issuer buyback (and the discount profit), or — if allowed — re-list or transfer the token. Show purchase price, face value, implied yield, and days to redemption. |
| 12 | How is the tokenised payable represented on-chain? | Token standard / Token detail | Each tokenised payable is an **ERC-1155** token. For this demo, **decimals = 4**: $1.0000 face value = **10,000 base units**. UI amounts are human-readable XUSD; on-chain balances are in base units (`amount × 10⁴`). |
| 13 | What is the payable listed in, and how is it funded? | Listing / Bid / Fund settlement | The TP is **always listed, priced, bid, and redeemed in XUSD**. The payer (lender on purchase, ADATA at maturity) chooses a **funding source**: **USDC, USDT, XSGD, or XUSD**. Funding is a payment rail, not a second listing currency. |

Out of demo scope: wrong payable, cancellation, and issuer non-payment.

---

## 4. Scope

### In
- Four personas, switchable (§5)
- Signup, mock KYC, custodial wallet with a displayed 0x address
- Mock ERP invoice import → payable creation → maker-checker approval → mint
- StraitsX certification and credit grading
- Supplier: hold to maturity, or list for financing
- Marketplace: listings, bids, accept-bid, buy-now — **listings locked to XUSD**
- Funding source picker on buy and on maturity settlement: **USDC / USDT / XSGD / XUSD**
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
- Aave vault / DeFi phase 2
- Fractional ownership of a single invoice (see §6, we bundle instead)
- Multi-tenancy, multiple anchor buyers beyond ADATA
- Legal docs, e-signature, invoice verification
- Listing or issuing a payable in USDC, USDT, or XSGD (funding only)

---

## 5. Personas


**1. ADATA finance (anchor buyer / issuer)**
Owes money to suppliers on 30–180 day terms. Issues the payable **in XUSD**. Pays XUSD face value at maturity to whoever holds it, funded from USDC / USDT / XSGD / XUSD. Never receives cash from this product. They will be the one redeeming the tokenised payables.

**2. Supplier (first holder)**
Small vendors globally for example. Has the cash-flow problem. Currently borrows at roughly 18% from banks. Receives the TP, then chooses: hold to maturity for full XUSD face value, or sell now at a discount for XUSD today (buyer may fund that purchase in USDC / USDT / XSGD / XUSD). A large company like ADATA will make an order from small supplier, and small supplier will have to figure out their own financing in order to fulfill the order from a large company like ADATA.

**3. Lender / investor (bank, fund, corporate treasury)**
Buys the TP at a discount, priced in XUSD. Pays with USDC / USDT / XSGD / XUSD. Gets XUSD face value at maturity. Underwriting the anchor's credit, not the supplier's — that's the pitch.

**4. StraitsX admin (platform)**
Onboards and certifies issuers, assigns credit grade, admits payables to the marketplace, oversees settlement. This is the standard-setter role that the Aug 12 strategy calls the durable moat, so it should be visible, not hidden.

Persona switching is one dropdown in the demo control bar. No logging in and out during a pitch.

---

## 6. The instrument

**One invoice = one token.** Non-fungible by design, using ERC1155 standard.

**Priced as a discount to face, not principal plus interest.** Buy at 97.85, receive 100 at maturity. Two reasons: it's the market convention for receivables, and it keeps us away from the "interest" language that legal team flagged as a problem for licensed e-money players. The UI shows implied annualised yield alongside the price so lenders can compare, but the instrument itself pays no coupon.

**Bullet only.** Single payment at maturity. No coupon schedule. Invoices don't work that way and it doubles the state machine.

**Listed in XUSD only.** Face value, ask, bid, buy-now, and the maturity repurchase are all XUSD. The supplier cannot list in USDC, USDT, or XSGD. A Series is the same: one XUSD face for the bundle.

**Funding source is a payment rail, not the instrument.** When a lender buys, and when ADATA funds maturity, the payer chooses one of: **USDC, USDT, XSGD, XUSD**. USD stables (USDC, USDT, XUSD) convert **1:1** into the XUSD obligation. XSGD converts at a **mocked FX rate** shown on the confirmation screen. The token and the books stay in XUSD; the supplier / current holder is credited in XUSD.

**Bundles.** Small invoices can be grouped into a Series by shared maturity date — for example `SERIES-2026-Q4-30D`, twelve invoices, XUSD 180k total. MUFG asked for exactly this on the Amazon deal, because sub-$10k tickets aren't worth a bank's time. A Series is bought and settled as one unit. This gets us the economics of fractionalisation without building a fractionalisation wrapper.

**Fields on every TP:**

Listing price, bid, and implied yield are marketplace fields, not instrument fields.

| Field | Example | Notes |
|---|---|---|
| Reference | `TP-2026-0141` | Human-readable id. Series use `SERIES-…` |
| Anchor obligor | ADATA Technology Co., Ltd. | must buy the tokenised payable |
| Supplier | Chien Yu Precision | Made up name for this demo |
| Currency | XUSD | Locked. Always XUSD. Funding source is separate (USDC / USDT / XSGD / XUSD), §6 / §10 |
| Face value | 250,000.0000 | UI XUSD; on-chain = `× 10⁴`, Q12 |
| Issue date | T+0 | Relative to demo clock |
| Maturity date | T+90 | |
| Tenor | 90 days | Derived, not stored |
| Credit grade | AA | Assigned by StraitsX admin, §8.15 |
| Invoice ref | INV-TW-88213 | Fictional |
| Series | — | Nullable. Set when bundled |
| Status | Listed | Lifecycle in §7 |
| Holder wallet | `0x7a3f…c21d` | Current holder, not original supplier |
| Mint tx | mock hash | Payable-level. Later events live on `Event.chain_ref`, §10 / §13 |

---

## 7. Lifecycle

```
Draft ──▶ Pending approval ──▶ Certified ──▶ Issued ──▶ Listed ──▶ Financed
  │            (ADATA            (StraitsX     (minted    (on          (sold to
  │             checker)          grades it)    to         market)      lender)
  │                                             supplier)                  │
  ▼                                                                        ▼
Cancelled                                              Transferred ◀──▶ Financed
                                                                           │
                                                                           ▼
                                                       Matured ──▶ Settled
                                                           │
                                                           ▼
                                                    Overdue ──▶ Recovery
```

- **Cancelled** only possible before mint.
- **Transferred** is a peer-to-peer move by wallet address, no money changing hands on-platform. Available to any holder.
- **Settled** pays XUSD face value to the current holder, whoever that is. ADATA funds that XUSD obligation from USDC / USDT / XSGD / XUSD. This is the moment worth pausing on during a pitch.
- **Overdue** and **Recovery** exist as one pre-seeded example, not a fully built workflow. Banks will ask what happens on default, and "we don't show that" is a bad answer. One screen showing grace period, recovery status, and appointed liquidator is enough.

---

## 8. Screens

### ADATA (issuer)
1. **Dashboard** — outstanding payables, total face value, next settlement date, financed vs unfinanced split.
2. **Create payable** — two entry paths: manual form, or **"Import from ERP"** which shows a fake SAP-style file picker, then a parsed list of invoices with tick boxes. Currency is **XUSD**, not editable. The import path is the answer to Mark's Q2 and costs almost nothing to fake.
3. **Approval queue** — maker-checker. Preparer submits, approver signs off. Shows who did what and when.
4. **Settlement** — payables coming due, one-click "Fund settlement". Payer picks a **funding source** (USDC / USDT / XSGD / XUSD). Shows the XUSD face being funded, any 1:1 or FX conversion, and payment going to the current holder's wallet in XUSD — not back to the original supplier.

### Supplier
5. **Onboarding** — three steps: company details, upload docs, connect wallet (auto-generated custodial 0x address). Auto-approves in a few seconds with a Verified badge. Answers Mark's Q1.
6. **My payables** — list of TPs held, each showing XUSD face value, days to maturity, and a live "sell now for X XUSD" figure.
7. **Request financing** — pick a payable, set a minimum acceptable **XUSD** price or accept the indicative rate, publish to the marketplace. Listing currency is XUSD; there is no currency picker. Show the comparison plainly: *financing cost 9.1% p.a. vs your current bank rate 18%*. That contrast is the entire supplier pitch.
8. **Offers received** — bids from lenders in XUSD, with the bidder's chosen funding source shown; accept one.

### Lender
9. **Marketplace** — filterable list. Filters: maturity, tenor, credit grade, size, yield. All listings are XUSD, so no listing-currency filter. Sort by yield.
10. **Payable detail** — the money screen for banks. Anchor obligor and its credit standing, grade and what the grade means, supplier, invoice reference, face (XUSD), price (XUSD), implied yield, days to maturity, allowed funding sources, and a full event log of every state change with its (mock) tx hash. This is Mark's Q3.
11. **Place bid / buy now** — prices entered in XUSD. Before confirm, pick **funding source**: USDC / USDT / XSGD / XUSD. Confirmation shows XUSD amount due, source asset, and conversion (1:1 or mocked XSGD FX).
12. **Portfolio** — holdings, weighted average yield, maturity ladder, realised returns, plus the one overdue position.
13. **Transfer** — send a held TP to another wallet address. Confirmation screen, then an event in the log.

### StraitsX admin
14. **Issuer certification** — onboard ADATA, set programme limits.
15. **Grading** — assign AAA / AA / A to each payable, with the LTV mapping shown (AAA ≈ 97%). Only graded payables reach the marketplace.
16. **Programme oversight** — total issued, financed, settled, overdue.

---

## 9. Marketplace mechanics

**Recommendation for v1: bid-and-accept, plus optional buy-now.** Not a full order book with depth.

- A supplier lists a payable **in XUSD** with an optional buy-now price (XUSD). There is no other listing currency.
- Lenders place bids as a price (% of XUSD face). The UI shows implied yield next to each.
- On bid or buy-now, the lender selects a **funding source**: USDC / USDT / XSGD / XUSD. The bid itself is still an XUSD price.
- Supplier accepts a bid, or a lender hits buy-now. Settlement of the trade converts the chosen funding asset into XUSD for the seller.
- Secondary works identically: any holder can relist, still in XUSD.

An order book with live depth and a price chart looks better on a screen but is roughly a week of extra work for something nobody at a booth will read. If we want visual richness cheaply, add a **historical yield chart per grade** using seeded data instead.

**One thing to flag.** Rajiv's guidance was to avoid securities classification by having investors lend into a pool rather than buy the instrument directly, with licensed intermediaries in between. An open marketplace where anyone bids shows the opposite of that structure. Suggested compromise for the demo: gate the marketplace to **whitelisted institutional lenders**, show an "Institutional lenders only" label on the marketplace header, and keep retail out of the story entirely. Costs nothing, and stops the demo contradicting our own legal position in front of a bank.

---

## 10. Wallets and money

- Every account gets a custodial wallet with a displayed `0x` address on signup. Platform holds the keys. No seed phrases, no signing.
- Each wallet holds four balances: **USDC, USDT, XSGD, XUSD**. The **tokenised payable is always XUSD**. The other three are **funding sources** only — they pay for a purchase or a maturity settlement; they are not listing currencies.
- Conversion: **USDC / USDT / XUSD → XUSD at 1:1**. **XSGD → XUSD at a mocked FX rate** shown on the confirm screen. Semiconductor trade is USD-denominated; XSGD is on the MOU as a funding option, not as a listing currency.
- **"Simulate top-up"** button adds a chosen asset (USDC / USDT / XSGD / XUSD) to the balance. Visible only in demo mode, styled as a demo control so nobody mistakes it for a product feature.
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

Seeded accounts: one ADATA finance user plus one approver, three suppliers, two lenders (one bank, one fund) with pre-funded **USDC / USDT / XSGD / XUSD** balances and existing portfolio history, one StraitsX admin. Seed at least one lender heavy in USDC and one in XUSD so the funding-source picker is not a no-op during the pitch.

All seed payables are **XUSD-listed**. Ask and implied yield are against XUSD face. XSGD FX is a single mocked rate on the demo clock (shown on any XSGD confirm screen).

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
Settlement    id, payable_id, xusd_amount, funding_source, fx_rate (nullable), status
Event         id, payable_id, type, actor, timestamp, chain_ref, payload
DemoClock     current_date, offset_days, xsgd_xusd_rate
```

`Payable.currency` is constrained to `XUSD`. `funding_source` is only on the payment (bid / buy-now / maturity settlement), never on the instrument.

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

These are my defaults, numbered to match the questions from the earlier thread. Override any and I'll redraft.

| # | Question | Default taken |
|---|---|---|
| 1 | Coupons or bullet? | Bullet at maturity |
| 2 | Fractional? | No. Bundle into Series instead |
| 3 | Bundling by maturity? | Yes, one Series in seed data |
| 4 | Currency | **Listed in XUSD only.** Funding source: USDC / USDT / XSGD / XUSD |
| 5 | Supplier as third persona? | Yes |
| 6 | ADATA maker-checker? | Yes |
| 7 | StraitsX admin / grading? | Yes, visible |
| 8 | Mock KYC? | Yes, 3 steps, auto-approve |
| 9 | Whitelisted lenders? | Yes, institutional only |
| 10 | Order book? | No. Bid-and-accept plus buy-now |
| 11 | Primary and secondary? | Both |
| 12 | Price chart? | Yield-by-grade chart, seeded. Cut if tight |
| 13 | Fast-forward? | Yes, essential |
| 14 | Settlement funding | ADATA clicks "Fund settlement", picks USDC / USDT / XSGD / XUSD, no escrow |
| 15 | Default / liquidation? | One seeded overdue example, one screen |
| 16 | Early buyback? | No |
| 17 | Chain | Mocked, behind a swappable adapter |
| 18 | Which chain named? | None named on screen. Avoids a Monad vs XLayer argument we don't need this month |
| 19 | Shared state? | Yes, light backend |
| 20 | Reset + seed? | Yes |
| 21 | Branding | Neutral + swappable logo |
| 22 | Mandarin? | Nice-to-have, first to cut |
| 23 | Device | Desktop first |
| 24 | Claims | Demo ribbon everywhere, nothing implying live or MAS-approved |

---

## 16. Open questions for legal and commercial

Not blockers for the build, but they'll come up at the booth and someone should have an answer.

1. **Does the demo need to match the pool structure?** Rajiv's slides 20–29 propose investors lending to a pool rather than buying the instrument. This demo shows direct purchase. Which one are we actually pitching at Token2049?
2. **What must live inside the smart contract** so it maps to ADATA's legal invoice? Still open from the 3 Sep thread. Doesn't block a mock, blocks the real thing.
3. **Enforceability.** Taiwan-domiciled issuer, Taiwan courts. If a banker asks "what's my recourse," what's the line?
4. **Who is the named lender in the pilot?** DBS, UOB, OCBC — none of them appear to have a banking relationship with ADATA. Still the hard part.
5. **Has ADATA committed a number?** As of 4 Sep, no. Still the hard part.
6. **Grading authority.** We say StraitsX sets the standard. On what basis, and does anyone external validate it?

---

## 17. Risks

| Risk | Handling |
|---|---|
| Demo mistaken for a live product | Permanent demo ribbon, no MAS or bank logos, no claims of approval |
| Marketplace contradicts our legal structure | Institutional-only gating and label (§9) |
| "Tokenised deposit" naming collision internally | Use TP consistently, correct it in channels |
| Real ADATA or supplier data leaking into seed | All names fictional, flagged in §12 |
| Three weeks is short | Phase the build (§18), cut list already identified |
| Someone asks about default and we have nothing | Seeded overdue example |
| Booth confuses listing currency with funding asset | Lock listing to XUSD on every screen; funding source only appears on confirm |

---

## 18. Build plan

Roughly three weeks to Token2049. Product requirements were meant to be locked by around 24 Sep for the SFF track, so the same lock date works here.

**Week 1 — spine.** Data model, four personas, auth, four-asset wallets, ERP-import mock, payable creation (XUSD locked), maker-checker, grading, mint. Chain adapter interface in from day one.

**Week 2 — the story.** Marketplace, bids, accept, buy-now, funding-source picker + conversion, transfers, settlement, demo clock, top-up.

**Week 3 — make it presentable.** Seed data and history, overdue example, yield chart if time, polish, write the runbook, two dry runs with James.

Blockchain roadmap is full, so this likely needs an external builder or the NUS students route rather than the squad.

---

## 19. Demo runbook (5 minutes)

OCBC asked for a runbook on the SFF demo and they were right to. James should be able to run this cold.

1. **Set up (20s).** "ADATA buys components from hundreds of Taiwanese suppliers and pays in 90 days. Those suppliers borrow at 18% to bridge the gap. ADATA borrows at 5%. That gap is the product."
2. **ADATA issues (60s).** Import invoices from ERP, tick three, submit, approve as checker. Payables mint to supplier wallets. "ADATA didn't receive any cash. It issued a promise."
3. **Supplier finances (60s).** Switch persona. Show the 250k XUSD, 90-day payable. Show "sell today for 244,625 XUSD, cost 8.9%, versus your bank at 18%." List it — listing currency is XUSD, no other option.
4. **Lender buys (90s).** Switch persona. Marketplace, filter by grade, open the detail. Walk the credit view: obligor is ADATA, not the small supplier. Place a bid in XUSD, pay from **USDC** (or USDT / XSGD / XUSD). Switch back, accept. Supplier is credited in XUSD.
5. **Fast-forward (45s).** Jump 90 days. ADATA funds settlement, again picking a funding source. XUSD face value pays to the lender, not the supplier. "The obligation followed the token. The listing was XUSD; they funded it in USDC."
6. **The awkward question (30s).** Open the overdue example. Grace period, recovery, liquidator.
7. **Ask (15s).** Bank: would you look at a pilot tranche. Corporate: how much do you pay out on terms each month.

---

## Appendix — where this came from

- #tf-taiwan-adata-tokenised-payables, Mark Hew 11–12 Sep 2026 (Token2049 ask, the three questions, pitch deck)
- #tf-adata-baas-partnership, 14 Aug 2026 (ADATA Tokenized Deposit discussion notes — model, legal structure, spread economics, MVP vs Aave phasing)
- #tf-amazon-2025-partnership-tokenised-payables, Dec 2024 (MUFG feedback on bundling and custody)
- Notion: *Amazon tokenized payable* RFC (TP definition, exchange components, EIP-1155 vs NFT options)
- Notion: *KR3.4 tokenised payables design for ADATA* (NFT standard, lifecycle, settlement flow, testnet prototype by Q4)
- Notion: *StraitsX x ADATA x BaaS MOU*, *ADATA MOU Signing*
- Daily Work Log 3 Sep 2026 (MAS interest restriction for e-money licensees, 3-week requirements lock, smart contract to legal invoice mapping)