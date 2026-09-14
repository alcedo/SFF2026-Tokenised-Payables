# Candidate 3 — the journal is the product

**Position in one line:** an append-only double-entry journal is the only writable money state;
balances and holdings are a trigger-maintained projection the application role is *not granted
permission to write*; every operation is one `SELECT ledger.post($1)` under READ COMMITTED with
explicit ordered row locks; there is no ORM.

---

## Usage (caller's view)

### Quickstart

```ts
import { post, Intents } from "@/ledger/post";
import { marketplace, payableDetail } from "@/ledger/read";
import { readClock } from "@/ledger/db";
```

Two verbs. `post(command)` is the only way anything changes. The `read.*` functions are the only
way anything is displayed. There is no third module, no repository, no `db.wallet.update`.

Every write carries an **idempotency key** minted by the client when a confirmation dialog opens.
Every read takes a **clock**. Both are required parameters, because both are things a demo
forgets and then loses a lender's money over.

---

### Call site 1 — a supplier accepts a lender's bid

`app/(supplier)/offers/actions.ts`. This is the hardest operation in the system: it must debit
the buyer's funding asset, credit the seller in XUSD, move the traded quantity, close the
listing and expire competing bids, atomically, while two lenders may be racing on the same
listing.

```ts
"use server";

export async function acceptOffer(form: AcceptOfferForm) {
  const actor = await resolvePersona();                  // boundary: who is acting

  const result = await post({
    key: form.idempotencyKey,                            // minted when the modal opened
    actor,
    intent: {
      kind: "accept_bid",
      listingId: form.listingId,
      bidId: form.bidId,
    },
  });

  if (!result.ok) {
    switch (result.error.code) {
      case "insufficient_funds":
        return inline(
          `${form.bidderName} no longer has ${fmt(result.error.requiredBase)} ${result.error.asset}. ` +
          `The bid and your position are unchanged.`,
        );
      case "bid_not_open":
        return inline("That offer was withdrawn or another offer was already accepted.");
      case "past_maturity":
        return inline("This payable has reached maturity. Listings close at maturity.");
      case "contended":
        return inline("Someone else is acting on this listing. Try again in a moment.");
      default:
        return inline(messageFor(result.error));
    }
  }

  // Success. `receipt` is non-null because a trade settlement moves value.
  return {
    receipt: result.value.receipt!,       // 0x… hash, block number, both labelled simulated
    conversion: result.value.conversion!, // XSGD debit, rate used, XUSD credited — for the screen
    replayed: result.value.replayed,      // true on a double-click; the SAME receipt comes back
  };
}
```

What the caller does **not** do: open a transaction, decide an isolation level, order locks,
compute the FX debit, check the seller still owns the quantity, close the listing, walk competing
bids, write an audit row, or mint a receipt. It names an intent and reads a tagged failure.

A double-clicked Accept produces two calls with the same `key`. The second returns
`replayed: true` and the identical receipt — the seller is credited once. A Vercel retry of the
same POST does the same thing, for the same reason.

---

### Call site 2 — the lender marketplace, rendered after a fast-forward

`app/(lender)/marketplace/page.tsx`. Nothing here may be stale after the demo clock moves.

```tsx
export default async function MarketplacePage({ searchParams }) {
  const clock = await readClock();                       // the world's date, epoch and FX rate

  const rows = await marketplace({
    clock,
    filters: { sort: "yield", minGrade: searchParams.grade },
  });

  return (
    <Table>
      {rows.map((row) => (
        <Row key={row.listingId}>
          <Ref>{row.ref}</Ref>
          <Qty
            invoiceFace={row.invoiceFaceBase}            // shown alongside listed quantity
            listed={row.listedQuantityBase}              // when they differ (PRD §8 screen 9)
          />
          {/* The pricing variant decides what can be rendered at all. There is no
              yield field to accidentally show on a matured listing. */}
          {row.pricing.kind === "forward" ? (
            <>
              <Cell>{formatPercent(row.pricing.pricePctOfFace, 2)}%</Cell>
              <Cell>{formatPercent(row.pricing.impliedLenderYield, 1)}% yield</Cell>
              <Cell>{row.pricing.daysRemaining}d</Cell>
            </>
          ) : (
            <Badge tone="warn">{row.pricing.kind === "due" ? "Due" : "Overdue"}</Badge>
          )}
        </Row>
      ))}
    </Table>
  );
}
```

