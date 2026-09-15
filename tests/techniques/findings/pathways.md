# Findings: end-to-end pathway coverage

Suite: `scripts/pathways.mjs` (`npm run verify:pathways`)
Technique: every branch of the tree rooted at an issued payable, driven through
the real UI in a real browser, as the persona who would really click it. Each
pathway gets its own world, rebuilt through the app's own reset screen, and the
books are re-proved after every one.

Nothing in `src/` or `db/` was changed. Finding 1 is a defect this suite found
and did not fix. Finding 2 is a branch the ledger supports that no screen
reaches. Findings 3 and 4 are branches with no control where that is the correct
answer, recorded because the verdict reads like a gap. Finding 5 is a reachable
state nothing asserted either way before.

## Why this suite exists

The repository already tests these pathways twice, and neither pass could catch
finding 1.

`tests/techniques/model-based.test.ts` is exhaustive at the ledger layer: 19 of
19 commands, 7 of 7 lifecycle states, 92 of 92 reachable (state, command) pairs.
It calls `ledger.post()` directly, so a rule the ledger never enforced is a rule
its model never predicted, and both agree.

`scripts/runbook.mjs` drives the real UI, but along one line: issue, list, bid,
accept, advance, settle. It grades as the admin because the admin is already
the acting persona at that step, so it never asks who else could.

The gap between them is where a branch the ledger allows and no button reaches
lives, and where a button no rule guards lives too. That gap is this suite.

## Results

27 pathways. Run with `scripts/serve.sh` up; about twelve minutes.

| Verdict | Count | Meaning |
| --- | --- | --- |
| PASS | 25 | driven through the UI, ledger state correct afterwards |
| FAIL | 1 | driven through the UI, ledger state wrong |
| UNREACHABLE | 1 | the ledger supports it, no control reaches it |

Two of the passes are refusals that pass by omission: `cancel-after-accept` and
`settle-early` have no control at all, which is the refusal working. See
findings 3 and 4.

The books are re-proved after every pathway, refused and failed ones included,
with the same four-part query `tests/support/database.ts` runs. That check is
not decorative: adding one base unit to a single wallet balance by hand makes it
report `projection_mismatches=2, unconserved_assets=2`.

Three intents gained real-browser coverage for the first time: `reject_receipt`,
`cancel_payable` and `cancel_listing` each had a wired control that no script
had ever clicked. `transfer` gained it too.

## 1. A supplier can set the credit grade on their own payable

`grade-by-supplier`, the one FAIL.

Acting as Tang Mei-Hua, a supplier at Chien Yu Precision, on a payable owed to
Chien Yu Precision: go to `/admin/grading` and click "Assign grade". It is
accepted. The ledger's own journal records who did it.

The supplier is not offered that screen. `navFor` (`src/app/session.ts:66`)
gives them no grading link, so reaching it means typing the URL. That lowers how
likely this is to happen by accident and changes nothing about the control: the
server renders the form for them and the ledger accepts the write.

```
 kind   |    actor     |   role   |     acting_for
--------+--------------+----------+--------------------
 graded | Tang Mei-Hua | supplier | Chien Yu Precision
```

The grade is not decoration. It is what the marketplace prices against and what
`certify` requires before a payable can be issued, so the party being financed
is setting the number their own paper is sold on.

Two things have to line up for this, and both do.

`db/post.sql:1190` skips the actor check for this one command:

```sql
IF v_kind <> 'grade' THEN
  PERFORM app.assert_edge_actor(v_payable, CASE v_kind ... END, v_actor);
END IF;
```

The skip is defensible on its own terms. `app.assert_edge_actor` resolves the
role from the `app.lifecycle_edge` row for a transition, grading moves no
lifecycle state, and there is no row to read, so the function would return
silently anyway. The consequence is that grading is the one write in the
approval chain with no role rule anywhere in the ledger.

`src/app/admin/grading/page.tsx:57` then renders the form for every persona:

```tsx
<GradeForm payableId={p.id} payableRef={p.ref} />
```

while `src/app/adata/approvals/page.tsx:235` renders the same component behind a
role check:

```tsx
persona.role === 'straitsx_admin' && p.grade === null ? (
  <GradeForm payableId={p.id} payableRef={p.ref} />
) : ( ... )
```

The same command is guarded on one screen and open on the other, and the ledger
declines to settle the disagreement.

Worth saying plainly: the UI is where this is reachable, and the ledger is where
it is unguarded. Fixing only the screen would leave `grade` the one intent any
persona can post.

## 2. A lender cannot withdraw a bid

`bid-withdraw`, UNREACHABLE.

`withdraw_bid` is a real intent with a real state (`app.bid_status` has
`withdrawn`), tested at the SQL layer in `tests/ledger/states.sql`. There is no
control for it. `src/app/actions.ts` has no server action, and `BidPanel.tsx`
imports only `buyNow` and `placeBid`.

