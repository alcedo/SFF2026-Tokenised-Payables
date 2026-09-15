# ADATA Tokenised Payables

A clickable demo of the ADATA tokenised payables programme. Project BLOOM,
StraitsX with ADATA and BaaS Innovations.

Fictional throughout. No funds move and nothing touches a blockchain; every
hash, block number and receipt is labelled simulated on screen.

Built against [`tokenised-payable-prd.md`](tokenised-payable-prd.md). Where the
PRD is silent or points at a section that does not exist, the decision taken is
recorded in [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md).

## Run it locally

```bash
npm install
scripts/db.sh reset          # start Postgres, load the schema, seed the world
export DATABASE_URL="$(scripts/db.sh url)"
npm run dev                  # or: scripts/serve.sh  (build + serve on :3100)
```

Then open the app and use the **Demo controls** bar at the top to switch
persona, move the clock, top up a wallet, create a new account, or reset the
world.

`docs/RUNBOOK.md` is the five-minute presenter script.

## What is in it

Nineteen screens across five personas — ADATA preparer and checker, supplier,
lender, and the StraitsX admin — covering every screen PRD §8 lists:

| | |
|---|---|
| **ADATA** | outstanding obligations · create payable, by ERP import or by hand · maker-checker approval queue · settlement, funded in any of the four assets |
| **Supplier** | inbox and holdings with the financing comparison · request financing, whole or part, with an optional buy-now price · offers received |
| **Lender** | marketplace, filtered by maturity, tenor, grade, ticket size and yield · payable detail with series expansion · bid or buy now in any of four funding assets · portfolio with realised returns |
| **Admin** | issuer certification · grading · accounts · programme oversight · overdue and recovery |
| **Anyone** | onboarding with a custodial wallet · transfer · mock chain explorer · reset |

The demo world seeds itself with 20 organisations, 19 accounts, 23 payables
across all three grades and 30 to 180 day tenors, nine open listings with live
bids, a 6-invoice series lot, a settled position, an overdue one, and a
24-invoice ERP register. T0 is the day the world was seeded, so the tenors stay
realistic however long the URL stays up.

## Verify it

```bash
npm test                     # unit, schema, ledger, invariants, concurrency
npm run verify:screens       # every screen, every persona, in a real browser
npm run verify:runbook       # the whole runbook driven click by click
```

The last two need the app running (`scripts/serve.sh`).

## Deploy to Vercel

1. **Provision Postgres.** Vercel Postgres, Neon and Supabase all work. Use the
   **pooled** connection string, because each serverless instance opens its own
   pool and instances scale out under load.
2. **Set `DATABASE_URL`** in the Vercel project's environment variables.
3. **Deploy.** The first request against a database with no `app.world` row
   loads `db/schema.sql` and `db/post.sql` if the schema is missing, then
   `db/fixtures.sql` (ADATA, StraitsX, and the three acting accounts). It does
   not load the demo catalogue. You can create payables and onboard
   counterparties from there. Reset world still loads `db/seed.sql` when you
   want the PRD §12 demo. There is no `psql` step.
4. **Set `ADATA_RESET_PIN`** if the URL is going to be public. Reset restores
   the seed for *everyone* connected, so it is already restricted to the
   StraitsX admin persona and needs the word RESET typed to arm. But the
   persona switcher is open by design (PRD §11), so anyone can become the
   admin. The PIN is the only gate a stranger cannot walk through. Leave it
   unset for a laptop demo and the screen says so plainly.

No build-time database access is needed. Every route is server-rendered on
demand.

### Notes for Neon

Use the **pooled** host — the one with `-pooler` in it — as `DATABASE_URL`.
Neon's pooler runs in transaction mode, which suits this app: every write is a
single `ledger.post()` call in one transaction, and nothing depends on session
state between requests.

Neon's free tier suspends a database after five minutes idle, and the first
query after that pays a cold start of a second or two. For a demo that must
open instantly in front of a room, either keep a tab open or disable
scale-to-zero on the branch.

The database owner often cannot `CREATE ROLE`. Schema load skips the
`adata_app` nologin role in that case; the connecting user owns the objects
and the app still runs. `adata_app` is created when the owner has
`CREATEROLE`, which is how a laptop `psql` against local Postgres behaves.

`Reset world` replays `db/schema.sql`, `db/post.sql` and `db/seed.sql` through
the driver in one transaction, which takes a few seconds on Neon and needs no
`psql` on the server. The first request against a database with no world row
loads the schema (if needed) and `db/fixtures.sql` instead, so a freshly
provisioned Neon opens without a laptop `psql` step and without the demo
catalogue.

`PG_POOL_MAX` defaults to 1 connection per instance. Raise it only if you have
measured a need and the database can take the total.

## How it fits together

```
src/core/      pure domain: money, pricing, lifecycle, clock. No I/O, no React.
src/db/        the only way in and out. post() writes, read() reads.
src/app/       routes and server actions. Thin shells over the two above.
db/            schema.sql, post.sql (the write surface), fixtures.sql, seed.sql
tests/         SQL suites against a real Postgres, plus browser drivers
```

Three decisions carry most of the weight.

**Money is a branded `bigint` of base units**, where 1.0000 XUSD is 10,000
units. JavaScript refuses to mix `bigint` with `number`, so a float in the money
path stops compiling rather than silently rounding. The driver is configured to
hand back `BIGINT` and `SUM()` as `bigint` for the same reason, and a CI check
fails the build if any money column is ever declared `numeric` or `double
precision`.

**Balances are derived from an append-only journal**, not stored and edited.
`ledger.account_balance` is a projection maintained by a trigger, and
`ledger.prove_books_balance()` asserts it equals the journal for every row. The
admin screen runs that proof live, which is the strongest thing this
architecture has to say for itself: the figures on screen are a fold of the
transaction log and nothing else.

**One function writes.** `ledger.post()` is the single write surface, and the
application's database role has no write grant on any ledger table. "Always post
through the ledger" is therefore a privilege rather than a convention, and the
lock ordering that makes concurrent acceptance safe lives in one function you
can read end to end.

## What is deliberately not here

Real blockchain connectivity, real KYC, ERP integration, a production credit
model, coupons, early buyback, partial maturity settlement, and operational
recovery workflows. All out of scope per PRD §4.

The platform is intended to be ported to Sepolia for real testnet transactions
under a later PRD. The read model is shaped for that: a journal entry is already
a `TransferSingle`-shaped record with a transaction hash and block number, so
the port replaces the write path with an indexer rather than reshaping the data.
`docs/design/LEDGER.md` is honest about what that port does not give for free.