Press **+30 days** in the demo controls and this page re-renders with new days remaining, new
yields, and `Due` badges on anything that crossed maturity — because `clock` is an argument and
nothing derived from it was ever written down. No sweeper job ran. No row changed.

---

### Call site 3 — ADATA funds maturity on a payable held by four wallets

`app/(adata)/settlement/actions.ts`. One debit, four credits, one entry.

```ts
"use server";

export async function fundSettlement(form: FundSettlementForm) {
  const actor = await resolvePersona();

  const result = await post({
    key: form.idempotencyKey,
    actor,
    intent: {
      kind: "settle_maturity",
      target: { kind: "payable", payableId: form.payableId },
      funding: form.fundingAsset,          // "USDC" | "USDT" | "XSGD" | "XUSD"
    },
    // Note what is absent: the holder list and the per-holder amounts.
  });

  if (!result.ok) return inline(messageFor(result.error));

  const { receipt, conversion } = result.value;
  return {
    sourceDebit: conversion!.sourceDebit,       // e.g. XSGD 320,458.7500 at 1.31
    rate: conversion!.rateE6,
    credits: receipt!.balanceMoves,             // one XUSD credit per current holder
    txHash: receipt!.txHash,
  };
}
```

The holder set is deliberately not a parameter. Passing it would mean reading it before the lock
is held — the stale-owner bug the PRD names — and would let a transfer that lands between the
screen render and the confirm click pay the wrong wallet. `ledger.post()` enumerates holders
after locking them.

The per-holder allocation contains no division: a payable token base unit and an XUSD base unit
are the same size by construction, so each holder's credit **equals** their quantity. "Pro-rata
maturity credits are exact" (PRD §7) is not an arithmetic goal here; it is a type-level identity.

---

## Shape

### The central fork: double-entry journal, balances projected, never written by the app

The PRD hands us both an `Event` table and `Wallet.balances_by_asset`. Shipping both is shipping
two sources of truth for the same fact, and the audit requirement in §10 is exactly the
requirement that they never disagree. So one of them has to be derived.

**Decision: the journal is authoritative. `account_balance` is a projection maintained by an
`AFTER INSERT` trigger on `journal_leg`, and the application database role has no `INSERT`,
`UPDATE` or `DELETE` grant on any ledger table.** All writes go through one `SECURITY DEFINER`
function, `ledger.post(jsonb)`.

That last clause is the load-bearing part. "Always post through the ledger" as a convention
survives about two sprints. As a missing `GRANT`, it survives contributors, agents, and the
3 a.m. hotfix, per **encode-lessons-in-structure** — pick the strongest mechanism available, and
a privilege is stronger than a lint which is stronger than a comment.

Three consequences follow, and they are the whole design:

**1. The sum invariant stops being an invariant.** A deferred constraint trigger requires every
entry to net to zero *per asset*. Supply is created by one mint entry that credits the supplier
and debits `system_unissued` (the 0x0 address, modelled as a real account). Therefore
`SUM(holder balances) = outstanding face` is arithmetic, not vigilance. There is no code path
that "must remember" to keep holdings summing to face, because there is no code path that can
write a holding without writing its counterparty in the same statement. PRD §7's hardest
sentence is discharged by the shape rather than by a check.

**2. Locked-to-listing quantity stops being arithmetic.** Publishing a listing *moves* the
quantity from the wallet's `free` account to its `listed` account. Availability is then just the
free balance, and an over-quantity transfer is blocked by the same `CHECK (balance >= 0)` that
blocks an overdraft. One deferred trigger then asserts, for every seller and asset,
`listed_balance = SUM(open listing quantities)` — which simultaneously enforces four separate PRD
rules: listed quantity is locked; a transfer that would drop below it must close the listing and
expire its bids *in that transfer*; acceptance must close the listing; cancellation must return
the quantity. Forgetting any of those cascades is now a commit error, not a silent corruption.

