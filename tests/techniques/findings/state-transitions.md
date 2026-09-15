# Findings: state-transition testing

Suite: `tests/techniques/state-transitions.test.ts`
Technique: complete transition-matrix coverage for the payment and account
lifecycles. Five machines, 109 asserted cells, one database per machine.

Nothing in `src/` or `db/` was changed. Every item below is reproduced by a
case that is in the suite and green, either as a positive assertion of the
behaviour as it is, or as an `it.fails` case that asserts the behaviour a
correct system would have and is therefore recorded as an expected failure.

## Matrix summary

| Machine | Matrix | Cells | Accepted | Refused |
| --- | --- | --- | --- | --- |
| 1 obligation lifecycle | 6 x 6 state pairs, off-diagonal | 30 | 5 | 25 (all `ADA01`) |
| 1 obligation lifecycle | 6 diagonal same-state writes | 6 | 6 | 0 |
| 1 obligation lifecycle | 6 states x 5 commands | 30 | 8 | 22 (16 `ADA01`, 5 `ADA15`, 1 `ADA16`) |
| 2 `app.listing_status` | 4 statuses x 4 commands | 16 | 4 | 12 (all `ADA11`) |
| 3 `app.bid_status` | 5 states x 2 commands | 10 | 6 | 4 (3 `ADA11`, 1 `ADA34`) |
| 4 `receipt_status` | 4 states x 2 commands | 8 | 2 | 6 (4 `ADA15`, 2 `23514`) |
| 5 `certification_status` | 3 x 3 state pairs | 9 | 9 | 0 |

Machine 3's fifth state is `absent`, a bid id with no row. Four of its six
accepted cells are silent no-ops, which is finding 1.

## Which guard wins where two could fire

Postgres runs `BEFORE ROW` triggers before it evaluates row `CHECK`
constraints, and `ledger.post()` runs its own pre-checks before either. That
fixes the precedence, and the matrix confirms it cell by cell.

| Situation | Guard that fires | Cells |
| --- | --- | --- |
| Illegal edge, any companion column state | trigger `payable_lifecycle_edge`, `ADA01` | 25 of matrix 1, 16 of matrix 3 |
| Legal edge `approved -> certified`, `grade IS NULL` | CHECK `graded_before_certified`, `23514` | `certify` with no grade |
| `issue_payable` from any state but `certified` | in-command pre-check, `ADA15` | 5 |
| `settle_maturity` on a settled payable | in-command pre-check, `ADA16` | 1 |
| `settle_maturity` before maturity | in-command pre-check, `ADA12` | beats `ADA01`, tested separately |
| `settle_maturity` with no `fundingCode` | in-command pre-check, `ADA17` | beats every state guard |
| Non-open listing, any market command | in-command pre-check, `ADA11` | 12 |
| Non-placed bid on an open listing | in-command pre-check, `ADA11` | 3 |
| Non-pending receipt | in-command pre-check, `ADA15` | 4 |
| `NULL` receipt before issuance | CHECK `receipt_only_once_issued`, `23514` | 2, and see finding 3 |

Two orderings are worth naming because they hide a friendlier message:

- `settle_maturity` checks `fundingCode`, then `settled`, then maturity, and
  only then attempts the write the trigger vets. On an unmatured payable the
  caller sees `ADA12 payable X has not matured` rather than `ADA01`, which is
  the better message. On a matured `draft` payable they see the raw
  `ADA01 illegal lifecycle transition draft -> settled` rather than anything
  about the payable never having been issued.
- `accept_bid` checks the listing before the bid. A bid reaches `accepted` or
  `superseded` only through a transition that simultaneously takes its listing
  out of `open`, so through commands alone the `ADA11 bid is %` message is
  reachable for `withdrawn` and for nothing else. The suite writes the other
  two bid statuses directly to put that guard under test at all.

## 1. `withdraw_bid` has no row check, so it succeeds against anything

File: `db/post.sql:577-579`

```sql
ELSIF v_kind = 'withdraw_bid' THEN
  UPDATE app.bid SET status = 'withdrawn'
   WHERE id = (v_intent->>'bidId')::uuid AND status = 'placed';
```

The `UPDATE` matches zero rows and nothing looks at `FOUND`, so every
`withdraw_bid` command reports success.

Reproduction: `machine 3: app.bid_status > covers the full bid status by
command matrix against an open listing`, cells `accepted/withdraw_bid`,
`withdrawn/withdraw_bid`, `superseded/withdraw_bid` and
`absent/withdraw_bid`; and `journals a bid_withdrawn entry even when no bid
row was touched`.

