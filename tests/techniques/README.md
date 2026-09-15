# The seven technique suites

Seven testing techniques over the tokenised payables demo. Run them with
`npx vitest run tests/techniques`, or the whole gate with `npm test`.

| suite | technique |
|---|---|
| `equivalence-boundary.test.ts` | equivalence partitioning and boundary value analysis |
| `decision-tables.test.ts` | decision tables for business and compliance rules |
| `state-transitions.test.ts` | state-transition matrices |
| `properties.test.ts` | property-based and metamorphic testing |
| `model-based.test.ts` | model-based workflow coverage |
| `concurrency-faults.test.ts` | concurrency and fault injection |
| mutation, via `stryker.config.json` | mutation testing, which scores the rest |

Nothing under `src/` or `db/` was changed to make any of this pass.
`git diff <base>..HEAD -- src/ db/` is empty by design, and that is the point:
these suites report on the system, they do not adjust it.

## Read this before you read a green run

**Green does not mean correct here.** These suites found defects, and a defect
can appear in a suite in one of two ways.

**Pinned.** A passing assertion that records what the system actually does,
including where that is wrong. Most of this file's value is in pinned
behaviour, because a decision table whose outcome is keyed on fewer conditions
than it enumerates is how the suite shows which conditions the write path
ignores. The cost is that a pinned defect is green.

**Marked `it.fails`.** A case asserting what a reader would expect, which the
system does not do. Vitest reports it as "expected fail" and the run stays
green. The day the defect is fixed, the case turns red and someone has to
delete it deliberately. That is the signal.

So a wholly green run is consistent with the programme's central compliance
rule being unenforced. It is. See below.

Every defect, pinned or marked, is written up under `findings/` with a file, a
line, a reproduction, and observed against expected. **`findings/` is the
document, not the pass rate.**

## Where the convention is not yet uniform

`concurrency-faults.test.ts` carries two high-severity findings and has no
`it.fails` case for either. Its ABBA deadlock test pins `40P01` as the expected
outcome, and its series test pins `ADA04`. Both are correct records of current
behaviour and both are defects. They are written up in
`findings/concurrency-faults.md`.

Two suites disagree about one behaviour, and the disagreement is real rather
than a mistake. `decision-tables.test.ts` pins `bid_below_min_price: TRADED` as
a passing row, while `model-based.test.ts` carries
`it.fails('refuses a bid below the minimum price the seller published')`. Each
is right in its own frame: the table records what happens, the model asserts
what should. Fixing the defect turns one red and the other green. Whoever fixes
it should settle on one convention across all seven suites rather than reading
this as one suite being wrong.

## The mutation gate is narrower than it looks

`stryker.config.json` mutates `src/core/*.ts` and breaks below 22. Four of the
six vitest suites import nothing from `src/core`; they exercise `db/post.sql`,
which no mutation tool here touches. The score is a quality measure for the
TypeScript core only, and says nothing about the SQL suites. The numbers and
the reasoning are in `findings/mutation.md`, with the raw reports committed
under `.audit/mutation/`.

## The harness

`tests/support/database.ts` gives every database-backed suite its own database,
cloned from a template in about 80ms, so no suite shares mutable state with
another and none needs a lock. `tests/support/CONTRACT.md` is the recipe the
suites were written against. `tests/support/harness.test.ts` checks the harness
itself, including that the ledger oracle fails on a book corrupted on purpose,
because an oracle only ever seen passing cannot be told from one that always
returns healthy.