**3. The Sepolia port is an indexer, not a rewrite.** `TransferSingle(operator, from, to, id,
value)` *is* a two-leg journal entry. A mint is a transfer from 0x0; a redemption burn is a
transfer to 0x0; an ERC-20 payment is a cash-asset entry. The port replaces the *producer* of
legs (a request handler) with a different producer (a chain-event indexer) and changes nothing
about the projection, the views, or any screen. Against a mutable-balance design, the port means
rewriting every mutation site. Against event sourcing, the port means rewriting the aggregate
boundaries too.

**What I rejected, and why, not hedged:**

*Mutable balance columns.* There is no place to enforce the sum invariant — "holdings sum to
face" is a cross-row aggregate and Postgres cannot `CHECK` it — so it degrades to a test that
passes until the demo. And the `Event` table becomes a write-alongside that can silently disagree
with the balances, which is precisely the failure the audit requirement exists to prevent.

*Event sourcing with replay.* Serverless has no process state, so every request either replays
the log or reads a snapshot table. Once the snapshot table exists you have built this design's
projection minus its constraints. Its real payoff — arbitrary retroactive projections — has no
customer in this PRD, and its concurrency model (expected-version optimistic concurrency) turns
every contended Accept into a retry, which is the failure mode we are trying hardest to avoid.

*Derived balances with no materialised table.* Tempting, and it is what "double-entry with derived
balances" usually means. It loses on two counts: there is no row to lock, so overdraft prevention
becomes entirely SSI's job; and there is no row to `CHECK`, so "wallet balance ≥ 0" becomes a
procedure rather than a constraint. The materialised table is not a cache added for speed. It is
the lock target and the constraint target, and `ledger.prove_books_balance()` asserts it equals
the journal.

### Isolation level and locking order

**READ COMMITTED with explicit `SELECT … FOR UPDATE`, in one total order, inside `ledger.post()`.**

The order, written once, in the one function that holds any lock:

```
1. app.payable        ORDER BY id   FOR NO KEY UPDATE
2. app.series         ORDER BY id   FOR NO KEY UPDATE
3. app.listing        ORDER BY id   FOR UPDATE
4. ledger.account_balance  (INSERT … ON CONFLICT DO NOTHING, then
                            SELECT … ORDER BY account_id, asset_id FOR UPDATE)
```

Ascending by class, then ascending by id within class. Deadlock freedom is the standard argument
from a total order, and the argument is *checkable* because there is exactly one place in the
codebase that takes a lock. That is the property the REVOKE buys.

Two details that bite and are easy to miss. Step 4 inserts the `(account, asset)` rows before
locking them, because a first-time holder has no balance row and you cannot `FOR UPDATE` a row
that does not exist. And steps 1–2 use `FOR NO KEY UPDATE` rather than `FOR UPDATE`, so child
inserts taking FK share locks on the parent do not deadlock against us.

**Why not SERIALIZABLE.** Four reasons, in order of how much I care:

- It converts contention into `40001` aborts that must be retried, which means correctness would
  depend on the retry loop being right. Idempotency should be a safety net, not a load-bearing
  member.
- On Vercel a retry costs a full round trip against a 500–2000 ms budget that already has to
  absorb a cold start. Blocking on a lock costs microseconds when uncontended and is bounded by
  `lock_timeout`.
- SSI's predicate locks over an insert-heavy single journal table produce false-positive
  serialization failures under no real conflict. Demo-day thundering herd is exactly that
  workload.
- A blocked lock that times out is distinguishable — it becomes `contended`, with a message a
  human understands. A `40001` is indistinguishable from a real failure without extra plumbing.

Set both timeouts with `SET LOCAL` inside the transaction, not `SET`: Vercel talks to Postgres
through a transaction pooler where session state does not survive between statements.

**When SERIALIZABLE would be right:** if writes were scattered across many code paths, lock
ordering could not be guaranteed and SSI would be the only safe answer. READ COMMITTED here is
bought with the REVOKE. Remove the REVOKE and this choice becomes wrong.

