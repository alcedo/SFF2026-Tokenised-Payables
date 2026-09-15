# Working in this repository

A clickable demo of the ADATA tokenised payables programme. Fictional
throughout: no funds move, nothing touches a blockchain, and every hash, block
number and receipt is labelled simulated on screen.

## Read this before you trust a green test run

`npm test` passes. That does not mean the system is correct.

Testing work in `tests/techniques/` found roughly twenty defects and **did not
fix any of them**, because the brief was to test, not to change the system.
Most are recorded as passing assertions that pin what the code actually does,
including where that is wrong. So a clean run is consistent with real bugs.

**`tests/techniques/findings/` is the list.** One file per technique, each
defect with its file, line, reproduction, and observed against expected. Read
it before concluding anything works, and before changing `src/core` or
`db/post.sql`.

The ones most likely to matter to whatever you are doing:

- A `top_up` with no `amountBase`, and a self-transfer, are accepted and return
  a receipt saying `confirmed` with a transaction hash and zero legs. Commands
  that move nothing report success.
- Maker-checker is enforced nowhere. `app.lifecycle_edge.actor_role` is
  populated and read by nothing, so any user can approve their own submission.
- `listing.min_price_base` is stored, shown to the seller, and never compared
  to a bid.
- `settle_maturity` never reads `receipt_status`, so a payable the supplier
  rejected still redeems.
- `settle_maturity` and `accept_bid` take the same two locks in opposite
  orders, which deadlocks on the settlement path.
- A listed series lot cannot be redeemed at all.

Around twenty more, including a family where a guard compares against a value
that is NULL when the row was not found, so the guard is skipped and a raw
SQLSTATE reaches the user instead of a domain error code.

## If you fix one of these

Expect a test to turn **red**, and that is the signal working, not a
regression. Each defect has a matching `it.fails(...)` case asserting the
behaviour a reader expects. When the defect goes, that case starts passing,
which vitest reports as a failure. Delete the case deliberately and update the
findings file. `tests/techniques/README.md` explains the convention and says
which suite keeps which expectations.

## Running things

```bash
npm install
scripts/db.sh reset                       # Postgres, schema, seed
export DATABASE_URL="$(scripts/db.sh url)"
npm run dev                               # or scripts/serve.sh on :3100
```

`npm test` runs everything: vitest, typecheck, a schema check that no float
touches the money path, the SQL ledger stages, and two mutation gates. It needs
Postgres up. `SKIP_MUTATION=1` skips the slow part for a quick loop.

Other entry points are in `README.md` under "Verify it".

## Facts worth knowing before you write code

`ledger.post(jsonb)` is the only way anything is written. One function, one
intent per call, idempotency key required, `actor_user_id` NOT NULL. There is
no repository layer and no second path.

Money is a whole number of base units in `bigint`. One base unit is 0.0001 of a
display unit. Rounding is half away from zero and happens in exactly one place,
`money.roundDiv`. A float anywhere in the money path fails a check in
`npm test`.

The payable lifecycle has six stored states and its legal edges are **rows** in
`app.lifecycle_edge`, not code. Read them from the database rather than
hardcoding them. `matured` and `overdue` are derived from the clock in
TypeScript and never stored.

Four constraint triggers are `DEFERRABLE INITIALLY DEFERRED`, so `ADA03`,
`ADA04` and `ADA05` fire at COMMIT rather than at the statement. A plpgsql
`BEGIN ... EXCEPTION` block cannot observe them.

## Tests

`tests/techniques/` holds seven technique suites and `tests/support/` the
harness they share. Every database-backed suite gets its own database, cloned
from a template in about 80ms, so nothing is shared and nothing needs a lock.
`tests/support/CONTRACT.md` is the recipe those suites were written against.

`tests/ledger/` holds SQL-level tests, `src/core/__tests__/` per-module unit
tests.

Mutation testing is the gate on test quality. Stryker scores `src/core` and
breaks below 24. It cannot measure `src/core/fx.ts` or `src/core/input.ts`, for
reasons nobody has explained, so those two are excluded and guarded by
`scripts/mutate.mjs` instead. **Treat any file Stryker scores at exactly 0.00%
as a measurement failure until a hand-planted mutation proves otherwise.**
