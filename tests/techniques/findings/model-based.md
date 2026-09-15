# Findings from `tests/techniques/model-based.test.ts`

Model-based testing of the payable workflow. An in-memory model of the world
predicts, for every generated command, whether `ledger.post()` will accept it,
which SQLSTATE it will refuse with, and what the observable state is afterwards.
fast-check generates command sequences without regard for legality, the same
sequence runs against the model and against a fresh Postgres database, and the
two are compared after every single step.

Nothing in `src/` or `db/` was changed. The suite is green: the model
reproduces each behaviour below exactly, because the model's job is to predict
what the system does, not what it ought to do. That is also why they would
otherwise be invisible, so each except the first is additionally recorded as an
`it.fails(...)` case in
`describe('behaviours the model reproduces but would not choose')`, stating what
a caller would reasonably expect. The day one of them is fixed,
that case starts passing and the suite reports it.

Reproduce everything with:

```
npx vitest run tests/techniques/model-based.test.ts
```

---

## The model

**State.** Six maps, seeded from one snapshot of the fixture world:

| field | what it holds |
| --- | --- |
| `day` | `app.world.offset_days` |
| `payables` | id to `{ref, face, maturity, status, graded, receipt, issuedTo}` |
| `listings` | id to `{payableId, seller, qty, minPrice, buyNow, status}` |
| `bids` | `{id, listingId, bidder, price, status}`, compared as a multiset |
| `balances` | `wallet\|purpose\|asset` to a `bigint` |
| `refs` / `invoices` | uniqueness sets for `create_payable` |

The model does not know about journal legs, entry kinds, chain receipts, lock
ordering or FX. Everything funded in the run is funded in **XUSD**, deliberately:
`ledger.payer_legs` applies `xsgd_per_xusd_e6` with a half-up divide for XSGD,
and reproducing that rounding would make the model a port of the thing it is
supposed to check. With XUSD the FX rate is exactly `1000000` and the payer's
debit is the price, so the model's arithmetic is addition only. The cost is that
the XSGD conversion path and the `system_fx` account are out of this suite's
scope; `tests/techniques/properties.test.ts` and the FX tests cover that.

**Legality.** `app.lifecycle_edge` is read out of the database at boot rather
than hardcoded, per the contract. Everything else is a `predict(model)` per
command returning either `legal` or a `{code, says}` pair, where `says` is the
exact user-facing sentence. Refusals are asserted on both: the SQLSTATE and the
message text, including the computed quantities in `ADA20` and `ADA21`
(`wallet 0x... holds 600000 unlisted, needs 900000`).

**Comparison.** After every command, accepted or refused, a single `jsonb`
snapshot of payable statuses, receipt statuses, listing statuses, bid multiset
and every non-zero wallet balance is compared against the model's rendering of
the same shape. `ledgerHealth` is asserted `HEALTHY` at the end of each
generated sequence.

**Command classes (18).** `create_payable` (manual shape, with flawed variants
for ADA19/22/23/24/25/26), `submit`, `approve`, `grade`, `certify`,
`issue_payable`, `accept_receipt`, `reject_receipt`, `top_up`, `transfer`,
`publish_listing`, `place_bid`, `withdraw_bid`, `accept_bid`, `buy_now`,
`cancel_listing`, `advance_clock`, `settle_maturity`.

**Generation.** `fc.commands` plus `fc.asyncModelRun`, 25 runs at seed
`20260915`, up to 600 commands per run, each run against its own database from
`freshDatabase(name, 'fixtures')`. `check(model)` is structural only, deciding
whether a command can be addressed at all (a `place_bid` needs some listing to
name); legality is decided inside `run` so that illegal commands really do fire.
Two commands in three aim at a subject that is ready for them and the third aims
blind, because walking a six-deep lifecycle by drawing blind never gets past
`approved`. The aim biases which sequences are generated, never which are judged
legal, and it is largely the blind third that makes 3,773 of the 6,121
commands refusals rather than acceptances.

---

## Coverage

Measured, not estimated, from the run at seed `20260915`. The suite prints this
and asserts it.

| measure | reached | of |
| --- | --- | --- |
| lifecycle states | **6** | 6 |
| command classes | **18** | 18 |
| (state, command) pairs | **75** | 75 reachable |
| commands executed | **6,121** | across 25 sequences |
| accepted / refused | 2,348 / 3,773 | |