So a lender can place a bid and has no way to take it back. It stays on the
seller's offers screen until they accept it or another bid supersedes it.

Nothing is locked by this. `db/post.sql:669` is explicit that bids reserve no
funds and post no leg, and the balance is rechecked when the seller accepts. The
gap is that a lender cannot retract an offer, not that money is tied up.

## 3. An accepted payable cannot be cancelled, and that is correct

`cancel-after-accept`, UNREACHABLE, and the system is right.

`app.lifecycle_edge` carries `issued -> cancelled`, so the edge exists for any
issued payable. What closes the hole is not the edge table but a guard inside
the command: `db/post.sql:899` raises `ADA40` unless `receipt_status` is
`rejected`. The approvals screen matches it by offering "Cancel payable" only in
its refused-by-supplier section.

Recorded here because the verdict reads like a gap and is not one. The suite
marks pathways of this shape `expects: 'blocked'`, where a missing control is
the refusal working rather than a branch nobody built.

## 4. An unmatured payable has no settlement control

`settle-early`, UNREACHABLE, and correct for the same reason. `ADA12` refuses an
unmatured settlement in the ledger, and `/adata/settlement` lists only payables
that are actually due, so there is nothing to click.

## 5. A payable nobody accepted still matures and pays

`settle-never-accepted`, a pass. It was added after reading the guards rather
than after a failure, and it asserts the behaviour as it is.

`settle_maturity` refuses an already-settled payable (`ADA16`), an unmatured one
(`ADA12`), and one the supplier rejected (`ADA37`). It does not check for a
receipt still `pending`. Driven through the UI, a payable issued and never
accepted matures and settles: the pathway ends at `settled` + `pending`, and the
books reconcile. A supplier who never touched their inbox is paid anyway.

This is arguably right. The obligation is real whether or not the supplier
clicked Accept, and refusing would strand it. It is recorded because the state
is reachable and nothing in the suite asserted it either way before.

## 6. `npm test` leaves a world no browser driver can use

Found by running `npm run verify:pathways` immediately after `npm test`, which
is what a contributor does.

Both write the same `adata` database. The SQL stages end by loading their own
fixtures, whose StraitsX entity has no wallet row. `readPersonas()`
(`src/db/read.ts:61`) joins through `app.wallet`, so the administrator drops out
of the persona switcher entirely:

```
ADATA · checker — Lin Hsu | ADATA · preparer — Wei Chen |
Supplier — Mei Tang | Lender — R. Okafor | Lender — S. Baptiste
```

No admin means no reset control, and the reset screen is the only way a driver
can put the world back. The world is unrecoverable by clicking.

This suite now checks for that before its first pathway and exits 2 saying what
to run. The other drivers do not, and against this world they fail as a bare
30-second Playwright timeout that reads like a broken feature. `scripts/db.sh
reset` fixes it; the hazard is that nothing says so.

## What the suite does not cover

- `top_up` is reachable, from "Simulate top-up" then "Add balance" in the demo
  controls strip (`src/components/DemoControls.tsx:219`). No pathway here drives
  it because funding a wallet is not a branch off issuance. An earlier draft of
  this file called it uncallable, which was wrong: `scripts/controls.mjs`
  subtracts the strip from every screen to show what each one adds, and a
  control that lives only in the strip therefore appeared nowhere. The script
  now prints the strip once on its own.
- `reset_world` is dead relative to the shipped app, which rebuilds the schema
  directly rather than posting the intent.
- `create_user` and `set_certification` have controls this suite only partly
  drives. `set_certification` is exercised by `issue-suspended-issuer`;
  `create_user` is account administration, not an issuance branch.
- Series lots. `app.listing.target_kind` has a `series` member and every pathway
  here lists a single payable. A series is a bundle of several suppliers'
  invoices under one holder, so trading one is a real branch nobody drives.
- `app.bid_status = 'superseded'`, which needs two competing bids on one
  listing. Every pathway here places at most one bid.
- A lender relisting what they bought. `/lender/portfolio` offers "Relist", and
  `list()` already takes the seller and the screen as arguments, so this is a
  row nobody has written rather than a thing the harness cannot do.
- A bid below the seller's minimum price, which should be refused.
- `app.listing_status = 'closed_by_transfer'` is not a gap: it is declared at
  `db/schema.sql:368` and written nowhere, a dead enum member the
  state-transitions suite already found.
- Concurrency. Every pathway is one browser acting alone. Races are covered at
  the SQL layer by `tests/ledger/concurrency*.sh` and
  `tests/techniques/concurrency-faults.test.ts`.
- The suite is not part of `npm test`, for the same reason the other browser
  drivers are not: it needs the app running. There is no CI in this repository,
  so it runs when someone runs it.
