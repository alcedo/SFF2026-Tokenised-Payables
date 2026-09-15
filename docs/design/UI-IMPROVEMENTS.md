# UI design improvements — synthesized catalog

Vetting copy. No product code in this change. Approve, reject, or defer each
**Must-ship** item before implementation. Operator and polish lists are backlog
unless you promote them.

## Arena record

Four catalogs, same prompt, isolated paths. Cross-judge (Composer 2.5) and the
parent (Grok 4.6) both picked **candidate 1** as the base.

| | Model | Items | Judge total |
|---|---|---|---|
| C1 (base) | Grok 4.6 | 48 | 30/30 |
| C2 | Composer 2.5 | 50 | 26 |
| C3 | Grok 4.6 fast | 45 | 28 |
| C4 | Composer 2.5 fast | 45 | 26 |

**Thesis (base):** The portal already looks like treasury. The failure is equal
weight. Rank who is acting, what day it is, which screen this is, and the one
decision figure — then subtract competing chrome.

**Grafted from losers** (redesigned into the items below, not pasted):

- C3: admin **Issuance queue** nav; approval **worklist** before cards; cash on
  `AssetPicker`; hide the financing comparison until the supplier accepts.
- C2: settlement shortfall **before** the asset picker; holder-table **subtotal**.
- C4: settlement **jump list** when several payables are due; offers sorted by
  price descending.

**Rejected (even where popular):** hide Sample to a tooltip (C3); collapse
header balances on phone (C2); truncate the demo ribbon (C2); nav-edge fade
(C4); keep the decorative certification bar (C4); collapse the realised table
instead of scoping it to this wallet (C4); lifecycle steppers on every approval
card (C2/C4); new payable-detail routes; modals; dark mode; consumer restyle.

**Verification:** Must-ship claims were checked against the live source (not
against candidate self-reports). See the checklist at the end.

---

## How to read a row

Each item is independently shippable. Colour stays meaning-only. Accent
`#1b3a5c` is for primary actions and active nav only. The demo ribbon, persona
switcher, Simulated/Sample labels, and maker-checker stay.

Effort: **S** tokens/copy, **M** layout in existing components, **L** would be
out of bounds here (none of these are L).

---

## Must-ship — for vetting

These are the selection. They are what a five-minute room demo actually trips
on.

### S-01 Active route on product nav
- Effort: S · `src/components/Shell.tsx`
- **Problem:** Every nav link is muted + `border-transparent`. After a persona
  switch the room cannot tell Dashboard from Settlement.
- **Change:** Accent underline, ink label, `aria-current="page"`. Prefix-match
  nested routes (`/lender/[id]` → Marketplace).
- **Keep:** Same labels and hrefs.

### S-02 Demo controls: persona and clock are the spine
- Effort: M · `src/components/DemoControls.tsx`
- **Problem:** Persona, date, +1d, Next maturity, top-up, New account, Trigger
  overdue, and Reset share one wrap row of equal 11px chips. Hairline
  separators orphan when the bar wraps. `working…` is faint and lands far from
  the control that was clicked.
- **Change:** Three labelled clusters (Persona, World clock, Demo tools). Date
  and persona select at 13px medium. Demote +1d/+30d to secondary; keep Next
  maturity slightly heavier. Pending/note on a full-width second line,
  `aria-live="polite"`. Drop the wrapping `w-px` rules.
- **Keep:** Every control; admin-only Reset; always-visible bar.

### S-03 Rename “Trigger overdue”
- Effort: S · `DemoControls.tsx`, `src/app/overdue/page.tsx`, settlement empty hint
- **Problem:** The control is a link to a read-only case. In a room it sounds
  like it manufactures a default. Settlement empty copy says “Jump to next
  maturity”; the button says “Next maturity”.
- **Change:** Label **Overdue case**. Align empty-state copy to the real button
  names. Always render the overdue page `h1` (empty state today is a floating
  Panel).
- **Keep:** Same route, seeded TP-2026-0119, no recovery workflow.

### S-04 Compact chrome without collapsing it
- Effort: M · `layout.tsx`, `DemoControls.tsx`, `Shell.tsx`
- **Problem:** Ribbon + demo bar + two-row product header eat the first
  screenful on a projector.