Pair space is 7 subject states (`none` plus the six lifecycle states) by 18
commands, so 126 in total, of which **51 are unreachable by construction** and
are enumerated in `unreachablePairs()`. The suite asserts that none of them is
ever reached, so a wrong exclusion fails the run rather than inflating the score.

- 18 pairs: `create_payable`, `top_up` and `advance_clock` name no payable, so
  the six lifecycle states are impossible for them.
- 10 pairs: `submit`, `approve`, `grade`, `certify`, `issue_payable`,
  `accept_receipt`, `reject_receipt`, `transfer`, `publish_listing` and
  `settle_maturity` all name a payable that already exists, so `none` is
  impossible.
- 20 pairs: a listing escrows a payable token, and that token is created at
  issuance, so no listing or bid can name a payable in `draft`,
  `pending_approval`, `approved` or `certified`. That rules out those four
  states for `place_bid`, `withdraw_bid`, `accept_bid`, `buy_now` and
  `cancel_listing`.
- 3 pairs: `place_bid`, `accept_bid` and `buy_now` cannot be generated at all
  until their referent exists, so unlike `cancel_listing` and `withdraw_bid`
  they have no "names nothing" form and cannot pair with `none`.

Refusal codes reached, asserted as an exact set:
`23502 23505 23514 ADA01 ADA11 ADA12 ADA15 ADA16 ADA17 ADA19 ADA20 ADA21 ADA22
ADA23 ADA24 ADA25 ADA26 ADA34`.

**Not reached: `ADA33`,** the programme limit. The fixture anchor's
`programme_limit_base` is 250,000,000,000 and generated faces are 1,000,000 or
2,500,000, so 25 sequences cannot come within three orders of magnitude of the
limit. The model predicts `ADA33` and the branch is written, but raising the
generated face enough to trip it would swamp every other command with a single
refusal, so the limit is left to a suite that targets it directly. `ADA02`
through `ADA06` are deferred-constraint and projection failures that a correct
`ledger.post()` cannot produce from the write surface, and are likewise out of
scope here.

---

## 1. `create_payable` cannot carry a caller-supplied `payableId`

**File:** `db/post.sql`, the idempotency gate, against the `create_payable`
branch.

**Reproduction:**

```ts
await post(pool, { kind: 'create_payable', payableId: '00000000-0000-4000-9000-000000000001',
                   ref: 'PB-1', supplierId, invoiceRef: 'IR-1', faceBase: 1_000_000, termsDays: 90 });
// { ok: false, code: '23503',
//   message: 'insert or update on table "journal_entry" violates foreign key
//             constraint "journal_entry_payable_id_fkey"' }
```

**Expected:** either the id is honoured, as `listingId` and `bidId` are on
`publish_listing` and `place_bid`, or the parameter is rejected with a named
code.

**Observed:** step 1 inserts the journal entry with
`payable_id = (v_intent->>'payableId')::uuid` before step 5 creates the payable,
so the foreign key fires first. The `COALESCE((v_intent->>'payableId')::uuid,
gen_random_uuid())` in the `INSERT INTO app.payable` is therefore unreachable
dead code: no command that reaches it can have supplied a `payableId`.

**Consequence for this suite:** the model cannot mint payable ids the way it
mints listing and bid ids. It creates the payable and reads the id back by
`ref`, which is why `CreatePayable.apply` is the one asynchronous `apply`.

---

## 2. A receipt decision before issuance raises a raw check-constraint violation

**File:** `db/post.sql`, the `accept_receipt` / `reject_receipt` branch.

**Suite cases:** `names the payable when a receipt is accepted before issuance`,
`names the payable when a receipt is rejected before issuance`.

**Reproduction:** create a payable, leave it in `draft`, then

```ts
await post(pool, { kind: 'accept_receipt', payableId });
// { ok: false, code: '23514',
//   message: 'new row for relation "payable" violates check constraint
//             "receipt_only_once_issued"' }
```

**Expected:** `ADA15` with the sentence the branch already owns, the way
`issue_payable` says `payable PB-1 is approved and must be certified before
issuance`.

**Observed:** the guard is

```sql
IF v_payable.receipt_status <> 'pending' THEN
  RAISE EXCEPTION 'payable % was already %', ... USING ERRCODE = 'ADA15';
END IF;
```

