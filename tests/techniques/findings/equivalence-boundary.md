# Findings: equivalence partitioning and boundary value analysis

Suite: `tests/techniques/equivalence-boundary.test.ts`
Technique: equivalence partitioning plus boundary value analysis over field
validation, in two layers: the pure validators in `src/core`, and the field
guards inside `ledger.post()`.

292 cases. 283 pass. 9 run under `it.fails` because the system does not do what
its own guard says it does; those are EB-01, EB-02, EB-03, EB-06, EB-07, EB-08
and EB-09 below. Nothing in `src/` or `db/` was changed to write this suite. See
`tests/techniques/README.md` on what a **FIXED** entry means.

Three further findings (EB-04, EB-05, EB-10) are pinned by ordinary passing
cases rather than by `it.fails`, because the observed behaviour is arguable
rather than plainly wrong, and pinning it means a future change to it has to be
deliberate. They are written up here so the choice is visible.

Every defect below was reached by the same method: take a field, name its valid
and invalid partitions, then probe each numeric or length boundary as a triple
of just-below, on, and just-above. The holes are all in partitions the guards
never considered: the absent value, the non-number, and the calendar.

---

## EB-01 `parseIsoDate` accepts dates that do not exist

**File:** `src/core/clock.ts`, `parseIsoDate`

**Reproduction**

```ts
parseIsoDate('2026-02-29');   // returns '2026-02-29'
parseIsoDate('2026-02-30');   // returns '2026-02-30'
parseIsoDate('2026-04-31');   // returns '2026-04-31'
```

**Expected:** all three throw `RangeError: not a real calendar date: <value>`.
2026 is not a leap year, no February has a 30th, and April has 30 days. The
function carries a second guard whose entire purpose is this check:

```ts
const ms = Date.parse(`${value}T00:00:00Z`);
if (Number.isNaN(ms)) {
  throw new RangeError(`not a real calendar date: ${value}`);
}
```

**Observed:** all three are returned unchanged and branded as `IsoDate`. V8's
`Date.parse` falls back to a lenient parser for an out-of-range day and rolls it
over instead of returning `NaN`.

**What the guard does still catch.** The boundary probes pin exactly how far it
reaches. Rejected: `2026-00-01`, `2026-13-01`, `2026-01-00`, `2026-12-32`. So
the month is validated against 1..12 and the day against 1..31, but the day is
never validated against the length of its month.

**Why it matters.** The brand is a promise that downstream date arithmetic is
safe, and the value silently changes identity the moment it is used:

```ts
addDays(parseIsoDate('2026-02-30'), 0);   // '2026-03-02'
addDays(parseIsoDate('2026-02-29'), 0);   // '2026-03-01'
```

A maturity date entered as 29 February 2026 therefore parses, stores and then
reads back as 1 March, two days after the date anybody typed, and `daysBetween`
computes the tenor from the rolled-over value. `market.parseFilter`'s `by`
parameter checks only the shape and hands the same string on as an `IsoDate`,
so a marketplace link carrying `by=2026-02-30` inherits the hole.

**Cases:** three `it.fails` rows under `clock.parseIsoDate(value)`, plus
passing rows pinning the four values the guard does reject and the
`market.parseFilter(params).maturityBy` row that inherits it.

---

## EB-02 `formatUnits` accepts a NaN `decimals` and renders a trailing point

**File:** `src/core/money.ts`, `formatUnits`

**Reproduction**

```ts
formatUnits(fromBaseUnits(12345n), NaN);   // returns '1.'
```

**Expected:** `RangeError: decimals must be between 0 and 4`, the same refusal
`-1` and `5` get.

**Observed:** `'1.'`, a number with a decimal point and no decimals after it.

**Cause.** The guard is `if (decimals < 0 || decimals > DECIMALS)`. Both
comparisons are false for `NaN`, so `NaN` passes a range check it belongs
outside of. `roundFractionText` then does `fractionText.slice(0, NaN)`, which is
`''`, and the suffix branch is `decimals === 0 ? '' : '.' + shown.text`, which
takes the `.` path because `NaN !== 0`.