- **Change:** Keep the ribbon sticky. Stick demo controls directly under it.
  Collapse the product header to one desktop row: title + entity/role | nav |
  four balances. Tighten vertical padding. Do not hide overflow on `html`/`body`.
- **Keep:** Ribbon copy; four assets always visible.

### S-05 Approval queue is a worklist; next actor is ink
- Effort: M · `src/app/adata/approvals/page.tsx`, `ActionButton.tsx`
- **Problem:** Each in-flight payable is an essay card. Disabled Approve /
  Certify / Issue put the reason on `title` only. Certify and Issue still render
  for ADATA as inert controls. The “switch persona” hint is the faintest line.
- **Change:** Lead with one `table.ledger`: ref, supplier, face, status, **next
  act**, **who**. Click a row to expand the existing card. For the current step,
  one primary button if this persona can act; otherwise a persistent info
  `Notice` naming the role (“Next: ADATA checker — switch persona in Demo
  controls”). Print `disabledReason` under the control. Do not show
  Certify/Issue as if they were ADATA’s job. Collapse actor history to one line
  until opened.
- **Keep:** Real role refusals, inline confirm, two-person rule.

### S-06 Issuance queue on the admin menu
- Effort: S · `src/app/session.ts`
- **Problem:** StraitsX certifies and issues on `/adata/approvals`, but admin
  nav never lists that screen. Glance at the header after a persona switch and
  the queue has vanished.
- **Change:** Add `{ href: '/adata/approvals', label: 'Issuance queue' }` to the
  admin list. Optional in-flight count beside the label.
- **Keep:** Same screen, same refusals; no certify buttons on Programme
  oversight.

### S-07 Supplier comparison is the slide
- Effort: M · `src/app/supplier/page.tsx`, `FinanceForm.tsx`
- **Problem:** The runbook stops on proceeds / 8.7% / 18%. Those sit in equal
  12px rows, cost painted green, bank painted critical. A Stat tile already
  shouts `18%` at 19px. Pending-accept cards still show the comparison the
  supplier cannot use yet.
- **Change:** Three tabular figures at Stat scale: proceeds, programme cost,
  bank 18%, plus one delta line. Drop the Bank benchmark Stat. Both rates in
  ink; `text-positive` only on the “points less” sentence. If
  `receipt === 'pending'`, hide the comparison and Request financing; keep
  facts + Accept/Decline.
- **Keep:** Comparison on this screen; 18% labelled scenario assumption;
  indicative 97.85%.

### S-08 Marketplace: yield is the scan column
- Effort: S · `src/app/lender/page.tsx`
- **Problem:** Reference is already a link; every row also has a filled
  **Review**. Yield shares weight with ask, price, days, and a constant
  “Anchor obligor / ADATA” Stat.
- **Change:** Drop Review. Whole row (or ref + yield) is the hit. Yield 13px
  semibold tabular. Replace the ADATA Stat with a number that reacts to the
  filter (best tenor among shown lots, or drop the tile). When listed face
  equals invoice face, do not compete with a second copy of the same number.
- **Keep:** Default sort by yield; listed vs invoice when they differ; URL
  filters.

### S-09 Settlement package
- Effort: M · `settlement/page.tsx`, `FundingPanel.tsx`, `AssetPicker.tsx`,
  `adata/page.tsx`
- **Problem:** Three figures sit in one Panel inside a four-column grid. The
  Field labelled “Status” is `DaysRemaining`. Shortfall `Notice` appears after
  the asset picker. `AssetPicker` is tickers only; the room checks the header
  instead. Due rows duplicate on the ADATA dashboard. Holder credits have no
  sum. Several due payables are a long scroll.
- **Change:**
  1. Stat strip: payables due, total obligation, ADATA XUSD, shortfall if any.
  2. Relabel Status → Days.
  3. Critical shortfall line **above** AssetPicker.
  4. Each picker button: asset + 2-dp balance; `text-critical` when that asset
     cannot cover the current debit (also on BidPanel).
  5. Holder table `tfoot`: total credited.
  6. Jump list of refs when more than one payable is due.
  7. Dashboard: one ledger; tone due/overdue rows; keep **Fund settlement →**;
     no second copy of the same rows. Link due refs to `/adata/settlement`.