A payable that was never issued has `receipt_status IS NULL`, so the comparison
evaluates to NULL, `IF NULL THEN` is not taken, and control falls past the guard
that exists precisely to stop this. The `UPDATE app.payable SET receipt_status =
'accepted'` then breaks `receipt_only_once_issued`, and the caller gets a
constraint name instead of a sentence. Both branches are affected; `reject_receipt`
additionally reaches `ledger.payable_asset()`, which returns NULL, before the
same CHECK stops it. The fix is `IS DISTINCT FROM` plus a null case, but that is
production code and was not touched.

---

## 3. `transfer` and `publish_listing` on a never-issued payable surface NOT NULL violations

**File:** `db/post.sql`, the `transfer` and `publish_listing` branches.

**Suite case:** `refuses a transfer of a payable that was never issued`.

**Reproduction:** with a payable in `draft` and the clock before its maturity,

```ts
await post(pool, { kind: 'transfer', payableId, fromWallet, toWallet, quantityBase: 1 });
// { ok: false, code: '23502',
//   message: 'null value in column "asset_id" of relation "account_balance"
//             violates not-null constraint' }

await post(pool, { kind: 'publish_listing', listingId, payableId, sellerWallet,
                   quantityBase: 1, minPriceBase: 100, buyNowPriceBase: 200 });
// { ok: false, code: '23502',
//   message: 'null value in column "asset_id" of relation "listing_leg"
//             violates not-null constraint' }
```

**Expected:** `ADA15`, naming the payable and its state, as `issue_payable`
does.

**Observed:** both branches call `ledger.payable_asset(v_payable.id)`, which
returns NULL when no token exists yet, and neither checks it. Both then check
maturity and receipt state, neither of which fires for a draft
(`receipt_status IS NULL`, see finding 2), and the NULL asset reaches the legs.
`publish_listing` gets one step further and inserts the `app.listing` row before
`app.listing_leg` refuses it; the whole statement rolls back, so no orphan
listing survives, but the ordering means a malformed command briefly creates
market state.

---

## 4. `cancel_listing` and `withdraw_bid` accept ids that match nothing

**File:** `db/post.sql`, the `cancel_listing` and `withdraw_bid` branches.

**Suite case:** `refuses a cancellation of a listing that does not exist`.

**Reproduction:**

```ts
await post(pool, { kind: 'cancel_listing', listingId: '00000000-0000-4000-f000-00000000abcd' });
// { ok: true, ... }
await post(pool, { kind: 'withdraw_bid', bidId: '00000000-0000-4000-f000-00000000abce' });
// { ok: true, ... }
```

Both write a journal entry. After the two calls above the journal carries a
`listing_cancelled` and a `bid_withdrawn` entry with zero legs, attributed to the
actor, referring to nothing.

**Expected:** `ADA11`, which `accept_bid` already raises for exactly this case
(`IF v_listing.id IS NULL THEN RAISE EXCEPTION 'no such listing'`).

**Observed:** `withdraw_bid` is a bare `UPDATE app.bid SET status = 'withdrawn'
WHERE id = ... AND status = 'placed'`, which matches zero rows and reports
nothing. `cancel_listing` reads the row into `v_listing`, then tests
`IF v_listing.status <> 'open'`, which is NULL for a row that was not found, so
the guard is not taken and the branch proceeds to update nothing. The
`withdraw_bid` case is a known quirk; the `cancel_listing` case appears to be the
same NULL-comparison mistake as finding 2 and is not documented anywhere.

The audit consequence is the more interesting half. PRD section 10 makes the
journal the audit trail, and these two commands let any actor write entries into
it that describe events that did not happen.

---

## 5. `place_bid` on a listing that does not exist raises NOT NULL, not `ADA11`

**File:** `db/post.sql`, the `place_bid` branch.

**Suite case:** `refuses a bid on a listing that does not exist`.

**Reproduction:**

```ts
await post(pool, { kind: 'place_bid', bidId, listingId: '00000000-0000-4000-f000-00000000abcd',
                   bidderWallet: institutionalWallet, priceBase: 100, fundingCode: 'XUSD' });
// { ok: false, code: '23502',
//   message: 'null value in column "listing_id" of relation "bid"
//             violates not-null constraint' }
```

