#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mutants = [
  {
    id: 'accept-amount-between-base-units',
    file: 'src/core/money.ts',
    find: 'if (/[^0]/.test(excess)) {',
    replace: 'if (false && /[^0]/.test(excess)) {',
  },
  {
    id: 'skip-pro-rata-residue',
    file: 'src/core/money.ts',
    find: 'if (residue <= 0n) break;\n    floors[index] += 1n;',
    replace: 'if (residue <= 0n) break;\n    /* floors[index] += 1n; */',
  },
  {
    id: 'truncate-instead-of-round',
    file: 'src/core/money.ts',
    find: 'const quotient = (absProduct * 2n + absDenominator) / (absDenominator * 2n);',
    replace: 'const quotient = absProduct / absDenominator;',
  },
  {
    id: 'annualise-after-maturity',
    file: 'src/core/pricing.ts',
    find: "const annualise = maturity === 'live';",
    replace: 'const annualise = true;',
  },
  {
    id: 'xsgd-funds-one-to-one',
    file: 'src/core/fx.ts',
    find: "if (fundingAsset !== 'XSGD') {",
    replace: 'if (true) {',
  },
  {
    id: 'mature-only-after-due-date',
    file: 'src/core/lifecycle.ts',
    find: 'return daysRemaining <= 0 ? \'matured\' : \'issued\';',
    replace: "return daysRemaining < 0 ? 'matured' : 'issued';",
  },
  {
    id: 'skip-actor-check',
    file: 'src/core/lifecycle.ts',
    find: 'if (transition.actors.length > 0 && !transition.actors.includes(actor)) {',
    replace: 'if (false && transition.actors.length > 0 && !transition.actors.includes(actor)) {',
  },
  {
    id: 'accept-zero-amount',
    file: 'src/core/input.ts',
    find: 'if (!isPositive(value)) return fail(\'Enter an amount greater than zero.\');',
    replace: 'if (false && !isPositive(value)) return fail(\'Enter an amount greater than zero.\');',
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
console.log('PASS  every mutant was killed');