**Related, pinned but not filed as a defect.** `formatUnits(v, 2.5)` also passes
the range check and returns `'1.23'`, silently coercing a non-integer to 2. That
is harmless today but has the same root: the guard bounds the value without
establishing that it is an integer first.

**Cases:** one `it.fails` row plus the `-1 / 0 / 4 / 5` boundary quadruple and
the `2.5` row under `money.formatUnits(value, decimals)`.

---

## EB-03 `allocateProRata` guards the sum of the weights, not each weight

**File:** `src/core/money.ts`, `allocateProRata`

**Reproduction**

```ts
allocateProRata(fromBaseUnits(100n), [fromBaseUnits(-5n), fromBaseUnits(10n)]);
// returns [-100n, 200n]
```

**Expected:** `RangeError: allocateProRata needs at least one positive weight`.

**Observed:** `[-100n, 200n]`. One holder is allocated a negative amount and the
other is allocated twice the total being split.

**Cause.** The guard is on the total:

```ts
const weightTotal = weights.reduce<bigint>((acc, w) => acc + w, 0n);
if (weightTotal <= 0n) { throw new RangeError(...); }
```

so a negative weight passes whenever some other weight outweighs it. The
boundary triple makes the shape of the guard exact: `[10n, -11n]` (sum -1) is
refused, `[10n, -10n]` (sum 0) is refused, `[10n, -9n]` (sum 1) is accepted and
returns `[1000n, -900n]`.

**Why it matters.** The function's stated job is maturity settlement, paying
each current holder in proportion to quantity held. A negative allocation is a
debit dressed up as a payout. Holdings cannot go negative today, so no caller
reaches this, but the function's contract is what the next caller will read.

**Cases:** one `it.fails` row, plus the sum boundary triple, the empty array,
and a zero weight alongside a positive one.

---

## EB-04 `fromBaseUnits` guards only one of its three input types

**File:** `src/core/money.ts`, `fromBaseUnits`

**Not filed as a failing case.** Pinned by passing rows, because two of the
three behaviours are ordinary `BigInt()` semantics rather than a broken guard.
Recorded because a reviewer should see the asymmetry stated rather than
discover it.

The `number` path checks `Number.isSafeInteger`. The `string` and `bigint` paths
check nothing:

| input | result |
| --- | --- |
| `9007199254740992` (number, one past MAX_SAFE_INTEGER) | `RangeError: base units must be a safe integer, received 9007199254740992` |
| `'9007199254740993'` (string, further past it) | `9007199254740993n`, accepted |
| `9007199254740993n` (bigint) | `9007199254740993n`, accepted |
| `1.5` (number) | `RangeError: base units must be a safe integer, received 1.5` |
| `'1.5'` (string) | `SyntaxError: Cannot convert 1.5 to a BigInt` |
| `'abc'` (string) | `SyntaxError: Cannot convert abc to a BigInt` |
| `''` (string) | `0n` |

Two consequences worth naming. First, the same malformed value produces a domain
`RangeError` with an explanatory message on one path and a raw `SyntaxError`
from the engine on another, so a caller writing `catch (e)` around the boundary
parser cannot rely on the error type. Second, `fromBaseUnits('')` is `0n`: an
empty column or an empty form field becomes a silent zero amount rather than a
refusal. `parseUnits('')` refuses the same input with
`not a decimal amount: ""`, so the two boundary parsers in the same module
disagree about the empty string.

**Cases:** eleven passing rows under `money.fromBaseUnits(value)`, including the
safe-integer boundary triple on the number path and the same triple on the
string and bigint paths showing it does not apply there.

---

## EB-05 `quote` validates face but not price

**File:** `src/core/pricing.ts`, `quote`

**Not filed as a failing case.** `quote`'s doc comment constrains `face` and
`daysRemaining` and says nothing about `price`, so the current behaviour is not
contradicting a stated rule. Pinned so that a change to it is deliberate.

`face` is refused at zero and below, with `RangeError: face must be positive`.
`daysRemaining` is refused when not whole. `price` is taken as given:

```ts
quote(fromBaseUnits(1_000_000n), fromBaseUnits(0n), 30);
// discount 1000000n, pricePercent 0,
// annualisedDiscountCostPercent 1216.6666666666665,
// lenderYieldPercent null

quote(fromBaseUnits(1_000_000n), fromBaseUnits(-50n), 30);
// discount 1000050n, pricePercent -0.005,
// annualisedDiscountCostPercent 1216.7275,
// lenderYieldPercent null
```

Two things to note at the `price === 0n` boundary. The two annualised measures
disagree about whether the quote is meaningful: `lenderYieldPercent` is null,
guarded by `isPositive(price)`, while `annualisedDiscountCostPercent` is a
number, because its denominator is `face`. A screen that renders both shows a
financing cost of 1216.67% next to a blank yield for the same row. And at a
negative price the discount exceeds the face it was derived from, while
`isAbovePar(face, price)` is `false`, so nothing else in the module flags the
row either.

Two further asymmetries in the same module, also pinned:

- `percentOfFace` and `quote` both refuse a non-positive face but with different
  text: `face must be positive to express a price as a percentage of it` versus
  `face must be positive`. `quote` calls `percentOfFace` internally, so only its
  own message can ever reach a caller of `quote`.
- `priceFromPercent` does not validate `face` at all: `priceFromPercent(0n, 9785)`
  returns `0n` where the other two throw.

**Cases:** ten passing rows across `pricing.quote`, `pricing.percentOfFace` and
`pricing.priceFromPercent`, including the `-1 / 0 / 1` face triple on both
guarded functions.

---

## EB-06 `top_up` with `amountBase` absent is accepted and writes a legless entry

**File:** `db/post.sql`, the `top_up` branch and `ledger.post_legs`

**Reproduction**

```ts
await post(pool, { kind: 'top_up', wallet: someWallet, cashCode: 'USDC' });
```

**Expected:** `ADA19`, `a top-up must be positive`. The field is the amount
being minted; absent is not a valid amount.

**Observed:** accepted. A `top_up` row is appended to `ledger.journal_entry`
(the count goes from 10 to 11 on a fixtures database) carrying zero legs, and
the receipt reports success:

```json
{"seq":15,"kind":"top_up","legs":[],
 "receipt":{"status":"confirmed","txHash":"0xc487e0...","simulated":true,
            "blockNumber":15},
 "replayed":false,"worldDate":"2026-09-15","conversion":null}
```

**Cause.** Two NULL propagations in sequence.

```sql
v_qty := (v_intent->>'amountBase')::bigint;   -- NULL when the key is absent
IF v_qty <= 0 THEN ... END IF;                -- NULL <= 0 is NULL, not true
```

so the guard does not fire. The legs are then built with a NULL amount, and
`ledger.post_legs` filters them out at the end:

```sql
INSERT INTO ledger.journal_leg (...)
SELECT ... , SUM(amount)::bigint
  FROM unnest(p_legs) GROUP BY account_id, asset_id
HAVING SUM(amount) <> 0;
```

`SUM(amount)` is NULL, `NULL <> 0` is NULL, and the row is not inserted. The
entry commits with no legs at all.

**Why it matters.** The books stay balanced, so the oracle does not catch it:
the suite asserts `ledgerHealth` after this case and it is `HEALTHY`. An entry
with no legs trivially balances. What is wrong is the audit trail and the
receipt. The journal is the system's record of what happened, and it now
contains a confirmed top-up with a transaction hash and a block number that
moved no money. The same NULL path exists for `transfer.quantityBase`, but there
it cannot be reached: an unknown `payableId` fails the FK on `journal_entry`
first, and a known one still builds legs whose amounts are NULL.

**Case:** one `it.fails` row under `top_up.amountBase`, alongside the passing
`-1 / 0 / 1` boundary triple.

---

## EB-07 `set_certification` with `status` absent leaks a NOT NULL violation

**File:** `db/post.sql`, the `set_certification` branch

**Reproduction**

```ts
await post(pool, { kind: 'set_certification', entityId: someEntity });
```

**Expected:** `ADA19`. The branch already has a message for a status outside the
enum, and absent is outside the enum.