### Idempotency

`journal_entry.idempotency_key uuid UNIQUE`, plus `request_fingerprint` = sha256 of the
canonicalised intent.

The key is minted **client-side when a confirmation dialog opens**, held in a ref for that
dialog's life. That binding is chosen against the two realistic replay sources named in the
brief: a double-clicked button reuses the ref; a serverless retry replays the same request body.
Opening the dialog a second time mints a new key, which is correct — that is a new intent.

`ledger.post()` takes the unique-key insert *first*, before any lock. Two concurrent replays
serialise on the unique index, not on the accounts: the loser blocks, sees the winner's row, and
returns the identical receipt. A key replayed with a *different* fingerprint raises
`idempotency_key_reuse` rather than silently returning someone else's receipt.

The mock tx hash is `sha256(idempotency_key)`, so a replay reproduces the same hash before the
database is consulted — which is exactly how resubmitting a signed transaction behaves, and makes
the demo's "blockchain-like" claim literally true rather than decorative.

### One event table, not two

The journal is the audit trail of PRD §10, the mock blockchain of PRD §10, and the source of
truth for every balance — one append-only table, because they are the same fact: a state
transition, attributed to an actor, at a point in the world's ordering. One idempotency
mechanism, one total ordering, one query for "everything that happened to TP-2026-0141".

**An entry is chain-relevant iff its legs span more than one party** — two wallets, or a wallet
and a system account. Under that rule PRD §10's two lists coincide exactly: issuance, top-up,
transfer, trade settlement and redemption cross a party boundary; approval, grading, listing
publication and bid placement do not. So chain-relevance is derived and can never disagree with
the legs, rather than being a stored flag someone forgets to set.

(My first draft used the simpler rule "has legs". Loading the schema into Postgres and running a
listing publication showed it wrong: escrow moves quantity from the seller's free account to
their listed account, which is real ledger movement but intra-wallet, and PRD §10 says listing
publication gets no receipt. The party-boundary rule is also the one that matches the chain —
escrow by approval emits no ERC-1155 transfer either.)

`v_chain_receipt` backs both the mock explorer and the receipt reopened from history, so they
cannot render differently.

### Nothing the clock can change is stored

`listing.status` has no `expired` member. `bid.status` has no `expired` member. The obligation
enum has no `matured` and no `overdue`, and `app.lifecycle_edge` contains no row that could
transition into them. A listing *displays* as expired when it is open and the clock has passed
maturity; acceptance re-checks maturity under lock and refuses. There is no sweeper job, so there
is no "presenter fast-forwards and nothing happens" failure.

Illegal *combinations* are unconstructable rather than checked: market status has no storage at
all, being derived from the existence of an open listing, and a listing row cannot exist against
a payable that is not issued.

### Integers, structurally

`bigint` in Postgres, `bigint` in TypeScript. The enforcement is not discipline:

- TypeScript **refuses to mix `bigint` and `number` in arithmetic**. `face * 0.9785` does not
  compile. Choosing `bigint` for money is the structural fix; one ESLint rule banning `Number(`
  and `parseFloat(` outside `src/core/units.ts` closes the explicit-conversion escape.
- `pg` returns `int8` as a **string** by default. `pg.types.setTypeParser(20, BigInt)` in
  `db.ts` is the single point where a float could otherwise enter. An ORM makes this decision
  invisibly and most choose `number`.
- JSON has no bigint, so base units cross the wire as decimal strings, parsed once by
  `parseBaseUnits`, per **boundary-discipline**.
- A CI query over `information_schema.columns` fails the build if any column in `app` or `ledger`
  is `numeric`, `real` or `double precision` (sole exception: `asset.token_id`, never arithmetic).

Percentages and yields are `Ratio { num, den }` of bigints, divided only at render. The PRD's
worked example reproduces exactly: F=2,500,000,000, P=2,446,250,000, d=90 →
discount 53,750,000; cost 1,961,875,000,000/225,000,000,000 = "8.7"; yield
1,961,875,000,000/220,162,500,000 = "8.9". Verified in integers before writing it down.

