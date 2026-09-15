# Working in this repository

A clickable demo of the ADATA tokenised payables programme. Fictional
throughout: no funds move, nothing touches a blockchain, and every hash, block
number and receipt is labelled simulated on screen.

Built against `tokenised-payable-prd.md`. Where the PRD is silent, the decision
taken is recorded in `docs/ASSUMPTIONS.md`.

## Running things

```bash
npm install
scripts/db.sh reset                       # Postgres, schema, seed
export DATABASE_URL="$(scripts/db.sh url)"
npm run dev                               # or scripts/serve.sh on :3100
```

`npm test` runs everything: vitest, typecheck, a schema check that no float
touches the money path, the SQL ledger stages, and the mutation gates. It needs
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

The payable lifecycle has seven stored states and its legal edges are **rows** in
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

**An `it.fails(...)` case asserts behaviour the system does not yet have.** It
reports as "expected fail" while the run stays green. If one starts passing,
vitest reports a failure: that means the gap it described has been closed, so
delete the case rather than reverting the change.

Mutation testing is the gate on test quality. Stryker scores `src/core` and
breaks below 24. It cannot measure `src/core/fx.ts`, `src/core/input.ts` or
`src/core/nav-active.ts`, for reasons nobody has explained, so those three are
excluded and guarded by `scripts/mutate.mjs` instead. Treat any file Stryker
scores at exactly 0.00% as a measurement failure until a hand-planted mutation
proves otherwise.
