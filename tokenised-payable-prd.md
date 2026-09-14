# PRD — ADATA Tokenised Payables Demo

**Product:** Clickable web demo of the ADATA tokenised payables programme

**Programme context:** Project BLOOM · StraitsX × ADATA × BaaS Innovations

**Target:** Token2049, early October 2026 — planning assumption; confirm event and delivery dates

**Delivery:** Mock application now; testnet integration in a later phase

**Status:** Working draft; demo defaults and outstanding decisions are recorded in §§15–16

---

## 1. Purpose

Build a self-guided demo that shows how an ADATA supplier can receive an approved tokenised payable, sell all or part of it for early payment, and have ADATA settle the obligation with each current holder at maturity.

The suppliers need working capital, while lenders assess the anchor buyer's obligation. The demo should make that relationship clear through the transaction flow and credit information.

It uses fictional invoices that mirrors real world requirements, suppliers, balances, grades, and transactions. It moves no real funds and makes no blockchain transactions. ADATA is the named anchor buyer in the scenario, although this can be expanded to other anchor buyers in the future.

IMPORTANT: We will later port this platform over to be used on sepolia testnet for real testnet transactions to be defined in another PRD.

## 2. Audience and success criteria

The primary audience is bank, financial institution, suppliers and anchor buyer as issuer.

A viewer should be able to complete the core flow without narration and explain it to audience.

Audiences can also try it out themselves.

| Criterion | Acceptance condition |
|---|---|
| Complete story | A viewer can issue → list → bid → accept → advance time → settle within five minutes, following §19. |
| Product credibility | All reachable screens work and contain realistic seeded data or useful guidance. No placeholder copy, dead controls, or unfinished routes. |
| Clear credit narrative | Lender detail leads with ADATA as anchor obligor, its sample/demo credit grade, and the repayment obligation. Supplier information is secondary. |
| Visible supplier benefit | The supplier dashboard shows sale proceeds, annualised financing cost, and the indicative 18% bank benchmark without opening another screen. |
| Appropriate design | Use the visual language of treasury and trade-finance portals: restrained colours, clear tables, compact layouts, and readable numbers. |
| Repeatability | Each tokenised payable can be fast forwarded on the demo clock per tokenised payable to showcase maturity of the tokenised payables |

## 3. Questions the demo must answer

| # | Question | Screen or flow | Required answer |
|---|---|---|---|
| 1 | How does a supplier receive a payable? | Issuer creation → supplier inbox | ADATA creates a payable from an approved invoice; approval and certification precede mock issuance to the supplier wallet. |
| 2 | How does the supplier obtain early payment? | Request financing → offers | The supplier lists all or part of the tokenised payable on a marketplace and sets a buy-now price or a bid price before accepting a bid. |
| 3 | What does the lender underwrite? | Marketplace → credit detail | ADATA's payment obligation, with an indicative grade, terms, invoice reference, and event history. |
| 4 | Can a holder transfer without selling? | Transfer | A holder can transfer any allowed quantity they own to another eligible wallet on the platform, with no on-platform payment. |
| 5 | What if the supplier holds it? | My payables → maturity | At maturity, ADATA pays XUSD face value for the quantity the supplier still holds. |
| 6 | Who approves issuance? | ADATA approval → StraitsX grading | A separate ADATA checker approves the invoice-backed payable; StraitsX certifies it before issuance. |
| 7 | Must the supplier accept receipt? | Supplier inbox | Supplier will have an option to accept the tokenised payable or reject it |
| 8 | Who wins the bidding? | Offers received | The seller chooses an eligible bid. Successful settlement closes the listing and expires competing bids. No automatic auction. |
| 9 | How does a sale settle? | Trade confirmation | The lender funds the XUSD purchase price using USDC, USDT, XSGD, or XUSD. The seller receives XUSD and the lender receives the listed quantity. |
| 10 | What happens at maturity? | ADATA settlement → holder wallets | ADATA repurchases outstanding quantity at face value from each current holder. A lender's gross return on a holding is that quantity's face less its purchase price. |
| 11 | What can a lender do after purchase? | Portfolio | Hold to maturity, relist all or part, or transfer any held quantity before maturity. |
| 12 | How is the token represented? | Token detail / mock explorer | One invoice maps to one ERC-1155 token ID. The demo uses four-decimal face-value accounting and allows partial-quantity transfers in whole base units (§6). |
| 13 | How do pricing and funding differ? | Listing → funding confirmation | Issue, listing, bid, sale proceeds, and redemption are denominated in XUSD. The funding asset is selected only for payment. |

