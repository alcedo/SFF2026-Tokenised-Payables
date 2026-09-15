# Findings from `tests/techniques/properties.test.ts`

Property-based and metamorphic testing over `src/core/`. Every counterexample
below was shrunk by fast-check from a run of 500 generated values at seed
`20260915`, so each one reproduces exactly by running the suite.

Nothing in `src/` or `db/` was changed. The three defects are recorded as
`it.fails(...)` cases in the suite, which therefore runs green while still
carrying the evidence.

Reproduce all three with:

```
npx vitest run tests/techniques/properties.test.ts
```

---

## 1. `formatUnits` produces a string `parseUnits` refuses, from 1,000 units up

**File:** `src/core/money.ts`, `formatUnits` (the `toLocaleString('en-US')`
call) against `parseUnits` (the `^(-?)(\d+)(?:\.(\d*))?$` regex).

**Suite case:** `money parsing round-trips > round-trips through its own display format`.

**Shrunk counterexample:** `10000000n`, which is 1,000.0000 display units.

**Reproduction:**

```ts
parseUnits(formatUnits(fromBaseUnits(10_000_000n), 4));
// RangeError: not a decimal amount: "1,000.0000"
```

**Expected:** a value formatted by this module parses back to itself. The two
functions are the only writer and the only reader of the module's own decimal
representation, and `parseUnits` is documented as "the boundary parser for
anything a human typed", which includes anything a human copied off a screen.

**Observed:** `formatUnits` groups the whole part with `toLocaleString('en-US')`
and emits `1,000.0000`. The `parseUnits` regex has no comma in it, so it throws.
The failure starts at exactly 10,000,000 base units and applies to every larger
amount, in both signs. Below that threshold the round trip holds, which is why
the existing example tests do not catch it: 9,999,999 base units formats to
`999.9999` and parses cleanly.

Every amount the demo actually shows is above the threshold. The runbook
invoice in `db/fixtures.sql` is 2,500,000,000 base units, which formats to
`250,000.0000`.

**Scope:** this is a round-trip defect, not a display defect. Nothing in `src/`
currently feeds `formatUnits` output back into `parseUnits`, so no screen is
broken today. What it costs is that the formatted value cannot be used as an
input anywhere, so any future paste-a-figure field, CSV export re-import, or
copied URL parameter has to strip separators first. The suite pins the repaired
form to show the grouping is the whole of the problem:

```ts
parseUnits(formatUnits(value, 4).replace(/,/g, '')) === value  // holds for all values, both signs
```

**Update after merging main.** `src/core/input.ts`, added on main by PR #11
while this branch was running, calls `stripCommas` before `parseUnits` in
`parseAmount`. That is the repaired form above, applied at the form boundary,
so a figure pasted off a screen into a form now parses. The asymmetry inside
`money.ts` is unchanged: `formatUnits` output still does not round-trip through
`parseUnits`, and any future caller that skips `input.ts` inherits the defect.
The failing case stays as the record of that.

---

## 2. `parseFilter` throws on a large size bound, which no other query value does

**File:** `src/core/market.ts`, the `units()` helper inside `parseFilter`.

**Suite case:** `market filter parsing > survives a size bound written in exponent notation`.

**Shrunk counterexample:** exponent `305`, that is the query `?smin=1e305`.

**Reproduction:**

```ts
parseFilter({ smin: '1e305' });
// RangeError: The number Infinity cannot be converted to a BigInt because it is not an integer
```

`?smin=1e304` parses fine and yields a 309-digit bigint. The threshold is where
`n * 10000` crosses `Number.MAX_VALUE`, at roughly `1.798e304`. Both `smin` and
`smax` are affected.

**Expected:** the function's own doc comment states the contract. "Anything
unparseable is dropped rather than rejected. A hand-edited or stale link should
show the marketplace, not an error page." Every other bad value honours that.
`?ymin=NaN`, `?tmin=Infinity`, `?by=yesterday`, `?grade=ZZZ` and `?sort=junk`
all fall back to the default.

**Observed:** `units()` guards with `Number.isFinite(n)` and then multiplies by
`BASE_UNITS_PER_UNIT` before converting. The guard runs before the
multiplication that overflows, so a finite input becomes an infinite
intermediate and `BigInt(Infinity)` throws. The size bound is the only query
parameter that can throw, because it is the only one that converts to bigint.