**Expected:** `ADA11` and `no such listing`, matching `accept_bid`.

**Observed:** the same NULL comparison as finding 4 (`IF v_listing.status <>
'open'`), after which `INSERT INTO app.bid (listing_id, ...) VALUES
(v_listing.id, ...)` inserts a NULL. The header comment of `post.sql` explains at
length why the listing must be locked by primary key and the status read off the
locked row; three of the four branches that do so then forget that a row which
was not found has a NULL status. `accept_bid` is the only one that checks.

---

## 6. `accept_bid` on a bid that does not exist blames the bidder

**File:** `db/post.sql`, the `accept_bid` branch.

**Suite case:** `says which bid is missing rather than blaming the bidder`.

**Reproduction:** against a real, open listing,

```ts
await post(pool, { kind: 'accept_bid', listingId, bidId: '00000000-0000-4000-f000-0000000000dd' });
// { ok: false, code: 'ADA34', message: 'only institutional lender accounts can buy' }
```

**Expected:** something naming the bid. `ADA11` would match the listing case.

**Observed:** `SELECT * INTO v_bid` finds nothing; `IF v_bid.status <> 'placed'`
is NULL and not taken; `IF v_bid.bidder_wallet = v_listing.seller_wallet` is NULL
and not taken; and `ledger.wallet_is_institutional(NULL)` is false, so the first
guard that actually fires is the eligibility one. The seller is told that the
bidder is not an institution, when there is no bidder. This is the fourth
instance of the same NULL-versus-not-found pattern and the one with the most
misleading message.

---

## 7. A seller's second open listing for the same payable raises a raw unique violation

**File:** `db/schema.sql`, `one_open_listing_per_seller_target`, against
`db/post.sql`'s `publish_listing`.

**Suite case:** `refuses a second open listing with a named code rather than a raw index error`.

**Reproduction:** publish a listing, then publish another for the same payable
from the same wallet while the first is still open:

```ts
// { ok: false, code: '23505',
//   message: 'duplicate key value violates unique constraint
//             "one_open_listing_per_seller_target"' }
```

**Expected:** an `ADA` code and the sentence PRD section 9 already supplies:
"a wallet may have only one active listing per payable or Series".

**Observed:** the partial unique index is the only enforcement, and
`publish_listing` has no `EXCEPTION WHEN unique_violation` handler, unlike
`create_payable`, which catches its two unique violations and turns them into
`ADA22` and `ADA26` with a comment explaining that saying which index was hit is
"the difference between a preparer fixing a typo and a preparer wondering what
the system means". The same argument applies here and the handler is absent.
The index itself is correct and is the right mechanism; only the message is
missing.

---

## 8. Issuing after the clock has passed the draft's maturity raises a raw check violation

**File:** `db/schema.sql`, `maturity_after_issue`, against `db/post.sql`'s
`issue_payable`.

**Suite case:** `names maturity when a draft is issued after its own maturity date`.

**Reproduction:** create a payable on 30-day terms, advance the clock 40 days,
then take it through to `certified` and issue it:

```ts
await post(pool, { kind: 'issue_payable', payableId, toWallet, tokenId: 1 });
// { ok: false, code: '23514',
//   message: 'new row for relation "payable" violates check constraint
//             "maturity_after_issue"' }
```

**Expected:** `ADA12` and `payable PB-1 has reached maturity`, which is what
`transfer` and `publish_listing` say in the same situation.

**Observed:** `issue_payable` checks issuer certification and the programme
limit, both with good messages, and does not check the clock at all. The
`create_payable` branch already anticipates this: its comment on the terms check
says the schema's `maturity_after_issue` "cannot help here: a draft has no issue
date yet, so a zero-day term would pass it and only fail much later, at issuance,
with a confusing message". That is exactly what happens, by a different route,
whenever the demo clock is advanced past a draft's maturity before it is issued.
This is reachable from the screens: the world clock is a presenter control and
drafts sit in the approval queue.

---

## 9. `min_price_base` is stored, displayed and never enforced

**File:** `db/post.sql`, the `place_bid` and `accept_bid` branches.

**Suite case:** `refuses a bid below the minimum price the seller published`.

**Reproduction:** publish a listing with `minPriceBase: 100`, then