Invoice disputes, cancellation, and live default or recovery workflows are out of scope. An example overdue position is included (§7).

## 4. Scope and priorities

**Required for the demo**

- Four switchable personas: ADATA, supplier, lender, and StraitsX admin.
- There can be multiple supplier, lender, issuer, but only 1 StraitsX Admin
- Instant signup, mock KYC, and simulated custodial wallets with displayed `0x` addresses.
- Manual payable creation with prefilled sample invoice data, followed by maker-checker approval, grading, and issuance.
- Supplier receipt, hold-to-maturity, and listing of all or part of a holding for financing.
- Institutional marketplace with bids, seller acceptance, buy-now, and secondary listings.
- XUSD denomination throughout; USDC, USDT, XSGD, and XUSD as funding options.
- Peer-to-peer transfers of any held quantity between eligible platform wallets.
- Four-asset balances and demo-only top-ups.
- Maturity settlement to each current holder in proportion to quantity, and one illustrative overdue/recovery screen.
- One seeded Series to demonstrate invoice bundling, subject to the ownership default in §6.
- Shared state, seeded history, fast-forward controls, and reset.
- Partial-quantity ownership: a supplier can sell portions to different lenders at different discount rates, or transfer a portion to any eligible platform wallet.
- All personas will have a wallet balance that they can fund with stablecoins through a mock funding button.


**Out of scope**
- Real blockchain connectivity, private keys, wallet signing, gas, or money movement.
- Real KYC/AML, sanctions screening, accreditation, on/off-ramps, or fiat settlement.
- Actual ERP integration, invoice verification, legal documents, or e-signatures.
- A production credit model; grades are manually assigned demo values.
- Coupons, early buyback, and partial maturity settlement (paying less than outstanding face).
- Issuing or listing in USDC, USDT, or XSGD.
- Operational cancellation, invoice disputes, liquidation, or recovery processing.

## 5. Personas / Role

| Persona | Purpose | Main actions |
|---|---|---|
| **ADATA finance — anchor buyer / issuer** | Settle approved supplier obligations on their agreed due dates. ADATA receives no financing proceeds in this flow. | Create and approve payables; review outstanding obligations; fund XUSD redemption to current holders at maturity. |
| **Supplier — first holder** | Obtain early payment against an approved receivable, or retain it until maturity. | Receive, list all or part, accept bids, hold, or transfer a quantity. |
| **Lender — bank, fund, or corporate treasury** | Purchase a payable at a discount based on the anchor obligation and receive face value at maturity. | Review credit information, bid, buy, manage holdings, relist all or part, or transfer a quantity. |
| **StraitsX admin — platform** | Demonstrate issuer onboarding, programme standards, grading, and oversight. | Certify ADATA / tokenised payable issuer, set programme limits, assign sample grades, and monitor settlement. All other admin related controls handled by this persona |


There should be a feature to create new account for new users, and assign them a persona.
There should be a persona switcher to allow us to switch b/w personas for easy demo without having to login and logout.

For example: Create a user -> assign it a persona -> fill up necessary information -> user with its relevant persona account created. We can then view this newly created user in the drop down and switch to the user and view the user's holdings and other user account values.

StraitsX admin account is the only one where there's 1 single account managed by 1 single user. The admin account can delete all other users from the platform.

The scenario uses ADATA payment terms of 30–180 days.

## 6. Instrument and pricing

### Core terms

**One invoice = one identifiable payable.** Each invoice maps to a distinct ERC-1155 token ID. After certification, the mock mint assigns the entire invoice quantity to one supplier wallet. That first holder may then list all or part of the holding at different prices, or transfer any allowed quantity to another eligible platform wallet, including another supplier. Multiple holders exist only after a sale or transfer, never at issuance. Each wallet's remaining quantity is a separate position for listing, transfer, and redemption.

Use a four-decimal accounting convention: XUSD 1.0000 of face value corresponds to 10,000 base units. Partial-quantity transfers and listings are allowed. The minimum increment is one base unit (XUSD 0.0001); amounts between base units are not representable. A transfer or listing quantity must be a positive whole number of base units and must not exceed the sender's holding. 

