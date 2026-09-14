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
persona, move the clock, top up a wallet, or reset the world.

`docs/RUNBOOK.md` is the five-minute presenter script.

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
3. **Load the schema once**, against that database:
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql -f db/post.sql -f db/seed.sql
   ```
   Reset world does the same thing from inside the app afterwards.
4. **Deploy.** No build-time database access is needed; every route is
   server-rendered on demand.

`PG_POOL_MAX` defaults to 1 connection per instance. Raise it only if you have
measured a need and the database can take the total.

## How it fits together

```
src/core/      pure domain: money, pricing, lifecycle, clock. No I/O, no React.
src/db/        the only way in and out. post() writes, read() reads.
src/app/       routes and server actions. Thin shells over the two above.
db/            schema.sql, post.sql (the write surface), seed.sql
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