- **Keep:** Clock does not fund; one debit / N credits; Simulate top-up path.

### S-10 Confirms must not blow up a ledger row
- Effort: M · `ActionButton.tsx`; worst cases: offers Accept, accounts Remove
- **Problem:** Arm → confirm is correct. In a table cell it reflows the whole
  blotter at the climax of the trade. Success then replaces the control with
  Notice + Close.
- **Change:** Table mode: one-line confirm + Confirm/Cancel in a rail under the
  table (or a full-width row), keyed to that bid/user. After success, keep the
  control (disabled “Done”) and stack the Notice + Simulated receipt underneath.
- **Keep:** Idempotency on arm, inline refusal, no modal.

### S-11 Status chips that do not alias
- Effort: S · `src/components/primitives.tsx`
- **Problem:** `approved` and `certified` share accent-soft. `Listed` is the
  same recipe. `pending_approval` and `matured` share caution.
- **Change:** Caution only for pending approval. Accent-soft only for
  certified. Issued stays positive. Matured = ink + strong rule unless overdue
  (critical). Listed = quiet outline, not accent fill. Draft weakest; settled
  quiet “done”, not muted-on-muted.
- **Keep:** Lifecycle vs market status as two chip families.

### S-12 After create, name the queue; keep the button visible
- Effort: S · `ErpPicker.tsx`, `ManualEntry.tsx`, `ActionButton.tsx`,
  `OnboardingForm.tsx`, `AddUser.tsx`
- **Problem:** Success is an inline Notice with no link. Incomplete forms hide
  Create behind an info box, so the action looks missing.
- **Change:** On ok, **Open approval queue** beside the receipt (do not
  auto-navigate). Always show the primary control; disable it with the same
  sentence as the Notice when the form is incomplete.
- **Keep:** Simulated SAP chrome; checker still required.

### S-13 Disabled reasons in ink, not hover
- Effort: S · `ActionButton.tsx`, `GradeForm.tsx`, `accounts/page.tsx`
- **Problem:** Booth and touch have no hover. Grey Approve looks like a broken
  demo.
- **Change:** When `disabled && disabledReason`, render the sentence at 11.5px
  muted under the control.
- **Keep:** All existing gates.

---

## Operator — recommended backlog

Promote any of these with the Must-ship set; they are not required for the
five-minute script.