Note that ERC-1155 supports multiple token types and integer quantities

**Discount purchase; bullet redemption.** The lender buys a quantity below that quantity's face and receives a single payment equal to the held quantity at maturity. 

**XUSD denomination.** Face value, listing prices, bids, buy-now prices, sale proceeds, and redemption amounts are all XUSD. 

**Funding conversion.** USDC, USDT, and XUSD fund XUSD obligations at a mocked 1:1 rate. XSGD uses a single mocked rate of 1XUSD = 1.31 XSGD. The recipient always receives XUSD. 

### Pricing convention

Use one calculation across listings, offers, dashboards, and the runbook. `F` and `P` apply to the quantity being priced, not automatically to the original invoice face:

- `F` = XUSD face value of the quantity being listed, bid, or sold; `P` = XUSD purchase price for that quantity; `d` = remaining calendar days to maturity.
- Price (% of face) = `100 × P / F`.
- Discount amount = `F − P`.
- Annualised discount cost (% of face) = `100 × (F − P) / F × 365 / d`.
- Lender implied annualised yield (% of purchase price) = `100 × (F − P) / P × 365 / d`.

Use a simple Actual/365 convention, with no compounding or fees in the demo. Display the two annualised measures with their distinct labels; they use different denominators. The 18% supplier bank rate and 5% anchor funding rate are indicative benchmarks. At or after maturity, show “Due” or “Overdue” instead of calculating a forward yield.

**Worked example:** XUSD 250,000 face value, 90 days remaining, price 97.85% → XUSD 244,625 proceeds, XUSD 5,375 discount, **8.7% annualised discount cost** and **8.9% lender yield**. Use this calculated example consistently in the supplier comparison.

Keep XUSD amounts at four-decimal precision internally, using fixed-point arithmetic. Display two decimals in summary views and four in token detail where useful. Source-asset rounding must be explicit on confirmation. Show both the original invoice face and the quantity in the current action whenever they differ.

### Series bundling

A Series groups invoices with the same anchor, currency, and maturity date into one purchase and settlement lot. It aggregates smaller tickets. Each member retains its invoice reference and token ID. Series membership is a lot-grouping mechanism; it does not replace the quantity rules above. Individual payables may still be sold or transferred in part when they are not locked into a Series operation.

Series bundling allow us to bundle TPs by maturity so ticket size is worth a bank’s time. 

Series face value is the sum of included member quantities. Buy, transfer, and redemption must apply to every member together at those quantities. Series yield uses the aggregate price and shared maturity date; the Series grade is assigned explicitly by the admin.


### Payable fields shown to users

| Field | Example | Notes |
|---|---|---|
| Reference | `TP-2026-0141` | Stable human-readable ID. |
| Anchor obligor | ADATA Technology Co., Ltd. | Responsible for the maturity payment in the scenario. |
| Original supplier | Chien Yu Precision | Fictional; distinct from current holders. |
| Currency | XUSD | Fixed. |
| Face value | 250,000.0000 XUSD | Original invoice face. Base units = face × 10⁴. |
| Holder quantity | 250,000.0000 XUSD | Signed-in wallet's position; may be less than invoice face. |
| Issue date / maturity date | T0 / T0 + 90 days | Derived from the demo clock. |
| Original tenor / days remaining | 90 days / 90 days | Display separately; calculate yields using days remaining. |
| Credit grade | AA — Sample | Assigned by StraitsX admin; include rationale. |
| Invoice reference | `INV-TW-88213` | Fictional. |
| Series | — | Optional bundle membership; split holdings are ineligible. |
| Lifecycle / market status | Issued / Listed | Separate obligation status from listing status. |
| Current holder(s) | `0x7a3f…c21d` · 250,000.0000 | Quantity per wallet. Quantities must sum to outstanding face until redemption. |
| Token ID / issuance reference | Mock ID / mock transaction | Clearly labelled as simulated. |

Listing price, bid price, purchase price, and yield belong to marketplace or position records, not the contractual face value.

## 7. Lifecycle and transaction rules

Separate the payable's obligation lifecycle from market activity and ownership history.

```text
Draft → Pending approval → Approved → Certified → Issued → Matured → Settled
                                                               │
                                                               └→ Overdue
```