**Scope:** `parseFilter` is called from the marketplace route
(`src/app/lender/page.tsx` line 39) with the URL query, so a crafted or mangled
link turns a browse control into a server error. The fuzz over ordinary query
values (arbitrary strings, arrays, empty strings and `undefined`) passes 500
runs, which is why this needs a generator aimed at the exponent family to
surface at all.

---

## 3. `allocateProRata` loses its conservation guarantee on a negative weight

**File:** `src/core/money.ts`, `allocateProRata`.

**Suite case:** `money conservation > keeps conservation when a weight is negative`.

**Shrunk counterexample:** `total = 1n`, `weights = [-4n, 10n, -1n]`.

**Reproduction:**

```ts
allocateProRata(fromBaseUnits(1n), [-4n, 10n, -1n].map(fromBaseUnits));
// [0n, 2n, 0n], which sums to 2n rather than to 1n
```

**Expected:** the function's first line of documentation is "Split `total`
across `weights` so the parts sum back to `total` exactly", and its only guard
is `weightTotal <= 0n`. An input that passes the guard should get the
documented postcondition.

**Observed:** bigint division truncates toward zero, which is a ceiling rather
than a floor for a negative product, so the "floors" can sum to more than the
total. The residue then comes out negative and the largest-remainder loop exits
immediately on its `if (residue <= 0n) break`, leaving the over-allocation in
place. In the counterexample above the three parts sum to 2 when the total was
1, so the split invents a base unit.

**Scope:** latent rather than live. The only caller in the product is maturity
settlement, which weights by holder quantity, and a wallet balance cannot be
negative (`wallet_balance_non_negative` in `db/schema.sql`). So this cannot be
reached from any screen today. It is recorded because the guard states a
narrower precondition than the function actually needs. A guard of
"every weight is non-negative and at least one is positive" would make the
postcondition true for everything it admits, and is the same single line of
code.

The no-leak property holds for all non-negative weights, at 500 generated
values per run, which is the case the ledger actually relies on.

---

## Note, not a defect: the FX round-trip bound is a property of the rate band

`convert(x, 'XSGD', r)` followed by `mulDivRound(debit, RATE_SCALE, r)` recovers
`x` to within one base unit only while the rate is near one. At `r = 1n`
(0.000001 XSGD per XUSD) the error reaches half a million base units, because
the round-trip error scales with `RATE_SCALE / (2 * r)`.

```ts
mulDivRound(convert(fromBaseUnits(3n), 'XSGD', 1n).sourceDebit, RATE_SCALE, 1n) === 0n  // from 3n
```

This is arithmetic, not a bug. It is recorded so nobody reads the narrow
property in the suite as an unconditional guarantee. The suite states both
bounds:

- within one base unit for rates from 0.5 to 5.0, the band a real XSGD rate
  lives in and the one `app.world.xsgd_per_xusd_e6` is seeded into at 1.31;
- `2 * |error| * r <= RATE_SCALE + r` for every positive rate, which holds
  unconditionally and degrades visibly as the rate shrinks.

## Note, not a defect: `percentOfFace` is exact only below 9,007,640,657,640,767 base units

`percentOfFace` converts through `Number`, so above that face (just past
`2^53`) a price one base unit over face divides to exactly `1` and the
percentage reads `100`, while `quote().discount` is still `-1n` and
`isAbovePar` is still `true`. The three would then disagree and the above-par
property in the suite would break.

The programme limit in `db/fixtures.sql` is 250,000,000,000 base units, five
orders of magnitude below the threshold, and the suite's money generators are
bounded at 1,000,000,000,000 for that reason. Recorded so the bound is a stated
choice rather than an accident of the generator range.

## Note, not a defect: `parseFilter` accepts a calendar-impossible maturity date

`?by=2026-13-45` satisfies the `^\d{4}-\d{2}-\d{2}$` shape check in
`src/core/market.ts` and is cast straight to `IsoDate`, where
`clock.parseIsoDate` would have rejected it on `Date.parse`. The filter then
compares it against `maturityDate` as a string, so the result is a strange
cutoff rather than an error, and the module's "drop what you cannot parse"
contract is not broken. It is a gap in the branded type rather than a bug, and
the suite pins the current behaviour so a future change to it is deliberate.
