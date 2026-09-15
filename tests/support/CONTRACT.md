# Contract for the test suites under `tests/techniques/`

Every suite in this directory is written against one testing technique. This
file is the shared recipe. Read it before writing a suite, and do not edit it.

## The harness

`tests/support/database.ts` is the only way a suite touches Postgres.

- `freshDatabase(suite, template)` gives the suite its own database. Templates
  are `'bare'` (schema only), `'fixtures'` (the world a fresh database boots
  into) and `'seed'` (the demo world). Call it in `beforeAll` and
  `await handle.close()` in `afterAll`.
- `post(executor, intent, { actorUserId, key })` calls `ledger.post()` and
  returns `{ ok: true, receipt }` or `{ ok: false, message, code }`. It never
  throws for a refusal, so assert on `code` and `message`.
- `actors(pool)` maps role to user id. `anyActor(pool)` is the default.
- `ledgerHealth(pool)` returns the four-part oracle. `HEALTHY` is the value it
  must equal.

Never open your own `Pool` against a hardcoded database name, and never write
to the shared `adata` database. A suite that does either will race every other
suite.

## Non-negotiable rules

1. **Assert a literal expected value.** A test that would still pass if the
   function under test returned `undefined` is worthless. No lone
   `toBeDefined`, `toBeTruthy`, `not.toThrow`, or `toBeGreaterThan(0)`.
2. **Assert the error, not just that one happened.** Refusals carry a SQLSTATE
   (`ADA01` through `ADA34`) and a message. Assert the code. Assert the message
   where it names a quantity or a state, since that text reaches users.
3. **Every database-backed suite ends its scenario by asserting
   `await ledgerHealth(pool)` equals `HEALTHY`.** The books balancing is the
   point of the system.
4. **Do not change production code.** Not `src/`, not `db/`. If a test exposes
   what looks like a defect, keep the test and write the finding into
   `tests/techniques/FINDINGS.md` with the file, the reproduction and the
   observed versus expected behaviour. A failing test that documents a real
   defect is a deliverable, not a problem to hide. If a suite cannot pass
   because the system is wrong, mark that single case `it.fails(...)` so the
   suite still runs green while recording the defect, and write it up.
5. **Do not edit any other suite, this contract, or anything under
   `tests/support/`.** Suites run in parallel and must not collide.
6. **Comments explain a non-obvious why, never a what.** No phase-narrating
   comments such as `// Step 1: create the payable`. Let the assertion message
   carry the narration.
7. **No long-dash character anywhere** in code, comments or prose.

## Facts about the system you will need

- `ledger.post(jsonb)` is the single write entry point. Envelope is
  `{ idempotencyKey, actorUserId, intent: { kind, ... } }`. `actorUserId` is
  NOT NULL and must be a real `app.app_user` id.
- Money is a whole number of base units in `bigint`. `BASE_UNITS_PER_UNIT` is
  `10_000n`, so one base unit is 0.0001 display units. Rounding is half away
  from zero, implemented once in `money.roundDiv`.
- The obligation lifecycle has six stored states: `draft`, `pending_approval`,
  `approved`, `certified`, `issued`, `settled`. The legal edges live as rows in
  `app.lifecycle_edge`. Read them from the database rather than hardcoding
  them. Illegal transitions raise `ADA01`.
- `matured` and `overdue` are derived in TypeScript from the clock and are
  never stored.
- The four constraint triggers (`entry_must_balance`, `assets_are_conserved`,
  `escrow_matches_open_listings`, and the leg variant) are
  `DEFERRABLE INITIALLY DEFERRED`, so `ADA03`, `ADA04` and `ADA05` fire at
  COMMIT. The harness posts in autocommit, so you will see them.
- `actor_user_id` is recorded on every journal entry and consulted by nothing.
  Role and identity rules are not enforced in the database.

## What "done" means for your suite

- `npx vitest run tests/techniques/<your-file>` is green.
- `npx tsc --noEmit` is clean.
- Every case asserts a literal or a named error code.
- Any defect found is written up in `tests/techniques/FINDINGS.md`.
