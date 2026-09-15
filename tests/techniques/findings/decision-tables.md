# Findings from `tests/techniques/decision-tables.test.ts`

Technique: decision tables. Each rule in `db/post.sql` is declared as data, one
row per combination of the conditions it reads, with the literal SQLSTATE,
message and end state that row expects. A runner executes every feasible row.
A combination the command set cannot produce carries the reason it cannot and
is reported as a skipped row rather than dropped, and every table asserts its
own row counts, so a row silently disappearing fails the suite.

| Table | Rule | Conditions | Rows | Feasible | Infeasible |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | issuance against certification and programme limit | 4 | 48 | 24 | 24 |
| 2 | maker-checker approval | 3 | 60 | 35 | 25 |
| 3a | bid acceptance, early gates | 2 | 18 | 12 | 6 |
| 3b | bid acceptance, conditions after the gates | 5 | 32 | 24 | 8 |
| 4 | maturity settlement | 6 | 144 | 62 | 82 |
| 5a | `create_user` role against organisation type | 2 | 20 | 20 | 0 |
| 5b | `onboard_entity` role against organisation type | 2 | 20 | 20 | 0 |
| 5c | `onboard_entity` name validation | 2 | 15 | 15 | 0 |
| 6 | user removal | 3 | 12 | 5 | 7 |
| | | | **369** | **217** | **152** |

Nothing in `src/` or `db/` was changed. Every scenario ends by asserting
`ledgerHealth(pool)` equals `HEALTHY`; the books balance through all of it.

---

## 1. Maker-checker is enforced nowhere on the write path

**FIXED.** `ledger.post()` now reads `app.lifecycle_edge.actor_role` through
`app.assert_edge_actor` and refuses any other actor with `ADA36`. The write-up
below is the state before that change; what replaced it is at the end of this
entry.

**Severity: the compliance rule the brief names is absent from the product.**

Files: `db/schema.sql` lines 320 to 347, `db/post.sql` lines 981 to 992,
`src/core/lifecycle.ts` lines 180 to 197, `src/app/adata/approvals/page.tsx`
lines 124 to 127.

Three layers each hold part of the rule and none of them is on the path that
writes.

`app.lifecycle_edge` carries an `actor_role` column, NOT NULL, populated on all
five edges (`pending_approval -> approved` is `adata_checker`). Nothing reads
it. The suite proves this from the database itself rather than by inspection:
`pg_get_functiondef(app.enforce_lifecycle_edge)` selects only `from_state` and
`to_state`, and `pg_get_functiondef(ledger.post)` contains neither the string
`actor_role` nor the string `lifecycle_edge`. The case that proved it is now
`carries an actor_role on every lifecycle edge, which ledger.post reads through
app.assert_edge_actor`, and it asserts the reader rather than its absence.

`src/core/lifecycle.ts::attempt()` implements the role half in TypeScript. Its
only callers are `src/app/adata/approvals/page.tsx`, which uses it to decide
whether to render a button, and `src/core/__tests__/lifecycle.test.ts`. No
server action, no API route and no database function calls it. A correction to
the brief's framing: `attempt()` is not called only from its own unit test, but
the one production caller is button enablement, so the rule holds for people who
use the screens and for nobody else. `src/app/actions.ts::approvePayable()` goes
straight to `ledger.post({kind:'approve'})` with no role argument at all.

The identity half, that the approver must be a different person from the
submitter, is implemented nowhere. `attempt()` takes a role and never sees a
user; its own doc comment says the identity check is "an identity check the
caller performs", and no caller performs it.

**Reproduction** (now `refuses a supplier at submit and at approve, as
core/lifecycle does`): create a payable, post `submit` as the `supplier`
user, then post `approve` as the same `supplier` user.

**Expected**: refusal. The PRD maker-checker rule requires an `adata_checker`,
and requires that checker to be a different person from the preparer who
submitted.

**Observed**: both commands are accepted. `lifecycle_status` is `approved`. The
`approved` journal entry's `actor_user_id` resolves to a user whose role is
`supplier`. In the same test, `attempt('pending_approval', 'approve',
'supplier')` returns `{ ok: false, reason: 'supplier may not approve a payable' }`,
so the two layers disagree and the database is the one that decides.

The 60-row table made the scope of this exact. Its outcome lookup,
`APPROVE_OUTCOME`, was keyed on the lifecycle state alone. Role and submitter
identity were enumerated across all 60 rows and appeared in no key, because they
changed nothing. All five roles and both identity settings produced the same
result for a given state: `ADA01 illegal lifecycle transition <from> -> approved`
off a bad edge, acceptance on a good one.

