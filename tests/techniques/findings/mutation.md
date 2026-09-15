# Findings from mutation testing

Tool: Stryker 10 with the vitest runner, config in `stryker.config.json`,
scored against `vitest.unit.config.mts`. Re-run with `npm run test:mutation`.

## The gate is red, and it was red before these fixes

`npm test` fails at the mutation stage. Stryker scores 18.08% against a break
threshold of 24. The cause is not the defect fixes, and the arithmetic says so.

`b1d9bad` and `46f36e0` added three modules to `src/core` while building the
explorer overlay and the nav counts. Stryker mutates `src/core/*.ts` by glob, so
they joined the gate's denominator the moment they landed, carrying almost no
test that can detect a change in them:

| file | score | mutants |
|---|---:|---:|
| `next-action.ts` | 0.40% | 1 killed of 253 |
| `ledger-view.ts` | 2.53% | 2 killed of 79 |
| `tab-badges.ts` | 14.77% | 13 killed of 88 |

420 mutants, 16 killed. That is enough on its own to pull a passing score under
the threshold.

Measured like for like, over the six files the last committed report covers:

| | score |
|---|---:|
| `.audit/mutation/after-merge.json`, before these fixes | 24.84% |
| `.audit/mutation/after-defect-fixes.json`, after them | **25.40%** |

So the fixes raised the score on everything that was being measured, and the
gate fails on three files none of them touched. Re-run it with
`npx stryker run`; the raw report is committed beside the others.

Closing this needs unit tests for those three modules, which is a different
piece of work from fixing the defects the suites found, and is left for whoever
owns them.

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

## After merging main: two files Stryker cannot measure, not one

main brought `src/core/input.ts` with PR #11. Stryker scored it 0.00%, 120
survivors, 0 killed, which is the same reading it gives `fx.ts`. Both are
false. Planting either mutation by hand fails a real test:

| file | planted change | test that caught it |
|---|---|---|
| `fx.ts` | `rounded: exact % RATE_SCALE !== 0n` to `rounded: false` | three, across `properties.test.ts` and `pricing.test.ts` |
| `input.ts` | dropped the `days > TERMS_MAX` bound | `input.ep-bva.test.ts > payment terms: partitions and boundaries > just above upper bound` |

So 148 of 937 mutants were counted as survived while the suite was killing
them, and the headline score read 20.92% instead of the truth.

Both files are now excluded in `stryker.config.json` and guarded by
`scripts/mutate.mjs` instead, which plants four mutants across them by hand and
fails the build unless every one dies. That guard is stricter than the score it
replaces, not weaker: Stryker tolerates survivors up to a threshold, the guard
tolerates none.

The excluded score is **24.84%**, 196 killed of 789. Killed is unchanged from
the 20.92% reading; only the denominator was wrong. `thresholds.break` is 24.

The cause is still unexplained. It is not coverage attribution, not static
filtering, and not the import style, since both `../fx` and `@/core/fx` appear
across the tests and `money.ts` is measured correctly through both. Whoever
picks this up should treat a new file reading exactly 0.00% as suspect until a
hand-planted mutation proves otherwise.

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