Expected: a bid that is not `placed`, or that does not exist, is refused with
`ADA11` the way `accept_bid` refuses one.
Observed: all four succeed. The bid's status is unchanged, and a
`bid_withdrawn` journal entry is written every time with `bid_id` NULL and no
legs. A lender who withdraws a bid the seller has just accepted is told the
withdrawal worked while the trade stands, and the audit trail gains an entry
for an event that did not happen.

`it.fails` cases: `should refuse withdraw_bid for a bid id that does not
exist`, `should refuse withdraw_bid for a bid that has already been accepted`.

## 2. `accept_bid` on an unknown bid id is refused for the wrong reason

File: `db/post.sql:609-612`

```sql
SELECT * INTO v_bid FROM app.bid WHERE id = (v_intent->>'bidId')::uuid FOR UPDATE;
IF v_bid.status <> 'placed' THEN
  RAISE EXCEPTION 'bid is %', v_bid.status USING ERRCODE = 'ADA11';
END IF;
```

`SELECT INTO` leaves the record all-NULL when nothing matches, and
`NULL <> 'placed'` is NULL, not true, so the guard does not fire. Execution
falls through the seller-is-not-the-buyer check (also NULL) into
`ledger.wallet_is_institutional(NULL)`, which is the first predicate that
returns a definite false.

Reproduction: `machine 3 > covers the full bid status by command matrix`, cell
`absent/accept_bid`.

Expected: `ADA11` naming the missing bid.
Observed: `ADA34 only institutional lender accounts can buy`. The seller is
told their counterparty is not an eligible institution when in fact the bid id
does not exist. Nothing is corrupted, and `ledgerHealth` stays `HEALTHY`, but
the message sends the operator to the wrong screen.

`it.fails` case: `should refuse accept_bid for a bid id that does not exist`.

## 3. The receipt guard is skipped before issuance, for the same NULL reason

File: `db/post.sql:747-752`

```sql
SELECT * INTO v_payable FROM app.payable WHERE id = (v_intent->>'payableId')::uuid FOR NO KEY UPDATE;
IF v_payable.receipt_status <> 'pending' THEN
  RAISE EXCEPTION 'payable % was already %', v_payable.ref, v_payable.receipt_status
    USING ERRCODE = 'ADA15';
END IF;
```

Before issuance `receipt_status` is NULL by design, so the comparison is NULL
and the branch proceeds to write `receipt_status = 'accepted'` onto a payable
that is still `certified`.

Reproduction: `machine 4: app.payable.receipt_status > covers the full receipt
status by command matrix`, cells `null/accept_receipt` and
`null/reject_receipt`.

Expected: `ADA15`, or a message saying the payable has not been issued.
Observed: SQLSTATE `23514`, `new row for relation "payable" violates check
constraint "receipt_only_once_issued"`. The CHECK is doing the refusing, which
is why no bad row lands, but the user-facing text is a constraint name. The
same call on an already-decided receipt gives the intended
`ADA15 payable X was already accepted`, so the two failure modes of one command
read completely differently.

`it.fails` case: `should refuse accept_receipt before issuance with the ADA15
it has for the purpose`.

## 4. `closed_by_transfer` is a dead enum member

File: `db/schema.sql:357-362`, and PRD section 9 line 241.

The member exists, the PRD rule it encodes exists, and no code path writes it.
The four writers of `app.listing.status` are `publish_listing` (`open`),
`cancel_listing` (`cancelled`), `accept_bid` and `buy_now` (`filled`), and
`settle_maturity` (`cancelled`).

Reproduction: `machine 2: app.listing_status > never writes closed_by_transfer
from any command path` exercises all four writers and asserts the set of
statuses they produce is exactly `{open, filled, cancelled}` while the member
is still in the enum.

This one is dead by construction rather than by omission, and the suite records
why. PRD section 9 says "A transfer that would reduce the holding below the
listed quantity must close the listing and expire its bids as part of the
transfer." Escrow is a real account (`wallet_listed`), so the listed quantity
has already left the free balance and a transfer cannot undercut it: the
attempt is refused by `ADA21` before any cascade would be needed. See `machine
2 > cannot reach the transfer cascade closed_by_transfer was named for`, which
lists 600000 of a 1000000 holding and then fails a 500000 transfer with
`ADA21 wallet 0x... holds 400000 unlisted, needs 500000`, and succeeds at
400000 with the listing still `open`.

The enum member and its comment therefore promise a status that the UI can
never render and that no reader can reach. It is the enum, not the escrow
design, that is wrong.

## 5. `app.lifecycle_edge.actor_role` is a dead column

File: `db/schema.sql:320-334` defines the column and populates it with a role
per edge. `app.enforce_lifecycle_edge()` at `db/schema.sql:335-344` selects on
`(from_state, to_state)` only.