### What replaced it

`app.assert_edge_actor(payable, to_state, actor)` in `db/post.sql` looks up
`app.lifecycle_edge.actor_role` for the edge the command would take, reads the
actor's role, and refuses a mismatch with

```
ADA36 payable <ref> moves from <from> to <to> on the <required>, not the <actual>
```

It is called from all three places that move `lifecycle_status`: the
`submit`/`approve`/`certify` branch, `issue_payable`, and `settle_maturity`. So
the column is read on all five edges rather than on the one the brief named.
Where the pair is not an edge at all, including a same-state write, it returns
early and leaves the refusal to `app.enforce_lifecycle_edge`, which still
answers `ADA01`.

**The identity half needs no rule of its own.** `app.app_user.role` is written
once at INSERT and no command updates it, and `submit` and `approve` name
different roles, so the submitter of a payable can never be its approver. A
guard for it could not fire. Writing one would have added the kind of
unreachable branch findings 6 and 8 of this file already fault.

**`src/core/lifecycle.ts` disagreed and now does not.** Its `TRANSITIONS.issue`
allowed `adata_preparer`, `adata_checker` and `straitsx_admin`, and
`TRANSITIONS.settle` allowed two roles, against one in the edge table. Those
lists gate buttons, so the approvals screen would have drawn a control the
database then refused. Both are narrowed to the edge table, and
`tests/techniques/state-transitions.test.ts` now reads `app.lifecycle_edge` out
of the database and asserts the two agree, so the next edit cannot drift them
apart quietly.

**`src/app/adata/settlement/FundingPanel.tsx` had no role gate at all**, only a
funds check, so every persona could click Fund settlement. It now consults
`attempt()` the way the approvals screen does.
`src/core/next-action.ts::sourceSettlementDue` was a third copy, offering the
step to the checker as well, and now reads `pendingStep('matured').actors`.

**What the rule does not close.** `app.assert_edge_actor` returns early when the
pair is not an edge, and `approved -> approved` is not one, so finding 2 below
still stands and now has a sharper form: a wrong-role actor's `approve` on an
already-approved payable is accepted and writes an `approved` journal entry
under that actor. The audit trail can still show a supplier approving. Table 2
pins it as `approved | acting as supplier | a different user -> accepted`.

Table 2's shape moved with the rule. Its outcome is now keyed on lifecycle and,
at `pending_approval` only, on role, which mirrors the write path reading the
role only where an edge row exists. Twenty rows became infeasible: `submit` is
refused to every role but `adata_preparer` and a role never changes, so no other
role is ever a payable's submitter.

---

## 2. `approve` on an already-approved payable is a silent no-op that still writes an audit event

File: `db/schema.sql` line 337, `db/post.sql` lines 981 to 992.

`app.enforce_lifecycle_edge` returns early when `NEW.lifecycle_status =
OLD.lifecycle_status`, so an `approved -> approved` update passes the trigger
without needing an edge. The journal entry was already inserted at the
idempotency gate, before the branch runs.

**Reproduction** (`re-approves an approved payable as a silent no-op that still
writes an audit event`): build a payable to `approved`, post `approve` again
with a fresh idempotency key.

**Expected**: either `ADA01`, since `approved -> approved` is not an edge in
`app.lifecycle_edge`, or a replay that returns the original entry.

**Observed**: accepted. `lifecycle_status` stays `approved`, and
`ledger.journal_entry` now holds **two** entries of kind `approved` for that
payable. The audit trail says the payable was approved twice, by whoever posted
each one. The same shape applies to `submit` on `pending_approval` and `certify`
on `certified`.

---

## 3. `create_payable` with a client-supplied `payableId` always fails with a raw foreign key violation

File: `db/post.sql` lines 365 to 373 and 827 to 851, `db/schema.sql` line 476,
`src/db/post.ts` lines 28 to 36.

The `Intent` union offers `payableId?: string` on both `create_payable` shapes.
The idempotency gate inserts `payable_id = (v_intent->>'payableId')::uuid` into
`ledger.journal_entry` before the branch creates the payable row, and
`journal_entry_payable_id_fkey` is a plain immediate foreign key. The branch
does eventually `UPDATE ledger.journal_entry SET payable_id = v_payable.id`,
which is exactly the fixup the gate makes unnecessary for every other intent and
impossible for this one.

**Reproduction** (`is refused by a foreign key at the idempotency gate, with no
ADA code`): post `create_payable` with any `payableId`.