- **Pending approval → Approved:** the ADATA checker approves the preparer's submission.
- **Approved → Certified:** StraitsX assigns a grade and certifies eligibility under the programme.
- **Certified → Issued:** mock mint assigns the full quantity to the supplier wallet.
- **Issued:** each holder may hold, list, sell, or transfer any quantity they own, up to their balance, before maturity. “Listed,” “Financed,” and “Transferred” are market labels or historical events; none is a prerequisite for maturity.
- **Matured:** the payable is due, regardless of who holds it or whether it was ever financed. Expire active listings and bids. ADATA funds the full outstanding face, allocated to each current holder in proportion to quantity held.
- **Settled:** every remaining holder has received XUSD equal to their quantity; the payable is marked redeemed and cannot move or settle again.
- **Overdue:** an unpaid obligation has passed its due date. Show one example recovery case with grace-period information, recovery status, and a fictional appointed liquidator. Recovery is a read-only scenario, not an operational workflow.

Trade settlement must debit the payer, credit the seller in XUSD, move the traded quantity from seller to buyer, close the listing, and expire competing bids as one operation. The seller keeps any unlisted remainder. Maturity settlement must similarly debit ADATA, credit each current holder for their quantity, and mark the obligation settled together. A failed action leaves balances and ownership unchanged; repeated confirmation must not duplicate a payment. Holder quantities are whole base units and must sum to outstanding face until redemption, so pro-rata maturity credits are exact.

Idempotency is required and important for all transaction, similar to how a blockchain will behave.

## 8. Screens

### ADATA

1. **Dashboard:** outstanding payable count and face value, next settlement date, and financed/unfinanced split. Count Series members once in programme totals. Split holdings still count as one payable.
2. **Create payable:** manual entry or “Import from ERP.” The import uses a clearly simulated SAP-style picker and select from a list of 10 different sample invoice pre-generated for the demo

3. **Approval queue:** preparer submission and separate checker approval, with actor and timestamp history. Certification and issuance status remain visible after approval.

4. **Settlement:** due payables, current holders and quantities, and full XUSD obligation. “Fund settlement” opens the funding-asset picker, conversion, source debit, and per-holder XUSD credits before confirmation.

### Supplier

5. **Onboarding:** company details and custodial wallet creation. Mark the account "KYC verified” on submit. No document upload and no external wallet connection required. (we will only need to submit KYC docs in the real production launch)

6. **My Tokenised Payables:** inbox and holdings, invoice face, held quantity, days remaining, and indicative or executable sale proceeds labelled accordingly. Keep the calculated financing comparison visible. Provide hold information and access to transfer of any held quantity.

7. **Request financing:** choose an eligible holding and the quantity to list (default = full holding), enter a minimum XUSD price or use an indicative price, and optionally set buy-now. Publish in XUSD with no currency picker. Price percentages use the listed quantity as `F`.

8. **Offers received:** bidder, listed quantity, XUSD offer, price as a percentage of listed face, days remaining, implied yield, and selected funding asset. The seller accepts one offer.

### Lender

9. **Marketplace:** “Institutional lenders only” header; filter by maturity, tenor, sample grade, ticket size, and yield. Default sort is yield. No listing-currency filter is needed. Show listed quantity alongside original invoice face when they differ.
10. **Payable detail:** lead with ADATA and the payment obligation. Show grade and rationale, original supplier, invoice reference, invoice face, listed quantity, holder breakdown, price, yield, remaining days, eligible funding assets, and event history. Expand a Series to inspect its members.
11. **Place bid / buy now:** enter price as a percentage of the listed quantity's face and show the equivalent XUSD amount. Select the funding asset before confirmation. Show conversion, source debit, available balance, and XUSD seller credit.
12. **Portfolio:** current holdings by quantity, purchase price for that quantity, invoice face, remaining days, maturity ladder, purchase-price-weighted entry yield, realised gross returns, and the overdue position. Allow eligible holdings to be relisted in whole or in part.
13. **Transfer:** shared supplier/lender flow. Enter an eligible platform wallet address and a quantity (default = full holding), show the resolved recipient, confirm, and record the transfer event. Reject quantities that are not whole base units or that exceed the sender's unlisted holding.

### StraitsX admin