| ID | Item | Effort | Where |
|---|---|---|---|
| O-01 | Role label in the product header; dedupe top-up wallets by address | S | Shell, DemoControls |
| O-02 | Payable refs link to existing screens only (settlement, overdue, explorer `?q=`, finance/transfer). No new detail app. | M | ADATA/admin/explorer/portfolio/grading |
| O-03 | `LedgerScroll` max-height so sticky `thead` actually pins (explorer, admin book, marketplace) | S | globals.css, primitives |
| O-04 | Human event labels from `TRANSITIONS[].label`; `ROLE_LABEL` for roles | S | approvals, explorer, lender detail, overdue |
| O-05 | Offers: drop per-row listed quantity; Funded/Short chips; sort bids by price descending; quiet “best” on the first row | S | offers/page.tsx |
| O-06 | Holdings page: 2 dp in summary; dense ledger for accepted lots; full comparison for the selected live row (still on this page) | M | supplier/page.tsx |
| O-07 | Finance form: keep the quote visible while the error Notice shows; grouped thousands in quantity; “Use indicative 97.85%” as a secondary control | S | FinanceForm.tsx |
| O-08 | Bid/buy-now: sunken well not accent-soft slab; sticky right column on `lg`; “Or place a bid” rule | S | BidPanel, lender/[id] |
| O-09 | Lender detail: keep obligor hero; drop Terms fields already in the hero; restore a visible series disclosure marker; series one-holder rule as a Field | S | lender/[id]/page.tsx |
| O-10 | Marketplace filters: count only in the Stat strip; Grade row then selects row; optional removable chips for active params | S | MarketFilters.tsx |
| O-11 | GradeBadge: “Sample” at the same 11px as the grade (muted, not faint). Do not drop the word. | S | primitives.tsx |
| O-12 | Portfolio realised = this wallet, not every settled payable in the world. Label the action **List**, not Relist-via-supplier-copy. Overdue links to `/overdue`. | M | portfolio/page.tsx |
| O-13 | EmptyState `py-4`, left-aligned, optional accent link to a real control. Marketplace must not tell a lender to Reset. | S | primitives + empties |
| O-14 | ERP: selected row `accent-soft`; consumed = Issued pill, not row opacity | S | ErpPicker.tsx |
| O-15 | Admin Books: one line + Explorer link. Recovery: link to `/overdue`, do not duplicate the dossier. | S | admin/page.tsx |
| O-16 | Certification: delete the decorative `bg-accent` bar; title-case status from IssuerControls labels | S | certification/page.tsx |
| O-17 | Grading: one ledger (ref, face, chips, rationale, assign), not stacked forms | M | grading/page.tsx |
| O-18 | Onboarding h1 **New account**; compact type toggle; “demo — marked verified, no documents” on the KYC row | S | onboarding |
| O-19 | Explorer: Simulated outline in-row or once in the panel header so the ribbon stays the unique yellow band; `?q=` find; drop the World-date Stat | S | explorer, MockTxRef |
| O-20 | Caution-soft budget: ribbon, due/pending-accept, overdue page. Simulated labels = outline, not caution fill. | S | layout, MockTxRef, chips |
| O-21 | `not-found.tsx` / `error.tsx` in portal voice (title, muted line, link home). | S | src/app |
| O-22 | Transfer: back to holdings/portfolio; resolved recipient once; grouped quantity | S | TransferForm |
| O-23 | Top-up: `100,000` default, unique wallet labels, disclaimer below the fields | S | TopUpPanel |
| O-24 | Reset success Notice that the shared world restored to T0 | S | reset/page.tsx |
| O-25 | Page titles match nav (ADATA: Outstanding obligations in both places) | S | session.ts / adata/page.tsx |

---

## Polish — optional

| ID | Item |
|---|---|
| P-01 | Phone: demo controls as three stacked labelled rows; first money Stat full-width |
| P-02 | Keyboard: focus Confirm after Arm; ERP row is a `label` for the radio |
| P-03 | Stat `.num` on numeric tiles; rename ADATA count **Payables** |
| P-04 | One world-date format (the bar’s) in actor history |
| P-05 | Accounts: table first, Add user expands; compact Remove per S-10 |
| P-06 | Manual vs ERP preview: one sunken dl; confirm copy includes face at 2 dp |
| P-07 | Compact MockTxRef in the explorer column; full variant on ActionButton results |
| P-08 | Unify back-links: 12px accent, one parent, above h1 |
| P-09 | Create-payable tabs live in the panel header |
| P-10 | Maturity-ladder refs on portfolio scroll to the holding row |

---

## Source check (must-ship)

Checked in `/workspace` before presenting:

- Nav links are all `border-transparent text-ink-muted` (`Shell.tsx`).
- Admin `navFor` has no `/adata/approvals` (`session.ts`).
- Settlement summary is one Panel inside `md:grid-cols-4`; Field “Status”
  wraps `DaysRemaining`.
- `FundingPanel` renders AssetPicker, then conversion/debit, then the
  shortfall Notice.
- `AssetPicker` buttons are asset tickers only.
- ADATA dashboard renders Due-for-settlement and All-outstanding as the same
  `PayableTable`.
- `STATUS_TONE.approved` and `.certified` are identical accent-soft.
- “Trigger overdue” is an `<a href="/overdue">`.
- Supplier comparison is equal 12px rows; cost `text-positive`, bank
  `text-critical`; comparison still renders when `receipt === 'pending'`.
- Marketplace Reference is a link **and** a Review button to the same URL.
- `ActionButton` disabled reason is `title=` only; success replaces the
  control.
- Portfolio “Realised” is `allPayables.filter(status === 'settled')` despite
  the comment saying this wallet.
- `table.ledger` thead is sticky, but `.ledger-clip` is `overflow-x` only, so
  the head never pins on long books.
- Certification page includes a decorative `bg-accent` limit bar (comment in
  source admits it).