**Expected**: the payable is created with the supplied id, which is what
`COALESCE((v_intent->>'payableId')::uuid, gen_random_uuid())` in the insert is
written to support, and what every other id-accepting intent (`listingId`,
`bidId`) does successfully.

**Observed**: SQLSTATE `23503`, message `insert or update on table
"journal_entry" violates foreign key constraint
"journal_entry_payable_id_fkey"`. No ADA code, so `src/app/actions.ts` cannot
tell this apart from a genuine bug and the user sees a Postgres string. No
payable is created. The suite works around it by reading the id back by `ref`.
The same hazard exists for `seriesId`, which the gate also writes through.

---

## 4. Settlement never reads `receipt_status`, and a rejected payable redeems for free

**FIXED.** `settle_maturity` now refuses a payable whose receipt was rejected,
with `ADA37 payable <ref> was rejected by its supplier and has nobody to redeem
to`. The guard sits after the role check and before the anchor-wallet and funds
checks. Table 4's outcome is now keyed on all six conditions, and
`receipt_status` earns its place in that key.

The entry below is the state before that change.

File: `db/post.sql` lines 667 to 738.

Table 4 enumerates six conditions across 144 rows. Its outcome lookup,
`SETTLEMENT_OUTCOME`, is keyed on five of them. `receipt_status` is enumerated
on every row and is in no key, because `settle_maturity` never looks at it.
`pending`, `accepted` and `rejected` settle identically. The settlement guard
order is `fundingCode` (`ADA17`), already settled (`ADA16`), clock against
maturity (`ADA12`), anchor wallet (`ADA15`), anchor funds (`ADA20`).

The consequence is sharper than "one condition is ignored". `reject_receipt`
returns the whole quantity to the anchor's own wallet. At settlement the holder
loop then credits the anchor its own face in XUSD, and `ledger.payer_legs`
debits the anchor the same amount. `ledger.post_legs` sums legs per
`(account, asset)` before checking the balance, so the net delta is zero.

**Reproduction** (`settles a payable whose supplier rejected the receipt`):
issue a payable to a supplier, post `reject_receipt`, advance the clock to
maturity, post `settle_maturity`.

**Expected, on the PRD reading**: a rejected delivery is not an obligation the
anchor owes the supplier, so settlement should either refuse or be a different
act. At minimum the redemption should be visible as paying nobody.

**Observed**: accepted. `lifecycle_status` becomes `settled` while
`receipt_status` stays `rejected`, a combination no constraint forbids. The
anchor's XUSD balance is **identical** before and after, asserted literally in
the test. The obligation is retired, the token is burned back to
`system_unissued`, and no money moved.

This was also why the table marked `receipt rejected` with `anchor funds
insufficient` infeasible across 12 rows: with the anchor paying itself, the
shortfall branch could never fire however poor the anchor was.

That infeasibility is gone, because `ADA37` now answers those rows before the
funds check is reached. A different one replaced it: a rejected payable can no
longer reach `settled`, so every `already settled | receipt rejected` row is
infeasible. Table 4 moves from 60 feasible and 84 infeasible to 62 and 82.

The refusal leaves the payable at `issued` with its receipt `rejected`, which is
a combination no constraint forbids and which a person can still see. Writing
off a rejected delivery is a different act and there is no command for it. That
is a gap, not a defect this fix introduces.

---

## 5. A bid below `listing.min_price_base` is accepted and settles

**FIXED.** `place_bid` refuses a bid below the floor with `ADA38 a bid must be
at least <min>, the minimum this listing asks`, checked after the bidder's
eligibility. It is checked where a bid enters rather than at acceptance,
because the only two ways a bid is created are `place_bid` and `buy_now`, and
`buy_now` prices from `buy_now_price_base`, which the schema already holds at
or above the minimum. A second check at acceptance would be the unreachable
recheck finding 6 already faults.

An absent `priceBase` is caught by the same guard. It used to be NULL all the
way to a NOT NULL column.

Table 3a's `bid_below_min_price` gate is now infeasible for both verbs, since no
acceptance can ever see such a bid, and the floor has a boundary triple of its
own at 899,999 / 900,000 / 900,001 plus the absent case.

**The seed carried a bid below its own ask.** `db/seed.sql` priced the two
competing bids on TP-2026-0142 at 98.40% and 98.10% of face against a 98.40%
ask, describing them as "at a spread". The second was below the floor and the
seed refused to load once the rule was real. The spread now sits at and above
the ask, at 98.40% and 98.60%, which is where a competing bid belongs.

The entry below is the state before that change.

File: `db/post.sql` lines 581 to 665, `db/schema.sql` lines 369 to 391.