14. **Issuer certification:** ADATA programme details, certification status, and configurable programme limits.
15. **Grading:** assign AAA / AA / A with an sample rationale. Only certified, graded payables can be listed. An advance-rate/LTV mapping is pending definition (§16); do not present it as an external rating or guarantee.
16. **Programme oversight:** issued, financed, settled, and overdue totals, with access to event history and the sample recovery case.

### Common to all users

1. **Send payable:** allow a holder to send any portion of their tokenised payable holding to another platform user. Enter the recipient's registered wallet address or select from a list of eligible recipients, specify the quantity to send (default = full holding), and confirm the transfer. The system verifies that the sender has sufficient unlisted quantity, the recipient is valid, and the quantity is a whole base unit. Successfully sending TP moves the specified quantity to the recipient's wallet, records the transaction, and updates event and ownership history. All transfers occur within the platform.


## 9. Marketplace mechanics

Use **bid-and-accept with optional buy-now**. A full order book, automatic auction matching, and market-depth visualisation are out of scope.

- Only eligible institutional lender accounts can bid or buy. Marketplace access is a demo permission, not real accreditation.
- A holder lists a quantity of a payable or a Series in XUSD. The listed quantity defaults to the full holding and may be any allowed partial quantity. Store monetary prices in XUSD for that quantity; percentage-of-face entry converts to the same amount using listed face as `F`.
- Validate the seller's ownership, quantity, and the instrument's eligibility before listing. A wallet may have only one active listing per payable or Series. Listed quantity cannot exceed the seller's holding.
- Listed quantity is locked to the listing. Any unlisted remainder may be held or transferred. A transfer that would reduce the holding below the listed quantity must close the listing and expire its bids as part of the transfer.
- The lender selects a funding asset when bidding or buying. The XUSD bid is fixed; its source-asset debit follows the displayed conversion rule.
- **Draft funding default:** bids do not reserve funds. Recheck balance, ownership, listed quantity, listing status, and maturity when a seller accepts. If funds are insufficient, show an actionable message and leave the bid, balances, and position unchanged.
- For XSGD, use a fixed rate within each resettable demo world so bid and acceptance amounts remain reproducible.
- On successful purchase, move only the listed quantity, expire competing bids, and show the seller's XUSD receipt, the buyer's new holding, and the seller's remaining quantity if any.
- Secondary sales use the same rules.

**Structure decision:** the draft demonstrates direct institutional purchase. The earlier source notes also describe lending through a pool with licensed intermediaries. Institutional gating does not settle that difference. Keep the direct-purchase flow as an explicit demo assumption until legal and commercial owners confirm the structure (§16).

## 10. Wallets, funding, and audit history

Every account has a simulated custodial wallet address and separate USDC, USDT, XSGD, and XUSD balances. No keys are generated or held for this mock; there are no seed phrases or signing prompts.

For each chain-relevant action, show:

1. XUSD obligation, quantity, and recipient(s). For a split payable at maturity, show each holder and the XUSD credit for their quantity.
2. Selected funding asset and available balance, when the action is a payment.
3. Conversion rate and resulting source-asset debit, when a funding asset is used.
4. XUSD amount credited to each recipient, when the action is a payment.
5. Confirmation, a recorded event, and a mocked blockchain transaction receipt.

For XSGD, `source debit = XUSD obligation / rate`, where rate is XUSD per 1 XSGD. For the three mocked USD assets, the rate is 1:1. Simulated top-ups belong only in the demo controls.

Every meaningful action creates an audit event. Every successful chain-relevant action also generates a mocked blockchain transaction and displays it as a transaction receipt immediately after confirmation. The same receipt must be reopenable from event history and the mock explorer. Label every hash, block number, and receipt as simulated.

Chain-relevant actions are issuance (mint to the supplier wallet), trade settlement, quantity transfer, maturity redemption, and simulated wallet top-up. A receipt includes a transaction hash, block number, success status, from and to addresses, token ID and quantity when tokens move, and asset debit/credit when balances change.

Approval, grading, listing publication, bid placement, and other application events remain visible in audit history without a chain receipt. They are not mocked as on-chain transactions.



## 11. Demo controls

Provide a persistent bar, clearly labelled **Demo controls**:

- **Persona switcher:** move between all four roles; select preparer/checker within ADATA.
- **Fast-forward:** +1 day, +30 days, or jump to next maturity. Recalculate remaining days and due statuses. Advancing time does not automatically fund ADATA's obligations.
- **Reset world:** restore the complete seed state, including the clock and mocked FX rate.
- **Simulate top-up:** choose a wallet and asset, then add a mock balance.
- **Trigger overdue:** open or activate the designated overdue example without requiring a live default workflow.

