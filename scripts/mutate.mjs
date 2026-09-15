#!/usr/bin/env node
/**
 * The mutants Stryker cannot measure.
 *
 * Stryker is the mutation gate for this repo; its score and threshold live in
 * stryker.config.json. It cannot measure two of the files it is pointed at.
 * For src/core/fx.ts and src/core/input.ts it reports "Ran 0.00 tests per
 * mutant" and marks every mutant survived, under every coverage mode and with
 * static filtering off. Both claims are false: planting either mutation by
 * hand fails a test. Rather than let 148 phantom survivors drag the score,
 * those two files are excluded in stryker.config.json and guarded here.
 *
 * So this is not a second mutation tool. It is the gate for the files the
 * first one is blind to, and it is stricter: every mutant must die or the
 * build fails. Mutants in files Stryker measures properly do not belong here.
 *
 * tests/techniques/findings/mutation.md carries the evidence for both files,
 * including the hand-planted changes and the tests that caught them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mutants = [
  {
    id: 'xsgd-funds-one-to-one',
    file: 'src/core/fx.ts',
    find: "if (fundingAsset !== 'XSGD') {",
    replace: 'if (true) {',
  },
  {
    id: 'accept-zero-amount',
    file: 'src/core/input.ts',
    find: "if (!isPositive(value)) return fail('Enter an amount greater than zero.');",
    replace: "if (false && !isPositive(value)) return fail('Enter an amount greater than zero.');",
  },
  {
    id: 'drop-terms-upper-bound',
    file: 'src/core/input.ts',
    find: 'if (!Number.isInteger(days) || days < TERMS_MIN || days > TERMS_MAX) {',
    replace: 'if (!Number.isInteger(days) || days < TERMS_MIN) {',
  },
  {
    id: 'allow-price-above-par',
    file: 'src/core/input.ts',
    find: "if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {\n    return fail('Enter a price between 0 and 100 percent of face.');\n  }\n  const bps = Math.round(pct * 100);\n  if (bps <= 0 || bps > BPS_PER_100_PERCENT) {",
    replace: "if (!Number.isFinite(pct) || pct <= 0) {\n    return fail('Enter a price between 0 and 100 percent of face.');\n  }\n  const bps = Math.round(pct * 100);\n  if (bps <= 0) {",
  },
];

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'src/core/__tests__'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { passed: true, output: '' };
  } catch (error) {
    const err = error;
    return {
      passed: false,
      output: `${err.stdout ?? ''}\n${err.stderr ?? ''}`,
    };
  }
}

const baseline = runTests();
if (!baseline.passed) {
  console.error('mutation baseline is red; fix the suite before measuring it');
  console.error(baseline.output.slice(-2000));
  process.exit(1);
}

let killed = 0;
const survivors = [];

for (const mutant of mutants) {
  const original = readFileSync(mutant.file, 'utf8');
  if (!original.includes(mutant.find)) {
    survivors.push(`${mutant.id}: find string missing in ${mutant.file}`);
    continue;
  }
  writeFileSync(mutant.file, original.replace(mutant.find, mutant.replace));
  const result = runTests();
  writeFileSync(mutant.file, original);
  if (result.passed) {
    survivors.push(mutant.id);
  } else {
    killed += 1;
    console.log(`killed ${mutant.id}`);
  }
}

console.log(`killed ${killed}/${mutants.length}`);
if (survivors.length > 0) {
  console.error(`survivors: ${survivors.join(', ')}`);
  process.exit(1);
}
console.log('PASS  the suite kills every mutant in the files Stryker cannot measure');