`min_price_base` is `NOT NULL` and `CHECK (min_price_base > 0)`, and the schema
comment calls the prices "the aggregate XUSD for the whole lot". The acceptance
branch never compares `v_bid.price_base` against it. Only `buy_now_price_base`
is constrained relative to it, and that constraint is in the schema, not in the
acceptance path.

**Reproduction** (gate row `accept_bid | bid_below_min_price`): publish a
listing with `minPriceBase` 900000, place a bid of `priceBase` 1, accept it.

**Expected**: a refusal naming the floor, or an explicit note that the floor is
advisory.

**Observed**: accepted. The listing becomes `filled`, the bid's recorded
`price_base` is `1`, and the buyer's free balance of the payable token is the
full face of 1000000 base units. The seller escrowed a lot advertised at 900000
base units, which is 90 XUSD, and was paid 1 base unit, which is 0.0001 XUSD.
The books stay `HEALTHY`, so no invariant catches it.

Whether this is a defect depends on whether `min_price_base` is a floor or a
hint. It is presented as a floor and enforced as neither.

---

## 6. The eligibility recheck at acceptance is dead code on the `accept_bid` path

File: `db/post.sql` lines 622 to 627, and the comment above it.

The comment says the recheck exists "because eligibility can be removed between
the two: the account that placed the bid may have been removed since". It
cannot be, and the suite proves each link of that.

`place_bid` refuses an ineligible bidder with `ADA34 only institutional lender
accounts can bid`. Every user of a lender entity has role `lender`, because
`create_user` and `onboard_entity` refuse any other role on a lender entity
(`ADA29`), and `institutional_eligible` is set to `v_role = 'lender'` at
creation. `remove_user` refuses to deactivate the last live account of an
organisation (`ADA30`). So a lender wallet has at least one live eligible user
for as long as it exists, and no placed bid can have an ineligible bidder.

**Reproduction** (`cannot hold a placed bid from an ineligible wallet, which is
why those rows are infeasible`): onboard a supplier, try to bid from its wallet,
observe `ADA34`. Onboard a lender, try to remove its only user, observe
`ADA30 that is the only account for <name>, which still holds a wallet`.

**Observed**: both refusals, as asserted literally. This makes 8 of table 3b's
32 rows infeasible: every `accept_bid` row where the buyer is not institutional.
The branch is reachable only through `buy_now`, which inserts its own bid from
`buyerWallet` before the check runs, and those 8 rows do pass and do produce
`ADA34 only institutional lender accounts can buy`.

The line is not wrong, it is unreachable on the path its comment describes.

---

## 7. `accept_bid` with an unknown `bidId` reports the buyer as ineligible

**FIXED** as part of the NULL-guard family. `accept_bid` answers
`ADA11 no such bid`, checked after the listing and before the bid status, the
self-trade check and the eligibility check that used to answer first. Seven
other sites shared the root cause and moved with it; see finding 4 of
`findings/model-based.md` for the list.

The entry below is the state before that change.


File: `db/post.sql` lines 608 to 627.

`SELECT * INTO v_bid FROM app.bid WHERE id = ...` leaves every field NULL when
no row matches. `v_bid.status <> 'placed'` is then NULL, which `IF` treats as
false, so the `bid is %` guard does not fire. `v_bid.bidder_wallet =
v_listing.seller_wallet` is NULL for the same reason, so the self-trade guard
does not fire. `ledger.wallet_is_institutional(NULL)` is false, so the next
guard does.

**Reproduction** (gate row `accept_bid | bid_missing`): publish a listing, post
`accept_bid` with a `bidId` that matches no row.

**Expected**: `ADA11` naming the missing bid, matching `no such listing` one
guard earlier.

**Observed**: `ADA34 only institutional lender accounts can buy`. The seller is
told their buyer is not an institution when the real problem is a bid id that
does not exist. `no such listing` has an explicit `IF v_listing.id IS NULL`
guard three lines above; the bid has none.

---

## 8. `ADA11 bid is superseded` is unreachable

File: `db/post.sql` lines 550, 664 to 665, 701, and 610 to 612.

Three commands set a bid to `superseded`: `cancel_listing`, the acceptance
branch, and `settle_maturity`. All three close the listing in the same command,
to `cancelled` or `filled`. The acceptance branch checks `v_listing.status <>
'open'` before it looks at the bid, so a superseded bid always reports its
listing's status instead.

**Reproduction** (`only supersedes a bid by closing its listing, which is why
that row is infeasible`): place a bid and cancel its listing; place two bids and
accept one. Read back each loser with its listing.