The “Demo environment — no real funds” ribbon is always visible. Because the world is shared, show that reset and time changes affect all connected demo sessions.

## 12. Seed data

Use fictional supplier names, invoice numbers, financials, grades, and histories. ADATA is the intentional named-anchor exception. Dates are relative to demo T0; fixed references are identifiers rather than live dates.

| Reference | Original supplier(s) | Face (XUSD) | Days remaining at T0 | Grade | Ask (% of face) | Lender yield | Initial state |
|---|---|---:|---:|---|---:|---:|---|
| TP-2026-0143 | Ming Kuo Components | 1,200,000 | 30 | AAA | 99.42 | 7.1% | Issued / Listed |
| TP-2026-0141 | Chien Yu Precision | 250,000 | 90 | AA | 97.85 | 8.9% | Issued / Listed |
| TP-2026-0142 | Hsin Ta Electronics | 48,000 | 60 | A | 98.40 | 9.9% | Issued / Listed |
| SERIES-2026-Q4-30D | 12 fictional suppliers; one current holder | 180,000 | 30 | A | 99.20 | 9.8% | Issued / Listed |
| TP-2026-0128 | Yung Sheng Metals | 320,000 | — | AA | — | 9.2% realised annualised yield | Settled |
| TP-2026-0119 | Fu Hsing Plastics | 75,000 | Past due | A | — | — | Overdue / showcase demo recovery |

Listed yields are calculated from the remaining days and asks above, rounded to one decimal place. The settled row needs a historical purchase price and holding period that support the displayed 9.2%; overdue data needs an explicit due date and sample recovery timeline. Seeded listings are whole holdings so the five-minute runbook stays a full-invoice story; partial-quantity listing and transfer remain available in the live demo.

Seed one ADATA preparer, one ADATA checker, three interactive supplier accounts, two institutional lenders (one bank and one fund), and one StraitsX admin. Include fictional supplier entity records and wallets for all remaining invoice originators. Pre-fund both lenders in all four assets, with one predominantly funded in USDC and the other in XUSD, and add portfolio history.

Also seed an **unissued ERP invoice** for the core runbook: XUSD 250,000, 90 days from issuance, payable to the active supplier. Give it a distinct invoice/payable reference so the pitch can issue and list a new position without colliding with the existing listed example. Include a suggested 97.85% price and two competing bids on another seeded listing to make the bid book immediately visible.

Keep the supplier bank benchmark of 18% and anchor funding benchmark of 5% labelled as scenario assumptions. Actual displayed sale costs come from the selected payable's price and remaining days.

## 13. Data model

The model must distinguish entities, user roles, ownership, market activity, and payments. This is a minimum conceptual model, not a database schema.

```text
Entity       id, name, entity_type, certification_status, programme_limit
User         id, entity_id, name, role, mock_kyc_status, institutional_eligible
Wallet       address, entity_id, balances_by_asset
Payable      id, ref, token_id, anchor_id, original_supplier_id, face_xusd,
             currency (= XUSD), issue_date, maturity_date, grade, grade_rationale,
             invoice_ref, lifecycle_status, series_id (nullable)
Holding      payable_id, wallet, quantity_xusd
Series       id, ref, anchor_id, currency (= XUSD), maturity_date, grade,
             member_payable_ids
Listing      id, payable_id OR series_id, seller_wallet, quantity_xusd,
             min_price_xusd, buy_now_price_xusd (nullable), status
Bid          id, listing_id, bidder_wallet, price_xusd, funding_source, status
Trade        id, listing_id, accepted_bid_id (nullable), buyer_wallet,
             seller_wallet, quantity_xusd, purchase_price_xusd, executed_at,
             settlement_id
Settlement   id, kind (trade|redemption), payable_id OR series_id,
             payer_wallet, recipient_wallet, quantity_xusd, xusd_amount,
             funding_source, source_amount, fx_rate, status, completed_at
Event        id, subject_type, subject_id, type, actor, timestamp,
             chain_ref (nullable), payload
DemoClock    current_date, offset_days, xsgd_xusd_rate
```

