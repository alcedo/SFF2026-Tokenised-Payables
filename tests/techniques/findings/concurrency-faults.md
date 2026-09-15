# Concurrency and fault injection

Suite: `tests/techniques/concurrency-faults.test.ts`. Run it with
`npx vitest run tests/techniques/concurrency-faults.test.ts`.

Twenty scenarios, each on its own cloned database. Nothing in `src/` or `db/`
was changed for any of them. Every scenario ends by asserting
`ledgerHealth(pool)` equals `HEALTHY`, and every one of them did, including the
four below that record defects.

Orderings are made deterministic rather than timed. One client takes a lock,
the second is observed parked on it through `pg_stat_activity` and
`pg_blocking_pids`, and only then is the first released. Where a genuine race
is the point, N clients go through `Promise.all` and the assertion is the
invariant rather than the winner.

---

## 1. ABBA deadlock between `settle_maturity` and `accept_bid`

**FIXED.** `accept_bid` takes the instrument before the listing, which is the
order the file's own header states. What replaced it is at the end of this
entry.

**High severity. A real deadlock on the settlement path.**

`db/post.sql` states its own contract at lines 7 to 13: "The order of business
inside post() is fixed and is the only lock ordering in the system: ... lock in
a total order (payable, series, listing, then balance rows)." Two branches take
that order in opposite directions.

| branch | first lock | second lock |
| --- | --- | --- |
| `settle_maturity` | `app.payable` `FOR NO KEY UPDATE` (line 676) | `app.listing` `FOR UPDATE` (line 698) |
| `accept_bid` / `buy_now` | `app.listing` `FOR UPDATE` (line 589) | `app.payable` `FOR NO KEY UPDATE` (line 636) |

`accept_bid` also takes `app.bid FOR UPDATE` (line 609) between the two, and the
series variant substitutes `app.series FOR NO KEY UPDATE` (line 631), but the
inversion is the same either way.

**Reproduction.** Tests `deadlocks ABBA, names one victim with 40P01, and
settles the other side` and `refuses the acceptance with ADA12 when the deadlock
victim is the settlement`. One payable, escrowed in one open listing, with one
live bid, clock advanced past maturity. Session S is given the `app.payable` row
lock by hand, session A is given the `app.listing` row lock by hand, then both
post their commands. Neither can proceed. Postgres picks the victim by whichever
backend's `deadlock_timeout` expires first, so the tests set it explicitly on one
side and cover both assignments.

**Observed.**

- Victim `accept_bid`: SQLSTATE `40P01`, `deadlock detected`. `settle_maturity`
  completes, the payable reaches `settled`, the listing is `cancelled`, the bid
  is `superseded`, the supplier is credited the face in XUSD, books `HEALTHY`.
- Victim `settle_maturity`: SQLSTATE `40P01`. The survivor then finishes its own
  lock order and meets the maturity check it was queued ahead of, so
  `accept_bid` fails with `ADA12`, `payable ... has reached maturity`. Nothing
  moved, escrow intact, books `HEALTHY`.