**Observed**: `{bid: 'superseded', listing: 'cancelled'}` and `{bid:
'superseded', listing: 'filled'}`, asserted literally. There is no state of the
world in which the `bid is superseded` message can be produced, so that row of
table 3a is marked infeasible for both verbs.

---

## 9. `create_user` on the platform can never succeed, and `ADA29` carries two meanings

File: `db/post.sql` lines 904 to 922, `db/schema.sql` line 121.

Table 5a is the full 20-row cross product of four entity types against five
roles. Five pairs pass the role gate. Four of them create a user. The fifth,
`platform` with `straitsx_admin`, passes the gate and is then refused by the
`one_straitsx_admin` partial unique index, because the fixture world already has
a live administrator. `remove_user` refuses to remove that administrator
(`ADA15 the StraitsX administrator cannot be removed`), so there is no sequence
of commands that frees the slot.

**Observed**: `platform | straitsx_admin` returns `ADA29 the platform already
has a StraitsX administrator`, not the role-gate message. The row is declared in
the table with that message, which is how the suite shows the gate was passed
and something later refused. Every other refusal in that table is
`ADA29 a <entity_type> cannot hold the <role> role`.

One SQLSTATE, two unrelated conditions, and a caller that wants to distinguish
"wrong role for this organisation" from "the admin slot is taken" has only the
message text to go on.

---

## 10. Two smaller message defects

**`remove_user` on an already-deactivated user is indistinguishable from an
unknown id.** `db/post.sql` line 958 selects with `AND deactivated_at IS NULL`,
so a deactivated user produces `ADA15 no such user`, byte-identical to a random
UUID. Table 6 rows `user deactivated | ordinary role | a live sibling` and
`user absent | ordinary role | no live sibling` assert the same code and the
same message. A caller cannot tell a retry from a typo.

**`ADA29` says "a anchor" and "a adata_preparer".** `db/post.sql` line 910
interpolates the entity type and role into `'a % cannot hold the % role'`. The
suite asserts the exact text, including `a anchor cannot hold the supplier role`
and `a supplier cannot hold the adata_preparer role`. This text reaches users.

---

## Behaviours confirmed rather than faulted

These were checked because a decision table has to pin the boundary, and each
behaved as `db/post.sql` documents.

- **The programme limit is an inclusive cap.** The comparison is `v_outstanding
  + face > limit`, so landing exactly on the limit issues. Table 1 covers
  `limit - 1`, `limit` and `limit + 1` against every certification status.
- **A NULL programme limit is uncapped and is not the same as zero.** The case
  `treats a limit of zero as a cap of zero and a NULL limit as uncapped` issues
  the same payable twice: at `limitBase` 0 it is refused with `ADA33`, and after
  `limitBase` null it is accepted. Table 1 additionally marks 24 rows infeasible
  because a NULL limit means the headroom comparison is never reached at all.
- **Guard precedence at issuance.** `ADA15` (not certified) beats `ADA32`
  (issuer not certified) beats `ADA33` (over limit). Table 1 proves the
  precedence rather than assuming it: 12 feasible rows put a draft payable under
  a suspended, over-limit issuer and still get `ADA15`.
- **Settlement on the maturity date is legal.** The guard is `clock <
  maturity_date`, so `on` succeeds and `before` gives `ADA12 payable <ref> has
  not matured`. Table 4 covers `before`, `on` and `after`.
- **Onboarding is restricted to suppliers and lenders**, and that check runs
  before the role gate, so `anchor` and `platform` always give `only a supplier
  or a lender can be onboarded here` whatever role is asked for. Table 5b, 10
  rows.
- **Blank names are refused before duplicates are considered.** Table 5c orders
  `ADA28 a user name is required`, then `ADA28 an organisation name is
  required`, then `ADA27`, and the duplicate check is case-insensitive:
  onboarding `chien yu precision` returns `an organisation called chien yu
  precision is already on the platform`.
- **Removing the last live account of an organisation is refused** with `ADA30`
  naming the organisation, which is what keeps its wallet reachable.

## A condition with no route through the command set

`settle_maturity` refuses with `ADA15 anchor for <ref> has no wallet`. No intent
creates an anchor entity (`onboard_entity` refuses anything but supplier and
lender), and no intent detaches a wallet. For every anchor the product can
produce, that branch is dead. Table 4 reaches it by inserting a wallet-less
anchor row directly and repointing one payable at it just before settlement,
which is called out in a comment in the suite. Flagged here so nobody reads that
coverage as evidence the branch is reachable in production.