`payable_id OR series_id` means exactly one target. `Holding.quantity_xusd` is a positive four-decimal amount in whole base units; holdings for a payable must sum to outstanding face until redemption. A wallet with quantity zero has no holding row. Derive Series face value from member quantities, and validate that every member is wholly held by the same seller wallet and shares maturity. `Trade` records provide purchase cost and holding-period history for portfolio metrics. Tenor, remaining days, percentages, and yields are derived rather than independently editable values. Redemption of a split payable records one credit `Settlement` per holder against a single ADATA source debit.

`funding_source` belongs to a bid/payment instruction, never the instrument. Every payment event records the source asset, conversion, source debit, XUSD credit, and recipient. Approval events preserve the separate preparer and checker identities.

## 14. Non-functional requirements

| Area | Requirement |
|---|---|
| Devices | Desktop first, usable down to iPad. Validate the actual booth laptop and tablet layouts. |
| Persistence | A lightweight postgres sql database. Changes must be reflected in other sessions without a manual reset. |
| Consistency | Prevent duplicate acceptance, double spending, over-quantity transfers, stale-owner transfers, and duplicate redemption across sessions. Holder quantities must remain whole base units that sum to outstanding face. |
| Performance | Core actions complete within 500 ms to 2000ms. show clear progress for simulated onboarding. |
| Language | English required; Mandarin for issuer/supplier screens is optional. |

| Accounts | Instant mock signup with no email verification. Persona selection must still enforce the simulated role's permitted actions. |

| Validation | Invalid inputs and insufficient balances receive clear inline feedback;|

| Auditability | All meaningful actions are traceable to a persona, subject, and demo timestamp. Mock chain references are clearly labelled. |

## 15. Delivery plan and verification

| Stage | Deliverables | Exit condition |
|---|---|---|
| 1 — Core issuance | Data model, shared state, holdings by quantity, personas, wallets, ERP mock, maker-checker, grading, issuance, mock-chain boundary. | An invoice can be created, independently approved, certified, and issued in full to the correct supplier wallet. |
| 2 — Financing and redemption | Marketplace, partial listings, bids, buy-now, four funding assets, conversion, quantity transfers, Series, multi-holder maturity settlement, clock, and top-ups. | Supplier-held and lender-held quantities redeem correctly, including split holdings; secondary trades and transfers preserve ownership, quantities, and balances. |
| 3 — Demo readiness | Seeded history, overdue view, visual polish, reset, runbook, and two timed dry runs with the presenter. Add optional features only after the core flow passes. | The presenter and an unassisted reviewer each complete the core story in five minutes. |

Before handover, verify:

- Every persona can reach and complete its required screens, with distinct maker/checker actions.
- Currency is locked to XUSD, and each of the four funding assets produces the expected debit and XUSD credit.
- The §6 worked example matches every screen; fast-forward recalculates remaining days and yields correctly.
- Held, sold, partly transferred, and bundled payables pay each current holder their outstanding quantity at maturity.
- Partial listings leave the unlisted remainder with the seller; competing bids, stale actions, insufficient funds, over-quantity transfers, and repeated confirmation cannot corrupt ownership or balances.
- A Series moves as one lot of wholly held members, and programme totals do not double count its members.
- Reset restores the full world on both devices; the ribbon and mock labels remain visible throughout.


## Appendix — source context


- `#tf-taiwan-adata-tokenised-payables`, Mark Hew, 11–12 Sep 2026 — Token2049 request, core questions, and pitch deck.
- `#tf-adata-baas-partnership`, 14 Aug 2026 — ADATA discussion notes on structure, economics, and MVP/DeFi phasing.
- `#tf-amazon-2025-partnership-tokenised-payables`, Dec 2024 — MUFG feedback on bundling and custody.
- Notion: *Amazon tokenized payable* RFC — instrument definition and exchange components.
- Notion: *KR3.4 tokenised payables design for ADATA* — lifecycle, settlement, and testnet context.
- Notion: *StraitsX x ADATA x BaaS MOU* and *ADATA MOU Signing* — partnership context.
- Daily Work Log, 3 Sep 2026 — legal questions, requirements timing, and invoice-to-contract mapping.
- [ERC-1155: Multi Token Standard](https://eips.ethereum.org/EIPS/eip-1155) — checked during this review to clarify token IDs, quantities, and the distinction between the standard and application rules.