Rounding is never implicit. XSGD conversion rounds **up**, against the payer, and the remainder
lands in `system_fx` as a visible leg. USDC/USDT/XUSD conversion is the identity because all four
cash assets share the 4-decimal base unit, so three of the four funding paths cannot round at all.

### Does an ORM earn its place? No.

- The writes are one stored procedure. An ORM generates none of it.
- The reads are five screen-shaped projections with lateral joins, filtered aggregates and
  window functions. Any ORM either cannot express them or you drop to raw SQL anyway.
- An ORM models rows as mutable objects. The entire design is "you cannot mutate a balance". An
  ORM hands every contributor `wallet.balance = x` on day one — the defect, pre-installed.
- Prisma/Drizzle migrations cannot express deferred constraint triggers, partial unique indexes
  on generated columns, `SECURITY DEFINER`, or `REVOKE`. The constraints *are* the design, so an
  ORM that fights them is not a tool, it is an adversary.
- Interactive transactions hold a pooled connection across `await` points — a serverless
  connection-exhaustion hazard for no benefit, since the transaction is one statement.

**Instead:** `pg` + numbered `.sql` migrations + `zod` at the boundary + types generated *from*
the database (`kanel`) so the schema is the single source of truth for types, one direction, no
drift. A query builder (Kysely) for the read side would be defensible; it is not needed.

### Interface depth

Public surface: `post(Command)` returning `Result<Posted, PostFailure>`, and five `read.*`
functions. One union enumerates the entire write vocabulary of the system.

Hidden behind it: transactions, isolation, lock ordering, escrow accounting, FX and its rounding
direction, double-entry legs, idempotent replay, recheck-under-lock of ownership/balance/listing/
maturity, audit event emission, receipt minting, and the chain boundary. A route handler that
calls `post` does not import `pg`, does not know what a leg is, and *cannot* open a transaction.

`post` is not a god function masquerading as depth: the per-intent work is small, and what is
shared — idempotency, locks, receipts, events, the failure vocabulary — is genuinely common. The
alternative of `acceptBid()`, `transfer()`, `topUp()` as separate exports leaks that machinery
into every one of them, and the count of places that must get lock ordering right goes from one
to twelve.

Tracing any flow reads three files: route handler → `ledger/post.ts` → `ledger.post()`. Reads are
two: server component → `ledger/read.ts`.

---

## Module map

```
src/core/                 pure. no I/O, no framework, no clock, no database.
  units.ts                BaseUnits, Bps, Ratio, IsoDate, parse/format.
                          The only file permitted to call Number().
  money.ts                AssetRef, CashCode, Conversion, convert(). Rounding policy.
  pricing.ts              PricedQuantity, PricingView, priceView(), priceFromBps().
                          PRD §6, exactly, in integers. One calculation for the whole app.
  clock.ts                WorldClock, daysRemaining(). No zero-argument today().
  lifecycle.ts            ObligationState, Transition union, LifecyclePhase, MarketStatus,
                          phaseOf(). Illegal transitions do not type-check.
  intent.ts               Intent, Command, Actor, IdempotencyKey, the permission table.

src/ledger/               owns the invariants and atomicity.
  post.ts                 post(): the single write entry point. SQLSTATE -> PostFailure.
  read.ts                 marketplace / payableDetail / portfolio / settlementQueue /
                          receiptByHash / proveBooksBalance. One round trip each.
  db.ts                   Pool, setTypeParser(20, BigInt), SET LOCAL timeouts, bigint JSON guard.
  sql/0001_schema.sql     tables, constraints, deferred triggers, views  (= schema.sql)
  sql/0002_post.sql       ledger.post()
  sql/0003_seed.sql       PRD §12 seed + reset

src/chain/
  settler.ts              Settler interface. MockSettler now, SepoliaSettler + indexer later.
```

Module boundaries are drawn around knowledge, not execution order: `units` owns the integer
representation, `pricing` owns the arithmetic convention, `lifecycle` owns legality, `ledger` owns
atomicity and invariants, `chain` owns receipts. No load/validate/transform/save stages.