**Observed:** `23502`,
`null value in column "certification_status" of relation "entity" violates not-null constraint`.

**Cause.** The same NULL propagation as EB-06:

```sql
IF (v_intent->>'status') NOT IN ('uncertified', 'certified', 'suspended') THEN
  RAISE EXCEPTION 'unknown certification status %', ... USING ERRCODE = 'ADA19';
END IF;
```

`NULL NOT IN (...)` is NULL, so the guard does not fire, and the UPDATE reaches
the table with a NULL. The refusal a caller sees names a column rather than the
field they left out.

**What the guard does catch.** The partitions either side are correct:
`'uncertified'`, `'certified'` and `'suspended'` are accepted; `'pending'`,
`'CERTIFIED'` and `''` are refused with `ADA19` and the message
`unknown certification status <value>`. Only the absent partition escapes.

**Case:** one `it.fails` row under `set_certification.status`, alongside six
passing rows covering the rest of the partition set.

---

## EB-08 `btrim` strips only spaces, so a tab-only `invoiceRef` is accepted

**File:** `db/post.sql`, the manual branch of `create_payable`

**Reproduction**

```ts
await post(pool, { kind: 'create_payable', supplierId, ref: 'TP-WS-1',
                   invoiceRef: '\t', faceBase: 100, termsDays: 30 });
```

**Expected:** `ADA25`, `an invoice reference is required`, the same refusal
`''` and `'   '` get.

**Observed:** accepted. `app.payable.invoice_ref` is stored as `"\t"`.

**Cause.** `btrim(text)` with one argument removes spaces only, not tabs,
newlines or other whitespace:

```sql
v_invoice_ref := btrim(COALESCE(v_intent->>'invoiceRef', ''));
...
IF v_invoice_ref = '' THEN
  RAISE EXCEPTION 'an invoice reference is required' USING ERRCODE = 'ADA25';
END IF;
```

**Why it matters.** The invoice reference is half the key of
`payable_one_per_invoice`, the unique index that stops one supplier's invoice
being financed twice. A reference of `"\t"` is a distinct key, so a second
whitespace-only reference of a different flavour, a newline say, would create a
second financeable payable that a human reading either row cannot tell apart.
The boundary is sharp: `' '` is refused, `'\t'` is accepted.

**Case:** one `it.fails` row under `create_payable.invoiceRef`, alongside the
passing empty, spaces-only, absent, one-character, padded and duplicate rows.

---

## EB-09 `advance_clock` with `days` absent leaks a NOT NULL violation

**File:** `db/post.sql`, the `advance_clock` branch

**Reproduction**

```ts
await post(pool, { kind: 'advance_clock' });
```

**Expected:** `ADA19`, `the demo clock only moves forward`.

**Observed:** `23502`,
`null value in column "offset_days" of relation "world" violates not-null constraint`.

**Cause.** `IF v_days < 0` is NULL for an absent `days`, so
`UPDATE app.world SET offset_days = offset_days + v_days` runs with a NULL and
the column constraint refuses it. The statement rolls back, so the world is not
corrupted; the cost is a refusal that names an internal column instead of the
field. The `-1 / 0 / 1` triple around the guard is otherwise correct, with
`0` accepted as a no-op.

**Case:** one `it.fails` row under `advance_clock.days`.

---

## EB-10 Type coercion at the JSON boundary reports as a cast error, not a domain code

**Not filed as failing cases.** Pinned by passing rows. Each of these is a
refusal, so nothing incorrect is written; the finding is that the caller gets a
Postgres cast error where a domain code exists for the very same field.

| command and field | input | code and message |
| --- | --- | --- |
| `create_payable.termsDays` | `30.7` | `22P02` `invalid input syntax for type integer: "30.7"` |
| `top_up.cashCode` | `"EURC"` | `22P02` `invalid input value for enum ledger.cash_code: "EURC"` |
| `envelope.idempotencyKey` | `"not-a-uuid"` | `22P02` `invalid input syntax for type uuid: "not-a-uuid"` |
| `create_payable.ref` | absent | `23502` `null value in column "ref" of relation "payable" violates not-null constraint` |