```ts
await post(pool, { kind: 'place_bid', bidId, listingId, bidderWallet, priceBase: 1,
                   fundingCode: 'XUSD' });
// { ok: true, ... }
```

and the bid can then be accepted at 1 base unit, or superseded by any other.

**Expected:** PRD section 8 screen 7 has the seller "enter a minimum XUSD
price", and `app.listing.min_price_base` is `NOT NULL` with a
`min_price_base > 0` check, so it is a floor rather than a hint. A bid below it
should be refused.

**Observed:** nothing reads `min_price_base` outside the `CHECK` that relates it
to `buy_now_price_base`. `place_bid` validates only that the listing is open and
the bidder institutional. This is not a ledger-integrity problem, which is why
the books stay `HEALTHY`, but it is the one rule on the listing that the
database does not keep, in a file whose header argues that "a rule that only the
UI knows is not a rule".

---

## 10. Commands that change nothing are accepted and recorded

**File:** `db/schema.sql`, `app.enforce_lifecycle_edge`, and `db/post.sql`'s
`transfer` branch.

Two shapes, both harmless to the books and both noisy in the audit trail.

**Lifecycle self-edges.** `submit` on a payable already in `pending_approval`,
`approve` on one already `approved`, and `certify` on one already `certified` all
succeed:

```ts
await post(pool, { kind: 'submit', payableId });   // draft -> pending_approval, ok
await post(pool, { kind: 'submit', payableId });   // ok, and nothing changed
```

The trigger's first line is `IF NEW.lifecycle_status = OLD.lifecycle_status THEN
RETURN NEW`, so the edge table is never consulted and the `UPDATE` writes the
row back unchanged. A `submitted_for_approval` entry is appended each time. The
early return is needed, because the `grade` verb shares this branch and must be
able to update a payable without moving it, but the effect is that the approval
queue can be told the same thing repeatedly and the journal records each telling
as an event.

**Self-transfers.** `fromWallet` equal to `toWallet` is accepted. Suite case:
`does not stamp a confirmed transaction hash on a transfer that moved nothing`.

```ts
await post(pool, { kind: 'transfer', payableId, fromWallet: w, toWallet: w, quantityBase: 5_000 });
// { ok: true, receipt: { kind: 'transfer', legs: [], receipt: { txHash: '0x...', status: 'confirmed' } } }
```

`ledger.post_legs` groups the two legs by `(account, asset)` and filters
`HAVING SUM(amount) <> 0`, so nothing is inserted. The entry is still of kind
`transfer`, so step 7 stamps it `chain_status = 'confirmed'` with a transaction
hash derived from the idempotency key. The result is a confirmed on-chain
transfer with zero legs, which the explorer of PRD section 10 will render as a
settled movement of nothing. Verified directly: the entry has `legs = 0`,
`chain_status = 'confirmed'` and a non-null `chain_tx_hash`.

---

## Two things the model checked and found correct

Recorded because they are the parts most likely to be wrong, and the property
running green over 6,121 commands is the evidence that they are not.

**Redemption nets escrow correctly.** `settle_maturity` cancels every open
listing holding the payable and then sums each holder's position, but it reads
`ledger.account_balance` *before* the unlisting legs are posted, so a wallet with
a quantity still in `wallet_listed` is counted at its combined free-plus-listed
balance while `wallet_free` still holds only the free part. The two leg sets are
summed per `(account, asset)` in `ledger.post_legs`, and the arithmetic works
out to exactly zero on `wallet_free`, zero on `wallet_listed`, and a credit of
the full position in XUSD. It reads like an ordering bug and is not one. The
model predicts the final balances independently and they agree in every run that
settled a payable with an open listing against it.

**Escrow makes `closed_by_transfer` unreachable, correctly.** PRD section 9 and
the `escrow_matches_open_listings` comment both describe a transfer that drops a
holding below the listed quantity closing the listing and expiring its bids.
Because listed quantity lives in a separate `wallet_listed` account, `transfer`
debits `wallet_free` only and cannot reduce a holding below what is escrowed; the
non-negative CHECK refuses it as `ADA21` first. The cascade therefore never needs
to run, and the `closed_by_transfer` member of `app.listing_status` is dead by
construction. That is the design working, not a gap, but it does mean one enum
value is unreachable and the model never produces it.