Type sketch and signatures: **`core.ts`**. DDL: **`schema.sql`**.

---

## Verification

`schema.sql` was loaded into a real PostgreSQL 16.13 and the invariants were exercised, rather
than asserted. Every claim below is a test that ran.

| # | Scenario | Result |
|---|---|---|
| 1 | Entry crediting a holder with no counterparty leg | rejected at COMMIT — `asset … is not conserved` |
| 2 | Balanced mint (supplier +2,500,000,000 / unissued −2,500,000,000) | committed; `v_holding` total = `v_payable_supply` |
| 3 | Transfer of 2,600,000,000 from a 2,500,000,000 holding | rejected — `wallet_balance_non_negative` |
| 4 | Listing opened without moving quantity into escrow | rejected — escrow ≠ open listings |
| 5 | Same listing with escrow legs in one transaction | committed; free 0 / listed 2,500,000,000, total unchanged |
| 6 | Second open listing by the same seller on the same payable | rejected — `one_open_listing_per_seller_target` |
| 7 | XSGD-funded trade: 6 legs across 3 assets, one entry | committed; `prove_books_balance()` returns 0 rows |
| 8 | Illegal lifecycle transition `issued → certified` | rejected by the edge trigger |
| 9 | Series member whose maturity differs from the series | rejected by the composite FK |
| 10 | Idempotency key replayed | rejected — unique violation (the posting function turns this into a replay) |
| 11 | Redemption of an already-redeemed holding | rejected — balance would go negative |
| 12 | Listing cancelled without returning the escrow | rejected; cancel + return in one transaction committed |
| 13 | **Two concurrent sessions accepting the same listing** | B blocked on `FOR UPDATE`, re-read `filled`, refused. Exactly one trade; books balanced |
| 14 | CI scan for `numeric`/`real`/`double precision` | 0 columns |
| 15 | `core.ts` under `tsc --strict` | clean |
| 16 | `face * 0.9785` and `face * days` where `face: BaseUnits` | **both are compile errors** — `TS2365: Operator '*' cannot be applied to types 'BaseUnits' and 'number'`. `(face * 9785n) / 10000n` compiles |
| 17 | PRD §6 worked example in pure integer arithmetic | 244,625.0000 proceeds · 5,375.0000 discount · 8.7% cost · 8.9% yield — exact, no remainder |

Row 16 is the whole floating-point argument, discharged: a contributor does not need to know the
rule, because the code that breaks it does not build.

Running it found three defects in the first draft that reading it did not:

1. `CREATE CONSTRAINT TRIGGER … FOR EACH STATEMENT` is not valid Postgres — constraint triggers
   must be `FOR EACH ROW`. Fixed by scoping each check to the row's own wallet or asset, which is
   a better shape anyway: two indexed lookups instead of a table scan.
2. `v_trade` derived the seller from the cash *debit*, which is correct only when funding is
   XUSD — under XSGD the debit is in XSGD and sits against the FX book, so the view named the
   buyer as the seller and returned two rows. Fixed to derive the seller from the token debit.
3. **`SUM(bigint)` returns `numeric` in Postgres**, so the holding and series views were exposing
   exactly the type the design claims to ban — and `numeric` reaches node-postgres as a string,
   which is where the first `parseFloat` would have appeared. Fixed with explicit `::bigint`
   casts, and the CI scan now deliberately covers views, since a forgotten cast in a new
   aggregate is the most likely future recurrence.

Point 3 is the reason the float ban is written as a query against `information_schema` rather
than as a rule in a style guide.

---

## Rationale

### Problem

We need the money-and-ownership core of a demo that a bank will watch over someone's shoulder, on
a stack (Vercel serverless) with no process state, no long-lived locks, and normal cold starts,
inside a 500–2000 ms budget. Four things make the shape non-obvious. Quantities are integers and
a single float anywhere is a defect, in a language whose default numeric type is a float. Holdings
must sum to outstanding face across concurrent transfers, trades and redemptions, and that is a
cross-row aggregate no `CHECK` can express directly. Multi-effect operations (debit buyer, credit
seller, move quantity, close listing, expire bids) must be atomic, and maturity settlement must
fan out to every current holder. And the whole thing is ported to Sepolia later, where the chain
becomes the source of truth for balances and the database becomes an indexer of events — which
means a design that treats balances as primary is a design that gets rewritten.

