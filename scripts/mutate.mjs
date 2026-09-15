#!/usr/bin/env node
/**
 * The mutants Stryker cannot measure.
 *
 * Stryker is the mutation gate for this repo; its score and threshold live in
 * stryker.config.json. It has one blind spot: for src/core/fx.ts it reports
 * "Ran 0.00 tests per mutant" and marks all 25 mutants survived, under every
 * coverage mode and with static filtering off. That is a measurement failure,
 * not a coverage hole, and it predates this suite.
 *
 * So this file is not a second mutation tool. It is a guard over the one file
 * the first one cannot see. It plants the mutant by hand, runs the suite, and
 * fails if nothing notices. The other nine mutants it used to carry were
 * dropped when Stryker became the gate, because Stryker measures those files
 * properly and two tools scoring the same code is one signal at twice the cost.
 *
 * tests/techniques/findings/mutation.md carries the evidence for the blind
 * spot, including the hand-planted change that fails three tests.
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
console.log('PASS  the suite kills the fx.ts mutants Stryker cannot measure');
