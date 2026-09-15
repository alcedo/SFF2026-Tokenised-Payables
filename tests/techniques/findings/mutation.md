# Findings from mutation testing

Tool: Stryker 10 with the vitest runner, config in `stryker.config.json`,
scored against `vitest.unit.config.mts`. Re-run with `npm run test:mutation`.

## The number

| | baseline | after the technique suites |
|---|---|---|
| src/core overall | **13.76%** | **22.60%** |
| mutants killed | 112 | 184 |
| mutants survived | 576 | 613 |
| total mutants | 814 | 814 |

Per file, killed then and now:

| file | baseline | after |
|---|---|---|
| pricing.ts | 28.89% | 47.78% |
| lifecycle.ts | 32.88% | 32.88% |
| market.ts | 4.69% | 18.23% |
| money.ts | 7.97% | 17.13% |
| clock.ts | 7.37% | 13.68% |
| references.ts | 13.33% | 13.33% |
| fx.ts | 0.00% | 0.00% (not a real measurement, see below) |

Both runs use the same settings, so the comparison is like for like. The
baseline was taken before a single line of the new suites existed. The raw
reports are committed at `.audit/mutation/baseline.json` and
`.audit/mutation/after.json`, because `reports/` is gitignored and a number
nobody can recompute is not evidence.

## What this gate cannot see, and why the number is narrower than it looks

Stryker mutates `src/core/*.ts`. Four of the seven technique suites do not
import `src/core` at all:

| suite | imports from src/core |
|---|---|
| properties | 5 |
| equivalence-boundary | 5 |
| decision-tables | 1 |
| state-transitions | 0 |
| concurrency-faults | 0 |
| model-based | 0 |

Those four test `db/post.sql`, which is PL/pgSQL and which no mutation tool
here touches. So the move from 13.76% to 22.60% is almost entirely the work of
two suites, and the mutation gate is a quality measure for the TypeScript core
only. It is not a measure of the run as a whole, and it cannot be. Treating it
as one would credit the SQL suites for work they did not do and, worse, would
suggest the ledger's own logic is under a gate when nothing measures it.

A second thing the raw delta hides. Mutants with no coverage at all fell from
126 to 17 while killed rose by 72 and survived rose by 37. A good part of the
movement is mutants that are now reached by a test and still not killed by it.
That is progress, since an unreached mutant cannot be killed without first
being reached, but it is less progress than the headline implies.

## fx.ts scores 0.00% because Stryker never runs a test against it

This is a defect in the measurement, not in the tests, and it was present at
baseline too.

Stryker reports `Ran 0.00 tests per mutant` for `src/core/fx.ts` and marks all
25 mutants survived. It does this under `coverageAnalysis` of `perTest`, `all`
and `off` alike, and with `ignoreStatic` disabled, so it is not coverage
attribution and not static-mutant filtering. The mutants themselves are plainly
killable: one rewrites the rate guard `rate <= 0n` to `rate > 0n`, another
forces every funding asset down the XSGD branch.

Proved by hand. Replacing line 90 of `src/core/fx.ts`,

```ts
rounded: exact % RATE_SCALE !== 0n,   ->   rounded: false,
```

fails three tests:

- `properties.test.ts > fx conversion > only reports an unrounded debit when the debit is exact`
- `pricing.test.ts > funding conversion > flags rounding when the conversion does not land on a base unit`
- `pricing.test.ts > funding conversion > rounds half up at the world rate, as the ledger does`

So the suite does kill `fx.ts` mutants and Stryker does not see it happen.

`fx.ts` is deliberately left in `mutate` rather than excluded. Dropping it
would raise the headline number by about three points without a single extra
test, and the point of this technique is to measure honestly.

A related symptom, unexplained: Stryker's dry run reports 369 tests where the
same config run directly reports 887. Whatever suppresses the `fx.ts` mutant
runs is likely the same thing.

## What the surviving mutants say

613 mutants still survive, so 22.60% is a floor to build on, not a good score.
The survivors cluster in three places.

Display and formatting paths. `formatUnits`, `formatAmount`, `formatRate`,
`formatClock`, `formatDaysRemaining`, `maturityLabel` and `STATUS_LABELS` carry
a large share. These are string outputs that reach a screen, and the suites
assert them at representative values rather than at every branch.

Comparator and predicate helpers in `money.ts`. `lt`, `lte`, `gt`, `gte`, `eq`,
`min`, `max` are thin wrappers, and a property asserting coherence between them
kills fewer mutants than a table asserting each one at its boundary, because
several mutations keep the set mutually consistent.

`lifecycle.ts` did not move at all, at 32.88% before and after. Its logic is
already covered by `lifecycle.test.ts`, and the new state-transition suite
tests the SQL state machine in `app.lifecycle_edge` rather than the TypeScript
mirror of it. That is the right split for the system, and it means this file
needs TypeScript-level cases to go higher.

## The gate

`stryker.config.json` sets `thresholds.break` to 22, just under the measured
22.60%. The score is now a gate rather than a number in a report: a change that
drops it fails `npm run test:mutation`. Raise the threshold as the score rises;
do not lower it to make a red run green.