**Expected.** No deadlock. The file says the lock order is total, and the whole
point of `post_legs` sorting its balance rows (lines 121 to 122: "A total order
over the only rows two operations contend for is what makes deadlock
impossible") is defeated by the app-table locks taken before it.

**Impact.** Both sides of this are ordinary product actions: an operator
redeeming a matured payable while a seller accepts a bid on the same payable.
`40P01` is not an `ADA` code, so the message that reaches the caller is
`deadlock detected`, with no user-facing sentence behind it. The books stay
balanced, which is the thing that matters most, but one of the two operators
sees a failure the UI has no wording for.

**What was done.** The first shape, unchanged from the sketch above.
`accept_bid` reads the listing's target without a lock, locks `app.payable` or
`app.series`, then locks `app.listing` by primary key and reads its status off
the locked row. The unlocked read decides nothing: a listing's target is set at
INSERT and no command changes it, so it is only used to learn which instrument
to lock, and the EvalPlanQual discipline the header warns about at lines 21 to
27 is untouched. The maturity check further down uses the row already locked
rather than locking it a second time.

**Evidence.** Three sessions. One holds the `app.payable` row and nothing else.
Both commands park on it:

```
settler blocked by   : [8989]
accepter blocked by  : [8989]
both parked on the holder: true
settle_maturity      : accepted
accept_bid           : ADA12 payable TP-2026-0142 has reached maturity
DEADLOCK 40P01 SEEN  : false
```

That the acceptance queues behind a payable-only holder is the whole proof. A
branch still reaching for the listing first would have been running rather than
queued, and the two would have ended up holding each other's next lock.

**The two tests that recorded the deadlock are replaced by one that records the
order.** They closed the cycle by hand, giving each session the first lock of
its own path, so they would deadlock whatever `ledger.post()` does and could
never have shown the fix. The new test holds one row and asserts both commands
queue on it, which is a claim about the product rather than about Postgres.

**The replacement hung on its first outing, and the hang was its own.** It waited
on both commands together while both sessions were still open. Whichever of the
two wins the payable row holds it until its transaction ends, so the loser could
never answer and the test ran to its 30s timeout. The winner is now closed as
soon as it answers, and the loser then gets its turn. Which one wins is not
asserted, because either order is legal.

Either order refuses the acceptance, but not with the same code, and the first
version of the test was wrong about that too. Settling first cancels the
listing, so the acceptance is turned away at the listing with `ADA11`, `listing
is cancelled`. Accepting first reaches a payable already past its date, which is
`ADA12`. Both are business refusals with wording behind them, which is the claim
that matters: the caller is told why, rather than handed a `40P01` the UI has no
sentence for.

---

## 2. Redeeming one member of a listed series strands its siblings' escrow

**FIXED.** The escrow unwind in `settle_maturity` no longer filters the
listing's legs to the settled asset. The listing is cancelled whole, so its
escrow comes back whole. The entry below is the state before that change.

**High severity. A matured series lot cannot be redeemed through the product.**

`settle_maturity` expires every open listing that carries the settled asset
(`db/post.sql` lines 693 to 699), but the inner loop that returns escrow to free
is filtered to that one asset (line 704, `AND asset_id = v_asset`). A series
listing carries a leg per member. Settling one member therefore cancels the
whole listing and unwinds only its own escrow, leaving every sibling's quantity
sitting in `wallet_listed` against a listing that is no longer open.

That is exactly the equality `escrow_matches_open_listings` enforces, and it is
`DEFERRABLE INITIALLY DEFERRED`, so the statement succeeds and the failure
arrives at COMMIT.

**Reproduction.** Test `leaves a sibling member escrowed and fails ADA04 at
COMMIT of a series redemption`. Two payables issued to one supplier, joined into
a series, published as one series listing, clock advanced past maturity, then
`settle_maturity` on the first member inside an explicit transaction.

**Observed.** `SELECT ledger.post(...)` returns successfully. `COMMIT` fails
with SQLSTATE `ADA04`:

```
escrow for 0x... asset <sibling asset id> does not match open listings (held 400000001, listed 0)
```

Posted the way the application posts, in autocommit, the same violation reaches
the caller as a refusal of the entire redemption. Nothing persisted: the payable
is still `issued`, the listing still `open`, both escrows untouched, books
`HEALTHY`.

The test also verifies the recovery, which locates the defect precisely:
cancelling the listing by hand first and then settling both members succeeds and
credits the supplier both faces. The data is fine; the escrow unwind is not.

**Expected.** A matured series member redeems. Series members share a maturity
date by construction, since `app.payable` carries
`FOREIGN KEY (series_id, maturity_date) REFERENCES app.series(id, maturity_date)`,
so every series lot still listed at maturity hit this on the first member
settled. There was no ordering of `settle_maturity` calls that avoided it.

**The fix** is one line: the inner loop's `AND asset_id = v_asset` is gone. The
outer loop already selects listings that carry the settled asset, and the leg
loop's job is to return what the listing held, which for a series is a leg per
member. The test that recorded the defect now asserts the repair instead: the
settled member reaches `settled`, the listing reaches `cancelled`, both members'
`wallet_listed` balances go to zero, the sibling's quantity is back in
`wallet_free`, and the sibling redeems next with no listing to cancel by hand
first. The `it.fails` case that asked for that is deleted.

---

## 3. A concurrent second publish leaks a raw `23505` to the caller

**Medium severity. The invariant holds, the message does not.**

`one_open_listing_per_seller_target` is a partial unique index, and `schema.sql`
says so deliberately: "A partial unique index, so a concurrent second publish
gets a unique violation rather than winning a race." It does. The money is
right. The sentence the loser gets is a Postgres internal.

**Reproduction.** Test `escrows the holding once when N publishes race for it`.
Four clients publish the same holding as a listing at the same instant.

**Observed.** One winner. Three losers, each with SQLSTATE `23505` and the
message `duplicate key value violates unique constraint
"one_open_listing_per_seller_target"`. Escrow equals the face exactly, free
balance zero, one open listing, books `HEALTHY`.

**Expected.** `tests/support/CONTRACT.md` says refusals carry `ADA01` through
`ADA34` and a message that reaches users. `accept_bid` goes to real trouble to
give its loser `listing is filled` rather than a mystery, and `create_payable`
already wraps its own unique violations and re-raises them as `ADA22` and
`ADA26` (`db/post.sql` lines 837 to 846). `publish_listing` does not.

**Fix shape, not applied.** Wrap the `INSERT INTO app.listing` in the same
`EXCEPTION WHEN unique_violation` block and re-raise as `ADA11` naming the
existing open listing.

---

## 4. `settle_maturity`'s holder loop reads balances with no lock

**Not currently exploitable. Recorded because the safety is accidental.**

The loop at `db/post.sql` lines 716 to 730 reads `ledger.account_balance` with
no lock and builds one debit leg per holder from what it read. The only lock on
those rows is taken later, by `post_legs` (lines 134 to 137). Interleaving a
balance change between the read and the write would either drive a wallet
negative or leave a holder unpaid.

I could not make it happen, and the reason is worth writing down.

**Reproduction.** Tests `parks on the payable row alone, before the holder loop
runs` and `pays the holders an interleaved transfer left behind, not the ones it
read`. The first gives one session the `app.payable` row lock and nothing else,
no balance row and no listing, then starts a settlement and asserts through
`pg_blocking_pids` that the settlement is queued behind exactly that session.
The second holds an uncommitted `transfer` open, advances the clock, starts the
settlement, waits for it to park, then commits the transfer.

**Observed.** The settlement never reaches the holder loop with a stale view. It
parks on the `app.payable` row taken at line 676, forty lines above the loop.
Once the transfer commits, the settlement re-reads and pays both holders their
true share: the supplier and the lender each receive half the face in XUSD,
outstanding supply goes to zero, books `HEALTHY`.

**Why it holds, and what would break it.** Every command that can move a payable
token takes `app.payable FOR NO KEY UPDATE` first: `issue_payable` (386),
`transfer` (449), `publish_listing` (508), `accept_bid` (636),
`accept_receipt` / `reject_receipt` (748). Two do not:

- `cancel_listing` (545) takes only `app.listing FOR UPDATE`, which is the same
  row `settle_maturity`'s expiry loop locks at line 698, so the two still
  serialise.
- The series variants of `publish_listing` (472) and `accept_bid` (631) lock
  `app.series` instead, but both refuse once the clock has reached the series
  maturity date, which is the window `settle_maturity` requires.

So the unlocked read is protected by a lock taken elsewhere, for a reason stated
nowhere. A new command that moves a payable token without locking `app.payable`,
or a relaxation of either maturity check, reintroduces the hazard silently. The
cheap durable fix is `FOR UPDATE` on the holder loop's select, or a comment at
line 716 naming the lock it depends on.

---

## 5. `create_payable` cannot accept a caller-supplied `payableId`

**Medium severity. Incidental, found while building this suite's fixture.**

The idempotency gate writes `(v_intent->>'payableId')::uuid` onto the journal
entry (`db/post.sql` line 371) before any branch runs, and
`journal_entry.payable_id` has a foreign key to `app.payable`. The
`create_payable` branch creates that row afterwards, at line 828, and the branch
itself reads `COALESCE((v_intent->>'payableId')::uuid, gen_random_uuid())` at
line 830, so a caller-chosen id is clearly intended to work.

**Reproduction.** Against any database cloned from the fixtures template:

```sql
SELECT ledger.post(jsonb_build_object(
  'idempotencyKey','00000000-0000-4000-8000-0000000cf002',
  'actorUserId',(SELECT id FROM app.app_user WHERE role='adata_preparer' AND deactivated_at IS NULL LIMIT 1),
  'intent', jsonb_build_object('kind','create_payable','payableId','9a000000-0000-0000-0000-0000000000f2',
    'ref','TP-PROBE-0002','supplierId',(SELECT id FROM app.entity WHERE entity_type='supplier' ORDER BY name LIMIT 1),
    'invoiceRef','INV-PROBE-0002','faceBase',1000000,'termsDays',30)));
```

**Observed.**

```
ERROR:  insert or update on table "journal_entry" violates foreign key constraint "journal_entry_payable_id_fkey"
DETAIL:  Key (payable_id)=(9a000000-0000-0000-0000-0000000000f2) is not present in table "payable".
```

**Expected.** The payable is created with the supplied id, as `COALESCE` at line
830 promises and as every other intent that accepts a caller-minted id does
(`listingId`, `bidId`).

**Impact.** The path is dead. Every fixture and test in the repository that
wants a known payable id inserts into `app.payable` directly instead, which is
the workaround this suite also uses: it posts `create_payable` without an id and
reads the id back off the journal entry that the branch fills in at line 851.

---

## What was attacked and held

Recorded so the next reader knows these were tried, not skipped.

**Select-or-insert races on `ledger.account`.** `wallet_account`,
`system_account` and `cash_asset` each do SELECT, then
`INSERT ... ON CONFLICT DO NOTHING RETURNING id`, then a re-SELECT. The
predicted failure is a NULL account id flowing into a leg and surfacing as
`23502`. It did not happen, in either race I could construct:

- Six simultaneous first-ever top-ups to a brand-new onboarded wallet, against a
  wallet with no `ledger.account` row at all. All six succeeded, exactly one
  `wallet_free` account exists, and the balance is the full six times the
  amount.
- Two simultaneous first-ever USDC-funded trades, which both reach
  `system_account('system_fx')` before that account exists. Both succeeded,
  exactly one `system_fx` account exists.

The re-SELECT is safe because `ON CONFLICT DO NOTHING` waits on the in-progress
tuple rather than returning immediately, and because `ledger.post` is `VOLATILE`,
so under READ COMMITTED each statement inside it takes a fresh snapshot and the
re-SELECT sees the row the winner just committed.

Two of the five call sites could not be raced at all from the fixtures template,
and this is a property of the template rather than of the code.
`SELECT count(*) FROM ledger.asset WHERE kind='cash'` is already 4 there, so
`cash_asset` never inserts; and `system_unissued` is only ever created inside
`issue_payable`, which takes `app.entity FOR UPDATE` on the anchor at line 399
and therefore serialises every issuance in the programme.

**Concurrent idempotent replay.** Six clients posting the same command with the
same key at the same instant produce exactly one `ledger.journal_entry`, one
`entryId` shared by all six receipts, one chain tx hash, one `replayed: false`
and five `replayed: true`, and the money moves exactly once. Four clients
reusing one key for four different intents produce one success and three
`ADA10`, `idempotency key reused with a different intent`.

**Over-withdrawal.** Five concurrent transfers of half a holding each: exactly
two succeed, three refuse with `ADA21` and the exact shortfall
(`wallet 0x... holds 0 unlisted, needs 1250000000`). Three concurrent buy-nows
priced at half the buyer's XUSD each: exactly two succeed, one refuses with
`ADA20` and the exact shortfall. No wallet balance went negative in either.

**The clock moving under a trade.** `schema.sql` says the world row is
deliberately not locked and both orderings are legal, and both are. Held
deterministically, an acceptance that read the world before an `advance_clock`
committed settles a lot on a payable that is matured by the time the trade
lands; raced, the acceptance either settles or refuses with `ADA12`. Books
balance either way.

**Fault injection.** All four leave the books consistent and the transaction
rolled back whole, including the idempotency-gate row, which matters because
that row is inserted at line 365 before any lock is taken.

| fault | SQLSTATE | message |
| --- | --- | --- |
| `pg_terminate_backend` mid-transaction | `57P01` | `terminating connection due to administrator command` |
| `statement_timeout` blocked on a held lock | `57014` | `canceling statement due to statement timeout` |
| `lock_timeout` against a held row lock | `55P03` | `canceling statement due to lock timeout` |
| deferred escrow equality at COMMIT | `ADA04` | `escrow for ... does not match open listings (held ..., listed 0)` |
| deferred double entry at COMMIT | `ADA03` | `entry ... does not balance for asset ...` |

The two deferred cases are asserted as deferred: the statement that violates the
invariant returns successfully and the failure arrives on `COMMIT`. Trigger
order matters when constructing them. `assets_are_conserved` fires before
`entry_must_balance`, so a pair of legs that breaks conservation reports `ADA05`
and hides `ADA03`; the test puts its two legs on one account and one asset
across two entries so conservation still nets to zero and only the per-entry
check can object.

## Stability

Flakiness would make every claim above worthless, so the suite was run
repeatedly. Ten runs on its own and six alongside `tests/techniques` and
`tests/support` together, several of them while other suites were running in
parallel on the same server. Twenty of twenty passed every time, and no cloned
database was left behind (`SELECT count(*) FROM pg_database WHERE datname LIKE
'adata_x_%'` is zero afterwards). `npx tsc --noEmit` is clean.

One flake was found and fixed rather than tolerated. `pg_terminate_backend`
signals and returns, so the row in `pg_stat_activity` outlives the call by a
few milliseconds; asserting the backend was gone immediately after the call
failed about once in ten combined runs. The assertion now polls for the
condition instead.