`termsDays` is the sharpest of the four: the branch has `ADA23`,
`payment terms must be between 1 and 365 days`, for that exact field, and
`0`, `366`, `-1` and absent all get it. Only a non-integer is answered with a
cast error, because `(v_intent->>'termsDays')::int` runs before the range check.
`create_payable.ref` is the only one of the four with no domain code at all,
where `invoiceRef` beside it has `ADA25`.

One more coercion asymmetry, in TypeScript rather than SQL.
`market.parseFilter({ smin: '0.00005' })` returns `1n`: a size below one base
unit is rounded up to one rather than refused, while `money.parseUnits('0.00005')`
throws `0.00005 needs more than 4 decimals; amounts between base units are not
representable` for the same quantity. Both are boundary parsers for amounts a
human typed. `parseFilter` rounding is defensible on its own terms, since it
documents that a bad browse filter should degrade rather than error, but the two
rules should be a decision rather than an accident.

---

## Partition and boundary coverage

Layer 1, `src/core`, 54 fields:

- `money.parseUnits` shape partitions and the 4-decimal boundary, including the
  case where digits past 4 are all zero
- `money.fromWholeUnits` and the number path of `money.fromBaseUnits` at
  `MAX_SAFE_INTEGER - 1 / MAX_SAFE_INTEGER / MAX_SAFE_INTEGER + 1`
- `money.roundDiv` denominator at `-1n / 0n / 1n`, and half-away-from-zero at
  just under, exactly, and just over one half in both signs
- `money.allocateProRata` weight sum at `-1 / 0 / 1`
- `money.formatUnits` decimals at `-1 / 0 / 4 / 5`, and the rounding digit at
  four, five and the carry into the whole part
- `fx.convert` rate at `-1n / 0n / 1n` for XSGD, and the same rates for the 1:1
  assets showing the asset check runs first
- `pricing.priceFromPercent` bps at `-1 / 0 / 1` with no upper bound at 12000
- `pricing.percentOfFace` and `pricing.quote` face at `-1n / 0n / 1n`
- `pricing.quote` days at `-1 / 0 / 1`, and price at `-50n / 0n / face`
- `pricing.priceForTargetYield` days at `-1 / 0 / 1`
- `clock.parseIsoDate` month at `00 / 01 / 12 / 13`, day at `00 / 31 / 32`, and
  the February and April limits
- `clock.addDays`, `clock.clockAt` and `clock.advance` at `-1 / 0 / 1`, showing
  the three functions disagree about whether negative is legal
- `market.parseFilter` size at `-1 / 0 / 250000`, tenor truncation in both
  signs, and each field's unparseable partition
- `market.applyFilter` inclusive bounds on tenor, size, yield and maturity, and
  all five sort orders

Layer 2, `ledger.post()`, 13 fields:

- `envelope.idempotencyKey` absent, malformed, valid
- `envelope.intent.kind` absent, empty, wrong case, unknown
- `top_up.amountBase` at `-1 / 0 / 1`; `top_up.cashCode` in and out of the enum
- `transfer.quantityBase` at `-1 / 0 / 1`, and at the holding boundary
  `500 / 501` against a 500 base unit payable
- `create_payable.termsDays` at `0 / 1 / 365 / 366`
- `create_payable.faceBase` at `-1 / 0 / 1`
- `create_payable.invoiceRef` empty, spaces, absent, one character, padded,
  duplicate
- `create_payable.supplierId` unknown and wrong entity type;
  `create_payable.ref` duplicate and absent
- `set_programme_limit.limitBase` at `-1 / 0 / 1`, plus null and absent
- `set_certification.status` all three enum members plus four invalid partitions
- `advance_clock.days` at `-1 / 0 / 1`

Every layer 2 case ends by asserting `ledgerHealth(pool)` equals `HEALTHY`,
inline and again in `afterEach` so the rows that run under `it.fails` are held
to it too. It was `HEALTHY` after every one, including after EB-06 wrote its
legless entry, which is why that defect needed a partition table to find rather
than the oracle.