The PRD itself contains the tension: §13 hands us both an `Event` table and
`Wallet.balances_by_asset`. It also contains a smaller one: §8 screen 13 says reject a transfer
that exceeds the unlisted holding, while §9 says a transfer that drops the holding below the
listed quantity must close the listing. Both are honoured; the resolution is in the type, below.

### Usage (caller's view)

See [Usage](#usage-callers-view) above — written first; the types in `core.ts` were derived from
those three call sites, not the other way round. Two places where the usage changed the types:
`settle_maturity` carries no holder list, because writing the call site made it obvious that
passing one means reading it outside the lock; and `transfer` carries an explicit
`onListingConflict` field, because writing the transfer screen made the §8/§9 tension visible and
burying it in whichever rule the implementer read last would be a silent behavioural coin flip.

### Shape

See [Shape](#shape) above.

### Synthesis decision

*Filled in by arena.*

### Tradeoffs accepted

- **We accept plpgsql in the money path in exchange for one lock ordering and one round trip.**
  The logic that must run under a lock (holder enumeration, ownership recheck, escrow moves)
  cannot live in TypeScript without reading contended state before locking it. Putting it in the
  database is what makes "one total lock order, written once" true. The cost is a second language,
  no stack trace into TS, and slower refactoring.
- **We accept a materialised balance table in a design whose thesis is "derive, don't sync"** —
  because it is the lock target and the `CHECK` target, not a cache, and
  `ledger.prove_books_balance()` asserts it equals the journal. Without it, overdraft prevention
  becomes a procedure instead of a constraint.
- **We accept that quantities live in two accounts per wallet (free, listed)** in exchange for
  deleting "available = balance − locked" arithmetic from every call site and turning four PRD
  rules into one deferred equality.
- **We accept that `matured` and `overdue` are not stored** even though PRD §7 draws them as
  lifecycle states, in exchange for never running a sweeper and never showing a stale status after
  fast-forward.
- **We accept that all four cash assets use a 4-decimal base unit** (real USDC is 6) in exchange
  for three of four funding paths being exactly unroundable.
- **We accept `bigint` ergonomics** — `10_000n`, no `Math.*`, manual formatting — in exchange for
  floats being a compile error rather than a code-review item.
- **We accept that correcting bad data requires a correcting entry or a world reset.** There is no
  `UPDATE balance`. For a resettable demo this is cheap; it would not be in production.

### What this design makes hard

Naming these plainly, because they are real:

1. **plpgsql.** Testing and refactoring the posting function is slower than TypeScript.
   Mitigation is a vitest suite against real Postgres 16 plus `prove_books_balance()`, but the
   friction does not go away.
2. **Ad-hoc fixes.** You cannot nudge a balance. Every correction is an entry or a reset.
3. **Deleting users.** PRD §5 lets the admin delete accounts. An append-only ledger cannot forget
   a wallet that holds tokens without breaking conservation. This becomes deactivation, or a
   forced return of holdings first. Flagged below.
4. **Historical balance queries.** "What did this wallet hold on day 30?" means summing the
   journal to a seq. Nothing in the PRD needs it, but a portfolio history chart would.
5. **The first two days produce nothing visible.** Constraints and the posting function come
   before any screen. That is a scheduling risk on a fixed demo date.

### Where this would be the wrong choice

If the deliverable were a five-day click-through driven by one presenter on one laptop with no
real concurrency, this is three times the work of `UPDATE wallet SET balance = balance - $1`
inside a transaction, and the extra machinery buys nothing anyone will see. It is also wrong if
the team has no Postgres depth and the date is immovable — the approach front-loads exactly the
skills that would be scarce. And it is wrong if the Sepolia port is cancelled *and* audit history
is downgraded to nice-to-have: strip those two and the justification collapses to an aesthetic
preference for double entry.

Honest note on the port itself: after Sepolia, the chain enforces non-negativity and conservation,
so this schema's `CHECK`s become assertions and the posting function becomes a submitter plus a
reconciler. The projection, the views and every screen survive; the enforcement layer changes
role. That is a swap of one module, but a reconciler is new code, and nothing here pretends the
port is free.

### Alternatives considered

**Mutable `wallet.balances_by_asset` + `holding.quantity`, updated inside one SERIALIZABLE
transaction, with an `event` table written alongside.** Simplest to start and closest to the
PRD's literal §13. Lost on interface depth *and* on correctness: it exposes "which rows must I
update together" to every caller, so every new operation is a fresh chance to forget one; the sum
invariant has no enforcement point; and the event table is written by the same code that writes
the balances, making it a second truth that can silently disagree — the exact thing the audit
requirement exists to prevent. The Sepolia port rewrites every mutation site.

**Pure event sourcing with aggregates and optimistic concurrency (expected version).** Hides the
most complexity of the three on paper. Lost because serverless has no process state: every
request replays or reads a snapshot, and the snapshot table is this design's projection with
fewer constraints. Its concurrency model turns every contended Accept into a retry, which is the
demo failure we most want to avoid, and its payoff (retroactive projections, temporal queries) has
no customer in this PRD.

**Double-entry with balances derived by `SUM()` and no materialised table, under SERIALIZABLE.**
The purest version of the chosen thesis. Lost because there is nothing to lock and nothing to
`CHECK`: overdraft prevention becomes entirely SSI's job, a `40001` on a double-clicked Accept
during the pitch is the precise failure mode we are designing out, and the marketplace's holder
breakdown becomes an aggregate per row.

**Prisma or Drizzle over any of the above.** Lost because the constraints are the design, and no
ORM's migration layer can express deferred constraint triggers, partial unique indexes on
generated columns, `SECURITY DEFINER` or `REVOKE`. It would hide one thing (hand-written SELECTs)
and expose two (mutable row objects, multi-round-trip transactions).

### Open questions and risks

- **User deletion vs an append-only ledger.** PRD §5 says the StraitsX admin can delete other
  users. Should deletion be refused while a wallet holds any non-zero balance, or should it force
  a transfer of holdings back to the anchor first? I have assumed deactivation (`deactivated_at`)
  with deletion refused, but this is a product call.
- **One world or several.** The PRD specifies a shared world and says reset affects all sessions.
  I have taken that literally and added a `world.epoch` so a stale tab can detect a reset. But a
  booth with two laptops demoing independently would need `world_id` in every primary key —
  cheap now, a full-schema migration later. Is simultaneous independent demoing a real
  requirement?
- **Should `system_fx` drift be visible?** Rounding up against the payer means the FX account
  accumulates a few base units. That is correct and auditable, but do we want it on the StraitsX
  oversight screen, or is it noise in a demo?
- **Does the Series grade override member grades for pricing display?** PRD §6 says the series
  grade is assigned explicitly by the admin, but members carry their own. Which one does a series
  marketplace row show?
- **Risk: `lock_timeout` tuning.** 1 s is a guess. Too low and a legitimate slow operation surfaces
  as `contended` during the pitch; too high and a genuine wedge looks like a hang. Wants one
  measurement against the real booth network, not a value chosen here.
- **Risk: pooler compatibility.** `SET LOCAL` and `SECURITY DEFINER` are both fine under
  transaction pooling, but `DEFERRABLE` constraint triggers need the whole operation in one
  transaction, which it is. Worth verifying against the actual hosted Postgres before stage 2.

### Next implementation step

Write `ledger.post()` for exactly two intents — `issue` and `transfer` — against the already-
verified schema, and port the 14 ad-hoc SQL checks from [Verification](#verification) into a
vitest suite that drives them through `post()` instead of raw inserts. Those two intents exercise
the whole machine (idempotency gate, lock order, escrow, projection, receipt), so everything
after them is filling in the `Intent` union.
