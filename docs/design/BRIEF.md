# Design brief — ADATA tokenised payables engine

Greenfield. No existing code. The only input is `tokenised-payable-prd.md` at the repo root.
Read PRD sections 6, 7, 9, 10, 12 and 13 in full before designing. They are the binding constraints.

## What you are designing

The **domain core and its persistence model** only. Not the screens, not the styling, not the
HTTP routing. The core is the part that owns money, ownership, and lifecycle. Everything else
is a thin shell over it.

Deliver a design package per `.claude/skills/architect/references/rationale-template.md`:
README-style usage with two or three real call sites first, then the type sketch derived from
that usage, then the module map, then the rationale. Bodies are `not implemented`; tricky logic
is `// TODO` pseudocode. A reader must be able to trace data from input to output by reading
types and signatures alone.

## Fixed stack constraints

- TypeScript, Next.js App Router, deployed to Vercel (serverless, so no in-process state between
  requests, no long-lived locks, cold starts are normal).
- PostgreSQL is the only durable store. A real local Postgres 16 is available for testing.
- No blockchain. Chain artifacts (tx hash, block number, receipt) are simulated, but the PRD says
  this platform is later ported to Sepolia for real transactions. Design the mock-chain boundary
  so that port is a swap, not a rewrite.

## The hard problems, in priority order

1. **Quantities are integers.** PRD section 6: XUSD 1.0000 face = 10,000 base units; the minimum
   increment is one base unit. Every quantity, price, and balance is a whole number of base units.
   Floating point anywhere in the money path is a defect. Decide how this is enforced so a later
   contributor physically cannot introduce a float, and how it is stored in Postgres.

2. **The sum invariant.** PRD sections 7 and 13: holdings for a payable must sum to that payable's
   outstanding face until redemption. This must survive concurrent transfers, trades and
   redemptions. Decide whether it is enforced by the schema, by a constraint, by the transaction
   shape, or by a check, and say why the weaker options were rejected.

3. **Atomic multi-effect operations.** A trade settlement must, as one operation: debit the buyer's
   funding asset, credit the seller in XUSD, move the traded quantity, close the listing, and
   expire competing bids. Maturity settlement must debit ADATA once and credit every current
   holder pro-rata. A failure leaves balances and ownership unchanged.

4. **Idempotency.** PRD section 7: "Idempotency is required and important for all transaction,
   similar to how a blockchain will behave." Repeated confirmation must not duplicate a payment.
   Decide the mechanism and where the key comes from. Note that serverless retries and a
   double-clicked button are the realistic sources of a replay.

5. **Concurrency.** PRD section 14: prevent duplicate acceptance, double spending, over-quantity
   transfers, stale-owner transfers, and duplicate redemption *across sessions*. Two lenders
   accepting the same listing at the same instant must produce exactly one trade. State your
   isolation level and your locking order, and justify them. A lost update here is the worst
   possible demo failure in front of a bank.

6. **Balances: stored or derived?** The PRD gives both an `Event` table and a
   `Wallet.balances_by_asset` field. Decide between a mutable balance column, a double-entry
   ledger with derived balances, or event sourcing. Argue the tradeoff against the Sepolia port,
   the audit-history requirement in section 10, and the 500-2000ms performance budget in
   section 14. This is the central fork. Take a real position.

7. **Lifecycle as a structure, not booleans.** PRD section 7 gives an explicit state machine
   (Draft, Pending approval, Approved, Certified, Issued, Matured, Settled, Overdue) and insists
   obligation status is separate from market status. Encode both so an illegal transition or an
   illegal combination does not compile.

8. **The demo clock.** Days remaining, yields and due status are all derived from a mutable
   world clock that any persona can fast-forward. Nothing time-derived may be stored stale.

## Pricing, exactly

From PRD section 6, where `F` and `P` are the face and price of *the quantity being priced*:

- Price (% of face) = `100 * P / F`
- Discount amount = `F - P`
- Annualised discount cost (% of face) = `100 * (F - P) / F * 365 / d`
- Lender implied annualised yield (% of purchase price) = `100 * (F - P) / P * 365 / d`

Actual/365, no compounding, no fees. At or after maturity show "Due" or "Overdue" rather than a
forward yield. The worked example that every screen must reproduce: face 250,000 XUSD, 90 days
remaining, price 97.85% gives 244,625 proceeds, 5,375 discount, 8.7% annualised cost, 8.9% yield.

## Rules a design is wrong if it breaks

- A wallet may hold a partial quantity; multiple holders exist only after a sale or transfer.
- Listed quantity is locked to its listing. A transfer that would drop the holding below the
  listed quantity must close the listing and expire its bids as part of that same transfer.
- A wallet may have only one active listing per payable or series.
- Bids do not reserve funds. Balance, ownership, listed quantity, listing status and maturity are
  all rechecked at acceptance. Insufficient funds leaves bid, balances and position unchanged.
- Funding conversion: USDC, USDT and XUSD are 1:1 to XUSD. XSGD uses a fixed per-world rate of
  1 XUSD = 1.31 XSGD, so `source debit = XUSD obligation / rate`. The recipient always gets XUSD.
- A series moves as one lot. Every member must be wholly held by the same wallet and share a
  maturity date. Programme totals must not double-count series members.
- Chain-relevant actions (issuance, trade settlement, transfer, redemption, top-up) get a
  simulated receipt. Approval, grading, listing, and bid placement are audit events with no receipt.
- Reset restores the entire world including the clock and the FX rate.

## What to argue, not just assert

The orchestrator picks a base by comparing candidates, so differences are the signal. Do not
converge on a safe middle. Take a position on the stored-vs-derived balance fork, on the isolation
level, and on whether an ORM earns its place here at all. Name what your design makes hard, and
name the case where it would be the wrong choice.