Reproduction: `machine 1 > accepts every legal edge from an actor holding the
wrong role` drives the whole chain, `submit` through `settle_maturity`, as a
supplier user. All five edges are accepted.

`tests/support/CONTRACT.md` already states that role and identity rules are not
enforced in the database, so this is consistent with the design rather than a
regression. It is recorded because the column reads as a rule: a contributor
adding a sixth edge will fill in an `actor_role` believing it constrains
something.

## 6. `set_certification` has no ordering at all

File: `db/post.sql:945-952`. The only guard is `ADA19` on a value outside the
enum. Every one of the nine ordered pairs, diagonal included, is permitted.

Reproduction: `machine 5: app.certification_status > permits every cell of the
three by three matrix, diagonal included`, and `suspends issuance and restores
it in one unreviewed step`.

The consequence is asserted directly: suspending the anchor turns
`issue_payable` into `ADA32 ADATA Technology Co., Ltd. is suspended and cannot
issue under this programme`, and one `set_certification` back to `certified`
makes the very next issuance succeed. There is no intermediate state, no second
approver, and no record of review beyond the journal entry that the change
happened. Compared with the obligation lifecycle, which spends an entire table
and a trigger on five edges, the issuer machine that gates every issuance has
no machine at all.

## 7. `create_payable` cannot accept a caller-supplied `payableId`

File: `db/post.sql:367-372` inserts the idempotency row with
`payable_id = (v_intent->>'payableId')::uuid` before any branch runs;
`db/post.sql:826-836` then inserts the payable with
`COALESCE((v_intent->>'payableId')::uuid, gen_random_uuid())`.

Reproduction: post `{kind: 'create_payable', payableId: <any uuid>, ...}`.
Every other command in this suite is addressed by id, so the suite hit this
while building fixtures and now creates drafts without an id and reads the id
back by `ref` (see the comment in `createDraft`).

Expected: the command honours the id it explicitly COALESCEs, the way
`publish_listing` honours `listingId` and `place_bid` honours `bidId`.
Observed: `23503 insert or update on table "journal_entry" violates foreign key
constraint "journal_entry_payable_id_fkey"`. The gate points the journal at a
payable that the same call has not created yet. The `COALESCE` is unreachable
for any value but NULL.

Not asserted as a test case, since it is an idempotency-and-references concern
rather than a state transition, and another suite may own it. Recorded here
because it constrains how any suite can drive this machine.

## 8. A second open listing leaks a raw `23505`

File: `db/schema.sql:394-398` (`one_open_listing_per_seller_target`). The
comment says a concurrent second publish should get "a unique violation rather
than winning a race", which it does, but unlike `create_payable`, which catches
`unique_violation` and re-raises `ADA22` or `ADA26` with a sentence a preparer
can act on, `publish_listing` has no handler.

Reproduction: `machine 2 > refuses a second open listing for the same seller
and target with a bare unique violation`.

Expected: an `ADA` code and a message such as "this payable is already listed".
Observed: `23505 duplicate key value violates unique constraint
"one_open_listing_per_seller_target"`. The invariant holds; only the message
reaches the user in the wrong shape.

## 9. The receipt machine has no edge table and no trigger

Unlike `lifecycle_status`, `receipt_status` is guarded only by the in-command
`ADA15` and by `receipt_only_once_issued`, which constrains nullability against
the lifecycle and nothing else. A direct write can therefore walk the receipt
backwards from `accepted` to `pending`.

Reproduction: `machine 4 > has no edge table of its own, so a direct write may
walk the receipt backwards`.

No command does this, so it is an asymmetry rather than a live defect, and it
is recorded so that the contrast with machine 1 is deliberate rather than
accidental. It is also what makes findings 3's CHECK the only backstop: there
is no trigger behind it.

## What held

Worth stating, because a matrix that only produces findings is usually testing
the wrong thing.

- All 25 illegal lifecycle edges are refused with `ADA01` and the message names
  both states, whatever companion columns the row carries. The `BEFORE` trigger
  fires ahead of every row CHECK, so an illegal edge never degrades into a
  constraint-name error.
- The trigger's short-circuit is real: all six diagonal cells are free, and an
  `UPDATE` that never mentions `lifecycle_status` passes through untouched.
- All 12 non-open listing cells refuse with `ADA11` and name the status, and
  none of them moves the listing.
- Accepting one bid marks exactly that bid `accepted`, supersedes every other
  `placed` bid on the listing, and fills the listing, in one operation.
  `cancel_listing` and `settle_maturity` supersede placed bids and leave an
  already-withdrawn bid withdrawn.
- `ledgerHealth` equals `HEALTHY` at the end of every one of the 38 scenarios,
  including the ones that force a status directly and the ones that leave a
  refused command behind.
