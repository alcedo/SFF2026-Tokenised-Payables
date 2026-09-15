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

The books are re-proved after every pathway, with the same four-part query
`tests/support/database.ts` runs. That check is not decorative: adding one base
unit to a single wallet balance by hand makes it report
`projection_mismatches=2, unconserved_assets=2`.

Three intents gained real-browser coverage for the first time: `reject_receipt`,
`cancel_payable` and `cancel_listing` each had a wired control that no script
had ever clicked. `transfer` gained it too.

## 1. A supplier can set the credit grade on their own payable

`grade-by-supplier`, the one FAIL.

Acting as Tang Mei-Hua, a supplier at Chien Yu Precision, on a payable owed to
Chien Yu Precision: open `/admin/grading`, click "Assign grade". It is accepted.
The ledger's own journal records who did it.

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

So a lender can place a bid and has no way to take it back. The bid stays live
against their balance until the seller accepts it or supersedes it.

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

## What the suite does not cover

- `top_up` and `reset_world` have no UI path at all. `top_up` has an exported
  server action with no caller; `reset_world` is dead relative to the shipped
  app, which rebuilds the schema directly rather than posting the intent.
  Neither is a branch off issuance, so neither has a pathway here.
- `create_user` and `set_certification` have controls this suite only partly
  drives. `set_certification` is exercised by `issue-suspended-issuer`;
  `create_user` is account administration, not an issuance branch.
- Concurrency. Every pathway is one browser acting alone. Races are covered at
  the SQL layer by `tests/ledger/concurrency*.sh` and
  `tests/techniques/concurrency-faults.test.ts`.
- The suite is not part of `npm test`, for the same reason the other browser
  drivers are not: it needs the app running. There is no CI in this repository,
  so it runs when someone runs it.
