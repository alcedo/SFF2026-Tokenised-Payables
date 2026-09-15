/**
 * Equivalence partitioning and boundary value analysis, applied to field
 * validation.
 *
 * The artifact here is the two tables, not the runners. Each row names the
 * field under test, the equivalence class the input belongs to, where it sits
 * relative to a boundary, the input itself, and the single expected outcome.
 * Two loops turn the tables into cases, so adding a partition is adding a row.
 *
 * A boundary is always covered as a triple: the last value on one side, the
 * value on the edge, and the first value on the other. Rows carrying an `edge`
 * of `below` / `on` / `above` are those triples, and every one of them is
 * complete.
 *
 * A row with a `defect` is one where the system does not do what its own guard
 * says it does. Those rows state the CORRECT expectation and run under
 * `it.fails`, so the suite stays green while recording the defect. Each is
 * written up in tests/techniques/findings/equivalence-boundary.md under the id
 * the row carries.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  freshDatabase,
  post,
  anyActor,
  ledgerHealth,
  HEALTHY,
  type Database,
} from '../support/database';
import * as money from '@/core/money';
import * as fx from '@/core/fx';
import * as pricing from '@/core/pricing';
import * as clock from '@/core/clock';
import * as market from '@/core/market';

type Edge = 'below' | 'on' | 'above';

/** Exactly one of the two: a returned value, or a thrown class plus message. */
type Outcome =
  | { readonly value: unknown }
  | { readonly error: 'RangeError' | 'SyntaxError'; readonly message: string };

const returns = (value: unknown): Outcome => ({ value });
const rangeError = (message: string): Outcome => ({ error: 'RangeError', message });
const syntaxError = (message: string): Outcome => ({ error: 'SyntaxError', message });

interface PureCase {
  readonly field: string;
  readonly partition: string;
  readonly edge?: Edge;
  readonly input: string;
  readonly run: () => unknown;
  readonly expected: Outcome;
  readonly defect?: string;
}

/** Adopt a literal as base units without going through the decimal parser. */
const bu = (value: bigint) => money.fromBaseUnits(value);
const day = (text: string) => clock.parseIsoDate(text);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const T0 = day('2026-01-01');

/** The five numbers a quote is actually read for; face, price and d echo back. */
const derived = (face: bigint, price: bigint, daysRemaining: number) => {
  const q = pricing.quote(bu(face), bu(price), daysRemaining);
  return {
    discount: q.discount,
    pricePercent: q.pricePercent,
    maturity: q.maturity,
    cost: q.annualisedDiscountCostPercent,
    lenderYield: q.lenderYieldPercent,
  };
};

const lot = (
  grade: string | null,
  face: bigint,
  maturityDate: string,
  daysRemaining: number,
  lenderYieldPercent: number | null,
  pricePercent: number,
): market.Filterable => ({
  grade,
  listedFaceBase: bu(face),
  maturityDate: day(maturityDate),
  quote: { daysRemaining, lenderYieldPercent, pricePercent },
});

const LOTS: readonly market.Filterable[] = [
  lot('AAA', 1_000n, '2026-03-01', 10, 9, 98),
  lot('AA', 2_000n, '2026-04-01', 30, 4, 99),
  lot('A', 3_000n, '2026-02-01', 0, null, 100),
  lot(null, 4_000n, '2026-05-01', 45, 6, 97),
];

const kept = (filter: Partial<market.MarketFilter>) =>
  market.applyFilter(LOTS, { ...market.NO_FILTER, ...filter }).map((l) => l.grade);

const PURE_CASES: readonly PureCase[] = [
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: whole digits only',
    input: '"250000"',
    run: () => money.parseUnits('250000'),
    expected: returns(2_500_000_000n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: zero',
    input: '"0"',
    run: () => money.parseUnits('0'),
    expected: returns(0n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: leading zeros are not an error',
    input: '"007"',
    run: () => money.parseUnits('007'),
    expected: returns(70_000n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: trailing point with an empty fraction',
    input: '"5."',
    run: () => money.parseUnits('5.'),
    expected: returns(50_000n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: surrounding whitespace is trimmed',
    input: '"  12.5  "',
    run: () => money.parseUnits('  12.5  '),
    expected: returns(125_000n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: negative',
    input: '"-0.0001"',
    run: () => money.parseUnits('-0.0001'),
    expected: returns(-1n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: negative zero collapses to zero',
    input: '"-0"',
    run: () => money.parseUnits('-0'),
    expected: returns(0n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'valid: smallest representable magnitude',
    input: '"0.0001"',
    run: () => money.parseUnits('0.0001'),
    expected: returns(1n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'fraction length under the 4-decimal limit',
    edge: 'below',
    input: '"1.234"',
    run: () => money.parseUnits('1.234'),
    expected: returns(12_340n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'fraction length exactly at the 4-decimal limit',
    edge: 'on',
    input: '"1.2345"',
    run: () => money.parseUnits('1.2345'),
    expected: returns(12_345n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'fraction one past the limit, excess digit zero',
    edge: 'above',
    input: '"1.23450"',
    run: () => money.parseUnits('1.23450'),
    expected: returns(12_345n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'fraction one past the limit, excess digit non-zero',
    edge: 'above',
    input: '"1.23456"',
    run: () => money.parseUnits('1.23456'),
    expected: rangeError(
      '1.23456 needs more than 4 decimals; amounts between base units are not representable',
    ),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'far past the limit but every excess digit zero',
    input: '"1.50000000"',
    run: () => money.parseUnits('1.50000000'),
    expected: returns(15_000n),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'smallest value below one base unit',
    input: '"0.00005"',
    run: () => money.parseUnits('0.00005'),
    expected: rangeError(
      '0.00005 needs more than 4 decimals; amounts between base units are not representable',
    ),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'negative, excess digit non-zero',
    input: '"-1.00001"',
    run: () => money.parseUnits('-1.00001'),
    expected: rangeError(
      '-1.00001 needs more than 4 decimals; amounts between base units are not representable',
    ),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: exponent notation',
    input: '"1e5"',
    run: () => money.parseUnits('1e5'),
    expected: rangeError('not a decimal amount: "1e5"'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: empty',
    input: '""',
    run: () => money.parseUnits(''),
    expected: rangeError('not a decimal amount: ""'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: whitespace only, reported untrimmed',
    input: '"  "',
    run: () => money.parseUnits('  '),
    expected: rangeError('not a decimal amount: "  "'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: explicit plus sign',
    input: '"+1"',
    run: () => money.parseUnits('+1'),
    expected: rangeError('not a decimal amount: "+1"'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: leading point, no whole part',
    input: '".5"',
    run: () => money.parseUnits('.5'),
    expected: rangeError('not a decimal amount: ".5"'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: thousands separator',
    input: '"1,000"',
    run: () => money.parseUnits('1,000'),
    expected: rangeError('not a decimal amount: "1,000"'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: sign with no digits',
    input: '"-"',
    run: () => money.parseUnits('-'),
    expected: rangeError('not a decimal amount: "-"'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: a number-like word',
    input: '"Infinity"',
    run: () => money.parseUnits('Infinity'),
    expected: rangeError('not a decimal amount: "Infinity"'),
  },
  {
    field: 'money.parseUnits(input)',
    partition: 'not a decimal: letters',
    input: '"abc"',
    run: () => money.parseUnits('abc'),
    expected: rangeError('not a decimal amount: "abc"'),
  },

  {
    field: 'money.fromWholeUnits(units)',
    partition: 'valid: zero',
    input: '0',
    run: () => money.fromWholeUnits(0),
    expected: returns(0n),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'valid: one unit is 10,000 base units',
    input: '1',
    run: () => money.fromWholeUnits(1),
    expected: returns(10_000n),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'valid: negative',
    input: '-MAX_SAFE_INTEGER',
    run: () => money.fromWholeUnits(-MAX_SAFE),
    expected: returns(-90_071_992_547_409_910_000n),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'one under the safe-integer ceiling',
    edge: 'below',
    input: 'MAX_SAFE_INTEGER - 1',
    run: () => money.fromWholeUnits(MAX_SAFE - 1),
    expected: returns(90_071_992_547_409_900_000n),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'exactly the safe-integer ceiling',
    edge: 'on',
    input: 'MAX_SAFE_INTEGER',
    run: () => money.fromWholeUnits(MAX_SAFE),
    expected: returns(90_071_992_547_409_910_000n),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'one over the safe-integer ceiling',
    edge: 'above',
    input: 'MAX_SAFE_INTEGER + 1',
    run: () => money.fromWholeUnits(MAX_SAFE + 1),
    expected: rangeError('fromWholeUnits expects a safe integer, received 9007199254740992'),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'not an integer',
    input: '0.1',
    run: () => money.fromWholeUnits(0.1),
    expected: rangeError('fromWholeUnits expects a safe integer, received 0.1'),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'not a number at all',
    input: 'NaN',
    run: () => money.fromWholeUnits(NaN),
    expected: rangeError('fromWholeUnits expects a safe integer, received NaN'),
  },
  {
    field: 'money.fromWholeUnits(units)',
    partition: 'unbounded',
    input: 'Infinity',
    run: () => money.fromWholeUnits(Infinity),
    expected: rangeError('fromWholeUnits expects a safe integer, received Infinity'),
  },

  {
    field: 'money.fromBaseUnits(value)',
    partition: 'number path: safe integer',
    input: '1',
    run: () => money.fromBaseUnits(1),
    expected: returns(1n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'number path, one under the ceiling',
    edge: 'below',
    input: 'MAX_SAFE_INTEGER - 1',
    run: () => money.fromBaseUnits(MAX_SAFE - 1),
    expected: returns(9_007_199_254_740_990n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'number path, exactly the ceiling',
    edge: 'on',
    input: 'MAX_SAFE_INTEGER',
    run: () => money.fromBaseUnits(MAX_SAFE),
    expected: returns(9_007_199_254_740_991n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'number path, one over the ceiling',
    edge: 'above',
    input: 'MAX_SAFE_INTEGER + 1',
    run: () => money.fromBaseUnits(MAX_SAFE + 1),
    expected: rangeError('base units must be a safe integer, received 9007199254740992'),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'number path rejects a fraction',
    input: '1.5',
    run: () => money.fromBaseUnits(1.5),
    expected: rangeError('base units must be a safe integer, received 1.5'),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'bigint path is unguarded, so the ceiling does not apply',
    edge: 'above',
    input: '9007199254740993n',
    run: () => money.fromBaseUnits(9_007_199_254_740_993n),
    expected: returns(9_007_199_254_740_993n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'string path is unguarded, so the ceiling does not apply',
    edge: 'above',
    input: '"9007199254740993"',
    run: () => money.fromBaseUnits('9007199254740993'),
    expected: returns(9_007_199_254_740_993n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'string path tolerates padding',
    input: '" 12 "',
    run: () => money.fromBaseUnits(' 12 '),
    expected: returns(12n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'string path: empty string becomes zero, EB-04',
    input: '""',
    run: () => money.fromBaseUnits(''),
    expected: returns(0n),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'string path: a fraction escapes as a raw SyntaxError, EB-04',
    input: '"1.5"',
    run: () => money.fromBaseUnits('1.5'),
    expected: syntaxError('Cannot convert 1.5 to a BigInt'),
  },
  {
    field: 'money.fromBaseUnits(value)',
    partition: 'string path: letters escape as a raw SyntaxError, EB-04',
    input: '"abc"',
    run: () => money.fromBaseUnits('abc'),
    expected: syntaxError('Cannot convert abc to a BigInt'),
  },

  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'denominator just below zero',
    edge: 'below',
    input: '(10n, -1n)',
    run: () => money.roundDiv(10n, -1n),
    expected: returns(-10n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'denominator exactly zero',
    edge: 'on',
    input: '(10n, 0n)',
    run: () => money.roundDiv(10n, 0n),
    expected: rangeError('division by zero'),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'denominator just above zero',
    edge: 'above',
    input: '(10n, 1n)',
    run: () => money.roundDiv(10n, 1n),
    expected: returns(10n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'exactly one half rounds away from zero, positive',
    edge: 'on',
    input: '(5n, 10n)',
    run: () => money.roundDiv(5n, 10n),
    expected: returns(1n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'just under one half rounds down, positive',
    edge: 'below',
    input: '(4n, 10n)',
    run: () => money.roundDiv(4n, 10n),
    expected: returns(0n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'one and a half rounds up',
    edge: 'above',
    input: '(15n, 10n)',
    run: () => money.roundDiv(15n, 10n),
    expected: returns(2n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'exactly one half rounds away from zero, negative',
    edge: 'on',
    input: '(-5n, 10n)',
    run: () => money.roundDiv(-5n, 10n),
    expected: returns(-1n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'just under one half rounds to zero, negative',
    edge: 'below',
    input: '(-4n, 10n)',
    run: () => money.roundDiv(-4n, 10n),
    expected: returns(0n),
  },
  {
    field: 'money.roundDiv(product, denominator)',
    partition: 'sign carried by the denominator',
    input: '(5n, -10n)',
    run: () => money.roundDiv(5n, -10n),
    expected: returns(-1n),
  },

  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'weights sum just below zero',
    edge: 'below',
    input: '(100n, [10n, -11n])',
    run: () => money.allocateProRata(bu(100n), [bu(10n), bu(-11n)]),
    expected: rangeError('allocateProRata needs at least one positive weight'),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'weights sum exactly zero',
    edge: 'on',
    input: '(100n, [10n, -10n])',
    run: () => money.allocateProRata(bu(100n), [bu(10n), bu(-10n)]),
    expected: rangeError('allocateProRata needs at least one positive weight'),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'weights sum just above zero',
    edge: 'above',
    input: '(100n, [10n, -9n])',
    run: () => money.allocateProRata(bu(100n), [bu(10n), bu(-9n)]),
    expected: returns([1_000n, -900n]),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'no weights at all sums to zero',
    edge: 'on',
    input: '(100n, [])',
    run: () => money.allocateProRata(bu(100n), []),
    expected: rangeError('allocateProRata needs at least one positive weight'),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'a zero weight is allowed alongside a positive one',
    input: '(100n, [0n, 1n])',
    run: () => money.allocateProRata(bu(100n), [bu(0n), bu(1n)]),
    expected: returns([0n, 100n]),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'largest remainder puts the residue on the first index',
    input: '(100n, [1n, 1n, 1n])',
    run: () => money.allocateProRata(bu(100n), [bu(1n), bu(1n), bu(1n)]),
    expected: returns([34n, 33n, 33n]),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'total of zero splits into zeros',
    edge: 'on',
    input: '(0n, [1n, 1n])',
    run: () => money.allocateProRata(bu(0n), [bu(1n), bu(1n)]),
    expected: returns([0n, 0n]),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'a single indivisible base unit goes to one holder',
    edge: 'above',
    input: '(1n, [1n, 1n])',
    run: () => money.allocateProRata(bu(1n), [bu(1n), bu(1n)]),
    expected: returns([1n, 0n]),
  },
  {
    field: 'money.allocateProRata(total, weights)',
    partition: 'a negative weight with a positive sum should still be refused',
    input: '(100n, [-5n, 10n])',
    run: () => money.allocateProRata(bu(100n), [bu(-5n), bu(10n)]),
    expected: rangeError('allocateProRata needs at least one positive weight'),
    defect: 'EB-03',
  },

  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'decimals just below the allowed range',
    edge: 'below',
    input: '(12345n, -1)',
    run: () => money.formatUnits(bu(12_345n), -1),
    expected: rangeError('decimals must be between 0 and 4'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'decimals at the low edge of the range',
    edge: 'on',
    input: '(12345n, 0)',
    run: () => money.formatUnits(bu(12_345n), 0),
    expected: returns('1'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'decimals at the high edge of the range',
    edge: 'on',
    input: '(12345n, 4)',
    run: () => money.formatUnits(bu(12_345n), 4),
    expected: returns('1.2345'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'decimals just above the allowed range',
    edge: 'above',
    input: '(12345n, 5)',
    run: () => money.formatUnits(bu(12_345n), 5),
    expected: rangeError('decimals must be between 0 and 4'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'a non-integer decimals is not rejected, it truncates',
    input: '(12345n, 2.5)',
    run: () => money.formatUnits(bu(12_345n), 2.5),
    expected: returns('1.23'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'digit under five truncates',
    edge: 'below',
    input: '(12344n, 3)',
    run: () => money.formatUnits(bu(12_344n), 3),
    expected: returns('1.234'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'digit exactly five rounds up',
    edge: 'on',
    input: '(12345n, 3)',
    run: () => money.formatUnits(bu(12_345n), 3),
    expected: returns('1.235'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'rounding carries into the whole part',
    input: '(9999n, 3)',
    run: () => money.formatUnits(bu(9_999n), 3),
    expected: returns('1.000'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'rounding carries into a non-zero whole part',
    input: '(19999n, 3)',
    run: () => money.formatUnits(bu(19_999n), 3),
    expected: returns('2.000'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'half a unit at zero decimals rounds up',
    edge: 'on',
    input: '(5000n, 0)',
    run: () => money.formatUnits(bu(5_000n), 0),
    expected: returns('1'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'just under half a unit at zero decimals rounds down',
    edge: 'below',
    input: '(4999n, 0)',
    run: () => money.formatUnits(bu(4_999n), 0),
    expected: returns('0'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'negative rounds away from zero and keeps the sign',
    input: '(-5000n, 0)',
    run: () => money.formatUnits(bu(-5_000n), 0),
    expected: returns('-1'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'thousands separators appear in the whole part',
    input: '(12345678901n, 4)',
    run: () => money.formatUnits(bu(12_345_678_901n), 4),
    expected: returns('1,234,567.8901'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'zero at zero decimals',
    input: '(0n, 0)',
    run: () => money.formatUnits(bu(0n), 0),
    expected: returns('0'),
  },
  {
    field: 'money.formatUnits(value, decimals)',
    partition: 'a NaN decimals should be outside 0..4 like any other non-value',
    input: '(12345n, NaN)',
    run: () => money.formatUnits(bu(12_345n), NaN),
    expected: rangeError('decimals must be between 0 and 4'),
    defect: 'EB-02',
  },

  {
    field: 'money.formatAmount(value, asset, decimals)',
    partition: 'default decimals show all four',
    input: '(12345n, "XUSD")',
    run: () => money.formatAmount(bu(12_345n), 'XUSD'),
    expected: returns('1.2345 XUSD'),
  },
  {
    field: 'money.formatAmount(value, asset, decimals)',
    partition: 'summary decimals',
    input: '(12345n, "XSGD", 2)',
    run: () => money.formatAmount(bu(12_345n), 'XSGD', 2),
    expected: returns('1.23 XSGD'),
  },
  {
    field: 'money.toJson(value)',
    partition: 'negative serialises without a bigint suffix',
    input: '-12345n',
    run: () => money.toJson(bu(-12_345n)),
    expected: returns('-12345'),
  },
  {
    field: 'money.isAsset(value)',
    partition: 'inside the enum',
    input: '"XUSD"',
    run: () => money.isAsset('XUSD'),
    expected: returns(true),
  },
  {
    field: 'money.isAsset(value)',
    partition: 'right letters, wrong case',
    input: '"usdc"',
    run: () => money.isAsset('usdc'),
    expected: returns(false),
  },
  {
    field: 'money.isAsset(value)',
    partition: 'empty',
    input: '""',
    run: () => money.isAsset(''),
    expected: returns(false),
  },
  {
    field: 'money.isAsset(value)',
    partition: 'a plausible ticker outside the enum',
    input: '"EURC"',
    run: () => money.isAsset('EURC'),
    expected: returns(false),
  },

  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'a 1:1 asset never reaches the rate check',
    input: '(1000n, "USDC", 0n)',
    run: () => fx.convert(bu(1_000n), 'USDC', 0n),
    expected: returns({
      obligationXusd: 1_000n,
      fundingAsset: 'USDC',
      sourceDebit: 1_000n,
      rate: null,
      rounded: false,
    }),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'a 1:1 asset accepts a negative rate too',
    input: '(1000n, "USDT", -1n)',
    run: () => fx.convert(bu(1_000n), 'USDT', -1n),
    expected: returns({
      obligationXusd: 1_000n,
      fundingAsset: 'USDT',
      sourceDebit: 1_000n,
      rate: null,
      rounded: false,
    }),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'the denomination itself funds at par',
    input: '(1000n, "XUSD", 0n)',
    run: () => fx.convert(bu(1_000n), 'XUSD', 0n),
    expected: returns({
      obligationXusd: 1_000n,
      fundingAsset: 'XUSD',
      sourceDebit: 1_000n,
      rate: null,
      rounded: false,
    }),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'XSGD rate just below the positive floor',
    edge: 'below',
    input: '(1000n, "XSGD", -1n)',
    run: () => fx.convert(bu(1_000n), 'XSGD', -1n),
    expected: rangeError('the XSGD rate must be positive'),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'XSGD rate exactly at zero',
    edge: 'on',
    input: '(1000n, "XSGD", 0n)',
    run: () => fx.convert(bu(1_000n), 'XSGD', 0n),
    expected: rangeError('the XSGD rate must be positive'),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'XSGD rate just above zero rounds the debit to nothing',
    edge: 'above',
    input: '(1000n, "XSGD", 1n)',
    run: () => fx.convert(bu(1_000n), 'XSGD', 1n),
    expected: returns({
      obligationXusd: 1_000n,
      fundingAsset: 'XSGD',
      sourceDebit: 0n,
      rate: 1n,
      rounded: true,
    }),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'XSGD at a rate of exactly one leaves the amount alone',
    input: '(1000n, "XSGD", 1000000n)',
    run: () => fx.convert(bu(1_000n), 'XSGD', 1_000_000n),
    expected: returns({
      obligationXusd: 1_000n,
      fundingAsset: 'XSGD',
      sourceDebit: 1_000n,
      rate: 1_000_000n,
      rounded: false,
    }),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'the seeded rate on an exact amount does not round',
    input: '(10000n, "XSGD", 1310000n)',
    run: () => fx.convert(bu(10_000n), 'XSGD', 1_310_000n),
    expected: returns({
      obligationXusd: 10_000n,
      fundingAsset: 'XSGD',
      sourceDebit: 13_100n,
      rate: 1_310_000n,
      rounded: false,
    }),
  },
  {
    field: 'fx.convert(obligation, fundingAsset, rate)',
    partition: 'the seeded rate on a single base unit rounds',
    edge: 'on',
    input: '(1n, "XSGD", 1310000n)',
    run: () => fx.convert(bu(1n), 'XSGD', 1_310_000n),
    expected: returns({
      obligationXusd: 1n,
      fundingAsset: 'XSGD',
      sourceDebit: 1n,
      rate: 1_310_000n,
      rounded: true,
    }),
  },
  {
    field: 'fx.formatRate(rate)',
    partition: 'the seeded rate',
    input: '1310000n',
    run: () => fx.formatRate(1_310_000n),
    expected: returns('1 XUSD = 1.3100 XSGD'),
  },
  {
    field: 'fx.formatRate(rate)',
    partition: 'a rate below one displayed decimal collapses to zero',
    edge: 'below',
    input: '1n',
    run: () => fx.formatRate(1n),
    expected: returns('1 XUSD = 0.0000 XSGD'),
  },
  {
    field: 'fx.formatRate(rate)',
    partition: 'a rate carrying all four decimals',
    input: '1234500n',
    run: () => fx.formatRate(1_234_500n),
    expected: returns('1 XUSD = 1.2345 XSGD'),
  },

  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps just below zero',
    edge: 'below',
    input: '(1000000n, -1)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), -1),
    expected: rangeError('percent must be a non-negative whole number of basis points, received -1'),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps exactly zero',
    edge: 'on',
    input: '(1000000n, 0)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), 0),
    expected: returns(0n),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps just above zero',
    edge: 'above',
    input: '(1000000n, 1)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), 1),
    expected: returns(100n),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps at par',
    input: '(1000000n, 10000)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), 10_000),
    expected: returns(1_000_000n),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps above par, since there is no upper bound',
    edge: 'above',
    input: '(1000000n, 12000)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), 12_000),
    expected: returns(1_200_000n),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'a typical listed price',
    input: '(1000000n, 9785)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), 9_785),
    expected: returns(978_500n),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps must be whole',
    input: '(1000000n, 97.5)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), 97.5),
    expected: rangeError(
      'percent must be a non-negative whole number of basis points, received 97.5',
    ),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'bps must be a number',
    input: '(1000000n, NaN)',
    run: () => pricing.priceFromPercent(bu(1_000_000n), NaN),
    expected: rangeError('percent must be a non-negative whole number of basis points, received NaN'),
  },
  {
    field: 'pricing.priceFromPercent(face, percent)',
    partition: 'face is not validated here, unlike percentOfFace and quote',
    edge: 'on',
    input: '(0n, 9785)',
    run: () => pricing.priceFromPercent(bu(0n), 9_785),
    expected: returns(0n),
  },

  {
    field: 'pricing.percentOfFace(price, face)',
    partition: 'face just below the positive floor',
    edge: 'below',
    input: '(1n, -1n)',
    run: () => pricing.percentOfFace(bu(1n), bu(-1n)),
    expected: rangeError('face must be positive to express a price as a percentage of it'),
  },
  {
    field: 'pricing.percentOfFace(price, face)',
    partition: 'face exactly zero',
    edge: 'on',
    input: '(1n, 0n)',
    run: () => pricing.percentOfFace(bu(1n), bu(0n)),
    expected: rangeError('face must be positive to express a price as a percentage of it'),
  },
  {
    field: 'pricing.percentOfFace(price, face)',
    partition: 'face just above zero',
    edge: 'above',
    input: '(1n, 1n)',
    run: () => pricing.percentOfFace(bu(1n), bu(1n)),
    expected: returns(100),
  },
  {
    field: 'pricing.percentOfFace(price, face)',
    partition: 'a price below par',
    input: '(900000n, 1000000n)',
    run: () => pricing.percentOfFace(bu(900_000n), bu(1_000_000n)),
    expected: returns(90),
  },

  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'face just below the positive floor, a different message from percentOfFace',
    edge: 'below',
    input: '(-1n, 1n, 1)',
    run: () => pricing.quote(bu(-1n), bu(1n), 1),
    expected: rangeError('face must be positive'),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'face exactly zero',
    edge: 'on',
    input: '(0n, 1n, 1)',
    run: () => pricing.quote(bu(0n), bu(1n), 1),
    expected: rangeError('face must be positive'),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'days must be whole',
    input: '(1000000n, 900000n, 1.5)',
    run: () => pricing.quote(bu(1_000_000n), bu(900_000n), 1.5),
    expected: rangeError('daysRemaining must be a whole number of days, received 1.5'),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'days just below maturity is past-due, both annualised values null',
    edge: 'below',
    input: '(1000000n, 900000n, -1)',
    run: () => derived(1_000_000n, 900_000n, -1),
    expected: returns({
      discount: 100_000n,
      pricePercent: 90,
      maturity: 'past-due',
      cost: null,
      lenderYield: null,
    }),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'days exactly at maturity is due, both annualised values null',
    edge: 'on',
    input: '(1000000n, 900000n, 0)',
    run: () => derived(1_000_000n, 900_000n, 0),
    expected: returns({
      discount: 100_000n,
      pricePercent: 90,
      maturity: 'due',
      cost: null,
      lenderYield: null,
    }),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'days just above maturity is live and annualises over one day',
    edge: 'above',
    input: '(1000000n, 900000n, 1)',
    run: () => derived(1_000_000n, 900_000n, 1),
    expected: returns({
      discount: 100_000n,
      pricePercent: 90,
      maturity: 'live',
      cost: 3_650,
      lenderYield: 4_055.555555555555,
    }),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'price at par leaves no discount and no yield',
    edge: 'on',
    input: '(1000n, 1000n, 10)',
    run: () => derived(1_000n, 1_000n, 10),
    expected: returns({
      discount: 0n,
      pricePercent: 100,
      maturity: 'live',
      cost: 0,
      lenderYield: 0,
    }),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'price exactly zero: cost is a number while lender yield is null',
    edge: 'on',
    input: '(1000000n, 0n, 30)',
    run: () => derived(1_000_000n, 0n, 30),
    expected: returns({
      discount: 1_000_000n,
      pricePercent: 0,
      maturity: 'live',
      cost: 1_216.6666666666665,
      lenderYield: null,
    }),
  },
  {
    field: 'pricing.quote(face, price, daysRemaining)',
    partition: 'price below zero is not validated, EB-05',
    edge: 'below',
    input: '(1000000n, -50n, 30)',
    run: () => derived(1_000_000n, -50n, 30),
    expected: returns({
      discount: 1_000_050n,
      pricePercent: -0.005,
      maturity: 'live',
      cost: 1_216.7275,
      lenderYield: null,
    }),
  },

  {
    field: 'pricing.priceForTargetYield(face, targetYieldPercent, daysRemaining)',
    partition: 'days just below the positive floor',
    edge: 'below',
    input: '(1000000n, 8, -1)',
    run: () => pricing.priceForTargetYield(bu(1_000_000n), 8, -1),
    expected: rangeError('a target yield needs a positive number of days remaining'),
  },
  {
    field: 'pricing.priceForTargetYield(face, targetYieldPercent, daysRemaining)',
    partition: 'days exactly zero',
    edge: 'on',
    input: '(1000000n, 8, 0)',
    run: () => pricing.priceForTargetYield(bu(1_000_000n), 8, 0),
    expected: rangeError('a target yield needs a positive number of days remaining'),
  },
  {
    field: 'pricing.priceForTargetYield(face, targetYieldPercent, daysRemaining)',
    partition: 'days just above zero',
    edge: 'above',
    input: '(1000000n, 8, 1)',
    run: () => pricing.priceForTargetYield(bu(1_000_000n), 8, 1),
    expected: returns(999_781n),
  },
  {
    field: 'pricing.priceForTargetYield(face, targetYieldPercent, daysRemaining)',
    partition: 'a zero target yield prices at face',
    edge: 'on',
    input: '(1000000n, 0, 365)',
    run: () => pricing.priceForTargetYield(bu(1_000_000n), 0, 365),
    expected: returns(1_000_000n),
  },
  {
    field: 'pricing.priceForTargetYield(face, targetYieldPercent, daysRemaining)',
    partition: 'a full year at eight percent',
    input: '(1000000n, 8, 365)',
    run: () => pricing.priceForTargetYield(bu(1_000_000n), 8, 365),
    expected: returns(925_926n),
  },
  {
    field: 'pricing.priceForTargetYield(face, targetYieldPercent, daysRemaining)',
    partition: 'the yield that zeroes the factor escapes as roundDiv division by zero',
    edge: 'on',
    input: '(1000000n, -100, 365)',
    run: () => pricing.priceForTargetYield(bu(1_000_000n), -100, 365),
    expected: rangeError('division by zero'),
  },

  {
    field: 'pricing.maturityState(daysRemaining)',
    partition: 'one day left',
    edge: 'above',
    input: '1',
    run: () => pricing.maturityState(1),
    expected: returns('live'),
  },
  {
    field: 'pricing.maturityState(daysRemaining)',
    partition: 'maturity date itself',
    edge: 'on',
    input: '0',
    run: () => pricing.maturityState(0),
    expected: returns('due'),
  },
  {
    field: 'pricing.maturityState(daysRemaining)',
    partition: 'one day past',
    edge: 'below',
    input: '-1',
    run: () => pricing.maturityState(-1),
    expected: returns('past-due'),
  },
  {
    field: 'pricing.maturityLabel(state, settled)',
    partition: 'live and unsettled',
    input: '("live", false)',
    run: () => pricing.maturityLabel('live', false),
    expected: returns('Live'),
  },
  {
    field: 'pricing.maturityLabel(state, settled)',
    partition: 'live wins over settled',
    input: '("live", true)',
    run: () => pricing.maturityLabel('live', true),
    expected: returns('Live'),
  },
  {
    field: 'pricing.maturityLabel(state, settled)',
    partition: 'due and unsettled',
    input: '("due", false)',
    run: () => pricing.maturityLabel('due', false),
    expected: returns('Due'),
  },
  {
    field: 'pricing.maturityLabel(state, settled)',
    partition: 'settled wins over due',
    input: '("due", true)',
    run: () => pricing.maturityLabel('due', true),
    expected: returns('Settled'),
  },
  {
    field: 'pricing.maturityLabel(state, settled)',
    partition: 'past-due and unsettled',
    input: '("past-due", false)',
    run: () => pricing.maturityLabel('past-due', false),
    expected: returns('Overdue'),
  },
  {
    field: 'pricing.formatPercent(value, decimals)',
    partition: 'null renders the no-value glyph',
    input: '(null)',
    run: () => pricing.formatPercent(null),
    expected: returns('\u2014'),
  },
  {
    field: 'pricing.formatPercent(value, decimals)',
    partition: 'default two decimals',
    input: '(12.3456)',
    run: () => pricing.formatPercent(12.3456),
    expected: returns('12.35%'),
  },
  {
    field: 'pricing.formatPercent(value, decimals)',
    partition: 'one decimal, as the seeded yields are quoted',
    input: '(12.3456, 1)',
    run: () => pricing.formatPercent(12.3456, 1),
    expected: returns('12.3%'),
  },
  {
    field: 'pricing.isAbovePar(face, price)',
    partition: 'price just below face',
    edge: 'below',
    input: '(1000n, 999n)',
    run: () => pricing.isAbovePar(bu(1_000n), bu(999n)),
    expected: returns(false),
  },
  {
    field: 'pricing.isAbovePar(face, price)',
    partition: 'price exactly at face',
    edge: 'on',
    input: '(1000n, 1000n)',
    run: () => pricing.isAbovePar(bu(1_000n), bu(1_000n)),
    expected: returns(false),
  },
  {
    field: 'pricing.isAbovePar(face, price)',
    partition: 'price just above face',
    edge: 'above',
    input: '(1000n, 1001n)',
    run: () => pricing.isAbovePar(bu(1_000n), bu(1_001n)),
    expected: returns(true),
  },

  {
    field: 'clock.parseIsoDate(value)',
    partition: 'valid: the shape and the calendar agree',
    input: '"2026-01-01"',
    run: () => clock.parseIsoDate('2026-01-01'),
    expected: returns('2026-01-01'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'valid: last real day of February in a common year',
    edge: 'on',
    input: '"2026-02-28"',
    run: () => clock.parseIsoDate('2026-02-28'),
    expected: returns('2026-02-28'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'valid: a real leap day',
    input: '"2024-02-29"',
    run: () => clock.parseIsoDate('2024-02-29'),
    expected: returns('2024-02-29'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'valid: last day of the year',
    edge: 'on',
    input: '"2026-12-31"',
    run: () => clock.parseIsoDate('2026-12-31'),
    expected: returns('2026-12-31'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'wrong shape: a single-digit month',
    input: '"2026-1-01"',
    run: () => clock.parseIsoDate('2026-1-01'),
    expected: rangeError('expected a YYYY-MM-DD date, received "2026-1-01"'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'wrong shape: no separators',
    input: '"20260101"',
    run: () => clock.parseIsoDate('20260101'),
    expected: rangeError('expected a YYYY-MM-DD date, received "20260101"'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'wrong shape: a time component',
    input: '"2026-01-01T00"',
    run: () => clock.parseIsoDate('2026-01-01T00'),
    expected: rangeError('expected a YYYY-MM-DD date, received "2026-01-01T00"'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'wrong shape: empty',
    input: '""',
    run: () => clock.parseIsoDate(''),
    expected: rangeError('expected a YYYY-MM-DD date, received ""'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'right shape, month just below the first month',
    edge: 'below',
    input: '"2026-00-01"',
    run: () => clock.parseIsoDate('2026-00-01'),
    expected: rangeError('not a real calendar date: 2026-00-01'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'right shape, month just above the last month',
    edge: 'above',
    input: '"2026-13-01"',
    run: () => clock.parseIsoDate('2026-13-01'),
    expected: rangeError('not a real calendar date: 2026-13-01'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'right shape, day just below the first day',
    edge: 'below',
    input: '"2026-01-00"',
    run: () => clock.parseIsoDate('2026-01-00'),
    expected: rangeError('not a real calendar date: 2026-01-00'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'right shape, day above the longest month',
    edge: 'above',
    input: '"2026-12-32"',
    run: () => clock.parseIsoDate('2026-12-32'),
    expected: rangeError('not a real calendar date: 2026-12-32'),
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'a leap day in a common year is not a real calendar date, EB-01',
    edge: 'above',
    input: '"2026-02-29"',
    run: () => clock.parseIsoDate('2026-02-29'),
    expected: rangeError('not a real calendar date: 2026-02-29'),
    defect: 'EB-01',
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'no February ever has thirty days, EB-01',
    edge: 'above',
    input: '"2026-02-30"',
    run: () => clock.parseIsoDate('2026-02-30'),
    expected: rangeError('not a real calendar date: 2026-02-30'),
    defect: 'EB-01',
  },
  {
    field: 'clock.parseIsoDate(value)',
    partition: 'April has thirty days, EB-01',
    edge: 'above',
    input: '"2026-04-31"',
    run: () => clock.parseIsoDate('2026-04-31'),
    expected: rangeError('not a real calendar date: 2026-04-31'),
    defect: 'EB-01',
  },

  {
    field: 'clock.addDays(date, days)',
    partition: 'negative days are allowed here, unlike advance',
    edge: 'below',
    input: '("2026-01-01", -1)',
    run: () => clock.addDays(T0, -1),
    expected: returns('2025-12-31'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'zero days is a no-op',
    edge: 'on',
    input: '("2026-01-01", 0)',
    run: () => clock.addDays(T0, 0),
    expected: returns('2026-01-01'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'one day forward',
    edge: 'above',
    input: '("2026-01-01", 1)',
    run: () => clock.addDays(T0, 1),
    expected: returns('2026-01-02'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'a common year is 365 days',
    input: '("2026-01-01", 365)',
    run: () => clock.addDays(T0, 365),
    expected: returns('2027-01-01'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'February rolls into March without a 29th in a common year',
    input: '("2026-02-28", 1)',
    run: () => clock.addDays(day('2026-02-28'), 1),
    expected: returns('2026-03-01'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'a positive fraction of a day',
    input: '("2026-01-01", 0.5)',
    run: () => clock.addDays(T0, 0.5),
    expected: rangeError('addDays expects whole days, received 0.5'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'a negative fraction of a day',
    input: '("2026-01-01", -0.5)',
    run: () => clock.addDays(T0, -0.5),
    expected: rangeError('addDays expects whole days, received -0.5'),
  },
  {
    field: 'clock.addDays(date, days)',
    partition: 'not a number',
    input: '("2026-01-01", NaN)',
    run: () => clock.addDays(T0, NaN),
    expected: rangeError('addDays expects whole days, received NaN'),
  },

  {
    field: 'clock.clockAt(t0, offsetDays)',
    partition: 'a negative offset is accepted, unlike advance',
    edge: 'below',
    input: '("2026-01-01", -1)',
    run: () => clock.clockAt(T0, -1),
    expected: returns({ t0: '2026-01-01', offsetDays: -1 }),
  },
  {
    field: 'clock.clockAt(t0, offsetDays)',
    partition: 'the default offset',
    edge: 'on',
    input: '("2026-01-01")',
    run: () => clock.clockAt(T0),
    expected: returns({ t0: '2026-01-01', offsetDays: 0 }),
  },
  {
    field: 'clock.clockAt(t0, offsetDays)',
    partition: 'one day on',
    edge: 'above',
    input: '("2026-01-01", 1)',
    run: () => clock.clockAt(T0, 1),
    expected: returns({ t0: '2026-01-01', offsetDays: 1 }),
  },
  {
    field: 'clock.clockAt(t0, offsetDays)',
    partition: 'a fraction of a day',
    input: '("2026-01-01", 0.5)',
    run: () => clock.clockAt(T0, 0.5),
    expected: rangeError('offsetDays must be whole days, received 0.5'),
  },

  {
    field: 'clock.advance(clock, days)',
    partition: 'one day backwards',
    edge: 'below',
    input: '(offset 3, -1)',
    run: () => clock.advance(clock.clockAt(T0, 3), -1),
    expected: rangeError('the demo clock only moves forward in whole days, received -1'),
  },
  {
    field: 'clock.advance(clock, days)',
    partition: 'zero days is a legal no-op',
    edge: 'on',
    input: '(offset 3, 0)',
    run: () => clock.advance(clock.clockAt(T0, 3), 0),
    expected: returns({ t0: '2026-01-01', offsetDays: 3 }),
  },
  {
    field: 'clock.advance(clock, days)',
    partition: 'one day forward',
    edge: 'above',
    input: '(offset 3, 1)',
    run: () => clock.advance(clock.clockAt(T0, 3), 1),
    expected: returns({ t0: '2026-01-01', offsetDays: 4 }),
  },
  {
    field: 'clock.advance(clock, days)',
    partition: 'the larger fast-forward step',
    input: '(offset 3, 30)',
    run: () => clock.advance(clock.clockAt(T0, 3), 30),
    expected: returns({ t0: '2026-01-01', offsetDays: 33 }),
  },
  {
    field: 'clock.advance(clock, days)',
    partition: 'a fraction of a day',
    input: '(offset 0, 1.5)',
    run: () => clock.advance(clock.clockAt(T0, 0), 1.5),
    expected: rangeError('the demo clock only moves forward in whole days, received 1.5'),
  },

  {
    field: 'clock.daysBetween(from, to)',
    partition: 'the same day',
    edge: 'on',
    input: '("2026-01-01", "2026-01-01")',
    run: () => clock.daysBetween(T0, T0),
    expected: returns(0),
  },
  {
    field: 'clock.daysBetween(from, to)',
    partition: 'backwards is negative',
    edge: 'below',
    input: '("2026-01-02", "2026-01-01")',
    run: () => clock.daysBetween(day('2026-01-02'), T0),
    expected: returns(-1),
  },
  {
    field: 'clock.daysBetween(from, to)',
    partition: 'February has no 29th in a common year',
    input: '("2026-02-28", "2026-03-01")',
    run: () => clock.daysBetween(day('2026-02-28'), day('2026-03-01')),
    expected: returns(1),
  },
  {
    field: 'clock.daysBetween(from, to)',
    partition: 'February has a 29th in a leap year',
    input: '("2024-02-28", "2024-03-01")',
    run: () => clock.daysBetween(day('2024-02-28'), day('2024-03-01')),
    expected: returns(2),
  },
  {
    field: 'clock.tenorDays(issueDate, maturityDate)',
    partition: 'a quarter',
    input: '("2026-01-01", "2026-04-01")',
    run: () => clock.tenorDays(T0, day('2026-04-01')),
    expected: returns(90),
  },
  {
    field: 'clock.today(clock)',
    partition: 'the offset is applied to t0',
    input: '(offset 30)',
    run: () => clock.today(clock.clockAt(T0, 30)),
    expected: returns('2026-01-31'),
  },
  {
    field: 'clock.reset(clock)',
    partition: 'the offset goes back to zero and t0 does not move',
    input: '(offset 30)',
    run: () => clock.reset(clock.clockAt(T0, 30)),
    expected: returns({ t0: '2026-01-01', offsetDays: 0 }),
  },
  {
    field: 'clock.jumpToNextMaturity(clock, maturityDates)',
    partition: 'no maturities at all leaves the clock alone',
    edge: 'on',
    input: '(offset 0, [])',
    run: () => clock.jumpToNextMaturity(clock.clockAt(T0, 0), []),
    expected: returns({ t0: '2026-01-01', offsetDays: 0 }),
  },
  {
    field: 'clock.jumpToNextMaturity(clock, maturityDates)',
    partition: 'only past maturities leaves the clock alone',
    edge: 'below',
    input: '(offset 9, ["2026-01-01"])',
    run: () => clock.jumpToNextMaturity(clock.clockAt(T0, 9), [T0]),
    expected: returns({ t0: '2026-01-01', offsetDays: 9 }),
  },
  {
    field: 'clock.jumpToNextMaturity(clock, maturityDates)',
    partition: 'the soonest maturity still ahead wins',
    edge: 'above',
    input: '(offset 0, ["2026-01-10", "2026-03-01"])',
    run: () =>
      clock.jumpToNextMaturity(clock.clockAt(T0, 0), [day('2026-01-10'), day('2026-03-01')]),
    expected: returns({ t0: '2026-01-01', offsetDays: 9 }),
  },
  {
    field: 'clock.formatDaysRemaining(days)',
    partition: 'one day left',
    edge: 'above',
    input: '1',
    run: () => clock.formatDaysRemaining(1),
    expected: returns('1d'),
  },
  {
    field: 'clock.formatDaysRemaining(days)',
    partition: 'the maturity date itself',
    edge: 'on',
    input: '0',
    run: () => clock.formatDaysRemaining(0),
    expected: returns('Due'),
  },
  {
    field: 'clock.formatDaysRemaining(days)',
    partition: 'one day past, shown without a minus sign',
    edge: 'below',
    input: '-1',
    run: () => clock.formatDaysRemaining(-1),
    expected: returns('Overdue 1d'),
  },
  {
    field: 'clock.formatClock(clock)',
    partition: 'at t0 the offset is not shown',
    edge: 'on',
    input: '(offset 0)',
    run: () => clock.formatClock(clock.clockAt(T0, 0)),
    expected: returns('1 Jan 2026 (T0)'),
  },
  {
    field: 'clock.formatClock(clock)',
    partition: 'off t0 the offset is shown',
    edge: 'above',
    input: '(offset 30)',
    run: () => clock.formatClock(clock.clockAt(T0, 30)),
    expected: returns('31 Jan 2026 (T0 + 30d)'),
  },

  {
    field: 'market.parseFilter(params).tenorMin',
    partition: 'absent',
    input: '{}',
    run: () => market.parseFilter({}).tenorMin,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).tenorMin',
    partition: 'empty string reads as absent',
    input: '{ tmin: "" }',
    run: () => market.parseFilter({ tmin: '' }).tenorMin,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).tenorMin',
    partition: 'unparseable degrades to no filter rather than throwing',
    input: '{ tmin: "x" }',
    run: () => market.parseFilter({ tmin: 'x' }).tenorMin,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).tenorMin',
    partition: 'a positive fraction truncates toward zero',
    input: '{ tmin: "3.9" }',
    run: () => market.parseFilter({ tmin: '3.9' }).tenorMin,
    expected: returns(3),
  },
  {
    field: 'market.parseFilter(params).tenorMin',
    partition: 'a negative fraction truncates toward zero, not down',
    input: '{ tmin: "-3.9" }',
    run: () => market.parseFilter({ tmin: '-3.9' }).tenorMin,
    expected: returns(-3),
  },
  {
    field: 'market.parseFilter(params).tenorMin',
    partition: 'a repeated query parameter takes the first',
    input: '{ tmin: ["7", "9"] }',
    run: () => market.parseFilter({ tmin: ['7', '9'] }).tenorMin,
    expected: returns(7),
  },
  {
    field: 'market.parseFilter(params).tenorMax',
    partition: 'zero survives rather than reading as absent',
    edge: 'on',
    input: '{ tmax: "0" }',
    run: () => market.parseFilter({ tmax: '0' }).tenorMax,
    expected: returns(0),
  },
  {
    field: 'market.parseFilter(params).grades',
    partition: 'an unknown grade yields an empty list, which reads as all grades',
    input: '{ grade: "ZZZ" }',
    run: () => market.parseFilter({ grade: 'ZZZ' }).grades,
    expected: returns([]),
  },
  {
    field: 'market.parseFilter(params).grades',
    partition: 'a known grade in the wrong case is dropped',
    input: '{ grade: "aaa" }',
    run: () => market.parseFilter({ grade: 'aaa' }).grades,
    expected: returns([]),
  },
  {
    field: 'market.parseFilter(params).grades',
    partition: 'a mixed list keeps only the known members',
    input: '{ grade: "AAA,ZZZ" }',
    run: () => market.parseFilter({ grade: 'AAA,ZZZ' }).grades,
    expected: returns(['AAA']),
  },
  {
    field: 'market.parseFilter(params).grades',
    partition: 'every member known',
    input: '{ grade: "AAA,AA" }',
    run: () => market.parseFilter({ grade: 'AAA,AA' }).grades,
    expected: returns(['AAA', 'AA']),
  },
  {
    field: 'market.parseFilter(params).sort',
    partition: 'unknown falls back to the default',
    input: '{ sort: "nonsense" }',
    run: () => market.parseFilter({ sort: 'nonsense' }).sort,
    expected: returns('yield'),
  },
  {
    field: 'market.parseFilter(params).sort',
    partition: 'empty falls back to the default',
    input: '{ sort: "" }',
    run: () => market.parseFilter({ sort: '' }).sort,
    expected: returns('yield'),
  },
  {
    field: 'market.parseFilter(params).sort',
    partition: 'a known sort survives',
    input: '{ sort: "price" }',
    run: () => market.parseFilter({ sort: 'price' }).sort,
    expected: returns('price'),
  },
  {
    field: 'market.parseFilter(params).sizeMin',
    partition: 'size just below zero is dropped',
    edge: 'below',
    input: '{ smin: "-1" }',
    run: () => market.parseFilter({ smin: '-1' }).sizeMin,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).sizeMin',
    partition: 'size exactly zero survives as zero base units',
    edge: 'on',
    input: '{ smin: "0" }',
    run: () => market.parseFilter({ smin: '0' }).sizeMin,
    expected: returns(0n),
  },
  {
    field: 'market.parseFilter(params).sizeMin',
    partition: 'display units become base units',
    edge: 'above',
    input: '{ smin: "250000" }',
    run: () => market.parseFilter({ smin: '250000' }).sizeMin,
    expected: returns(2_500_000_000n),
  },
  {
    field: 'market.parseFilter(params).sizeMin',
    partition: 'sub-base-unit precision rounds up here, where parseUnits would throw',
    input: '{ smin: "0.00005" }',
    run: () => market.parseFilter({ smin: '0.00005' }).sizeMin,
    expected: returns(1n),
  },
  {
    field: 'market.parseFilter(params).sizeMax',
    partition: 'a non-finite size is dropped',
    input: '{ smax: "1e400" }',
    run: () => market.parseFilter({ smax: '1e400' }).sizeMax,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).yieldMin',
    partition: 'a non-finite yield is dropped',
    input: '{ ymin: "Infinity" }',
    run: () => market.parseFilter({ ymin: 'Infinity' }).yieldMin,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).yieldMin',
    partition: 'a negative yield floor survives, unlike a negative size',
    edge: 'below',
    input: '{ ymin: "-5" }',
    run: () => market.parseFilter({ ymin: '-5' }).yieldMin,
    expected: returns(-5),
  },
  {
    field: 'market.parseFilter(params).yieldMin',
    partition: 'a fractional yield keeps its fraction, unlike tenor',
    input: '{ ymin: "7.25" }',
    run: () => market.parseFilter({ ymin: '7.25' }).yieldMin,
    expected: returns(7.25),
  },
  {
    field: 'market.parseFilter(params).maturityBy',
    partition: 'a non-date is dropped',
    input: '{ by: "nope" }',
    run: () => market.parseFilter({ by: 'nope' }).maturityBy,
    expected: returns(null),
  },
  {
    field: 'market.parseFilter(params).maturityBy',
    partition: 'a real date survives',
    input: '{ by: "2026-06-30" }',
    run: () => market.parseFilter({ by: '2026-06-30' }).maturityBy,
    expected: returns('2026-06-30'),
  },
  {
    field: 'market.parseFilter(params).maturityBy',
    partition: 'only the shape is checked, so an impossible date survives, EB-01',
    input: '{ by: "2026-02-30" }',
    run: () => market.parseFilter({ by: '2026-02-30' }).maturityBy,
    expected: returns('2026-02-30'),
  },

  {
    field: 'market.isFiltered(filter)',
    partition: 'nothing set',
    input: 'NO_FILTER',
    run: () => market.isFiltered(market.NO_FILTER),
    expected: returns(false),
  },
  {
    field: 'market.isFiltered(filter)',
    partition: 'sort alone is not a filter',
    input: '{ sort: "price" }',
    run: () => market.isFiltered({ ...market.NO_FILTER, sort: 'price' }),
    expected: returns(false),
  },
  {
    field: 'market.isFiltered(filter)',
    partition: 'an empty grade list is not a filter',
    input: '{ grades: [] }',
    run: () => market.isFiltered({ ...market.NO_FILTER, grades: [] }),
    expected: returns(false),
  },
  {
    field: 'market.isFiltered(filter)',
    partition: 'one grade is a filter',
    input: '{ grades: ["AAA"] }',
    run: () => market.isFiltered({ ...market.NO_FILTER, grades: ['AAA'] }),
    expected: returns(true),
  },
  {
    field: 'market.isFiltered(filter)',
    partition: 'a zero tenor floor is a filter, since null is the unset value',
    edge: 'on',
    input: '{ tenorMin: 0 }',
    run: () => market.isFiltered({ ...market.NO_FILTER, tenorMin: 0 }),
    expected: returns(true),
  },
  {
    field: 'market.isFiltered(filter)',
    partition: 'a zero size floor is a filter',
    edge: 'on',
    input: '{ sizeMin: 0n }',
    run: () => market.isFiltered({ ...market.NO_FILTER, sizeMin: bu(0n) }),
    expected: returns(true),
  },

  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'no grade filter keeps every lot, ordered by yield',
    input: '{ grades: [] }',
    run: () => kept({}),
    expected: returns(['AAA', null, 'AA', 'A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'one grade keeps only that lot',
    input: '{ grades: ["AAA"] }',
    run: () => kept({ grades: ['AAA'] }),
    expected: returns(['AAA']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'an ungraded lot is excluded by any grade filter',
    input: '{ grades: ["AAA", "AA", "A"] }',
    run: () => kept({ grades: ['AAA', 'AA', 'A'] }),
    expected: returns(['AAA', 'AA', 'A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'the tenor floor is inclusive',
    edge: 'on',
    input: '{ tenorMin: 30 }',
    run: () => kept({ tenorMin: 30 }),
    expected: returns([null, 'AA']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'the tenor ceiling is inclusive',
    edge: 'on',
    input: '{ tenorMax: 10 }',
    run: () => kept({ tenorMax: 10 }),
    expected: returns(['AAA', 'A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'a floor and a ceiling on the same day keep only that day',
    edge: 'on',
    input: '{ tenorMin: 0, tenorMax: 0 }',
    run: () => kept({ tenorMin: 0, tenorMax: 0 }),
    expected: returns(['A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'a matured lot has no forward yield, so any yield floor drops it',
    edge: 'below',
    input: '{ yieldMin: 0 }',
    run: () => kept({ yieldMin: 0 }),
    expected: returns(['AAA', null, 'AA']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'the yield floor is inclusive',
    edge: 'on',
    input: '{ yieldMin: 9 }',
    run: () => kept({ yieldMin: 9 }),
    expected: returns(['AAA']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'a yield floor just above the best lot keeps nothing',
    edge: 'above',
    input: '{ yieldMin: 9.0001 }',
    run: () => kept({ yieldMin: 9.0001 }),
    expected: returns([]),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'the size floor is inclusive',
    edge: 'on',
    input: '{ sizeMin: 2000n }',
    run: () => kept({ sizeMin: bu(2_000n) }),
    expected: returns([null, 'AA', 'A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'the size ceiling is inclusive',
    edge: 'on',
    input: '{ sizeMax: 2000n }',
    run: () => kept({ sizeMax: bu(2_000n) }),
    expected: returns(['AAA', 'AA']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'the maturity cutoff is inclusive',
    edge: 'on',
    input: '{ maturityBy: "2026-04-01" }',
    run: () => kept({ maturityBy: day('2026-04-01') }),
    expected: returns(['AAA', 'AA', 'A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'one day before a maturity excludes it',
    edge: 'below',
    input: '{ maturityBy: "2026-03-31" }',
    run: () => kept({ maturityBy: day('2026-03-31') }),
    expected: returns(['AAA', 'A']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'sort by maturity, soonest first',
    input: '{ sort: "maturity" }',
    run: () => kept({ sort: 'maturity' }),
    expected: returns(['A', 'AAA', 'AA', null]),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'sort by tenor, shortest first',
    input: '{ sort: "tenor" }',
    run: () => kept({ sort: 'tenor' }),
    expected: returns(['A', 'AAA', 'AA', null]),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'sort by size, largest first',
    input: '{ sort: "size" }',
    run: () => kept({ sort: 'size' }),
    expected: returns([null, 'A', 'AA', 'AAA']),
  },
  {
    field: 'market.applyFilter(listings, filter).grades',
    partition: 'sort by price, cheapest first',
    input: '{ sort: "price" }',
    run: () => kept({ sort: 'price' }),
    expected: returns([null, 'AAA', 'AA', 'A']),
  },
];

function checkPure(c: PureCase): void {
  if ('value' in c.expected) {
    expect(c.run()).toEqual(c.expected.value);
    return;
  }
  let thrown: unknown;
  try {
    c.run();
  } catch (error) {
    thrown = error;
  }
  expect((thrown as Error | undefined)?.constructor.name).toBe(c.expected.error);
  expect((thrown as Error | undefined)?.message).toBe(c.expected.message);
}

function label(c: { edge?: Edge; partition: string; input: string }): string {
  return `${c.edge ? `[${c.edge}] ` : ''}${c.partition} :: ${c.input}`;
}

describe('layer 1: field validation in src/core', () => {
  for (const field of [...new Set(PURE_CASES.map((c) => c.field))]) {
    describe(field, () => {
      for (const c of PURE_CASES.filter((x) => x.field === field)) {
        (c.defect ? it.fails : it)(label(c), () => checkPure(c));
      }
    });
  }
});

// --- layer 2: field validation at the ledger.post() boundary -----------------

interface World {
  readonly anchorWallet: string;
  readonly supplierWallet: string;
  readonly lenderWallet: string;
  readonly supplierId: string;
  readonly lenderId: string;
  readonly transferPayableId: string;
  readonly shortPayableId: string;
  readonly exactPayableId: string;
  readonly takenRef: string;
  readonly takenInvoiceRef: string;
}

const UNKNOWN_ENTITY = 'e0000000-0000-0000-0000-000000000099';

type DbOutcome =
  | { readonly refused: { readonly code: string; readonly message: string } }
  | { readonly accepted: { readonly kind: string; readonly legAmounts: readonly string[] } };

const refused = (code: string, message: string): DbOutcome => ({ refused: { code, message } });
const accepted = (kind: string, legAmounts: readonly string[] = []): DbOutcome => ({
  accepted: { kind, legAmounts },
});

interface DbCase {
  readonly field: string;
  readonly partition: string;
  readonly edge?: Edge;
  readonly input: string;
  /** `n` is the row index, and is what keeps every generated reference unique. */
  readonly intent: (w: World, n: number) => Record<string, unknown>;
  readonly expected: DbOutcome;
  /** `no-key` omits the idempotency key entirely; `bad-key` sends a non-uuid. */
  readonly envelope?: 'no-key' | 'bad-key';
  readonly defect?: string;
}

const DB_CASES: readonly DbCase[] = [
  {
    field: 'envelope.idempotencyKey',
    partition: 'absent',
    input: 'no key at all',
    envelope: 'no-key',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'USDC', amountBase: 1 }),
    expected: refused('ADA17', 'every command needs an idempotencyKey'),
  },
  {
    field: 'envelope.idempotencyKey',
    partition: 'present but not a uuid',
    input: '"not-a-uuid"',
    envelope: 'bad-key',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'USDC', amountBase: 1 }),
    expected: refused('22P02', 'invalid input syntax for type uuid: "not-a-uuid"'),
  },
  {
    field: 'envelope.intent.kind',
    partition: 'absent',
    input: '{}',
    intent: () => ({}),
    expected: refused('ADA18', 'unknown intent kind <NULL>'),
  },
  {
    field: 'envelope.intent.kind',
    partition: 'empty',
    input: '""',
    intent: () => ({ kind: '' }),
    expected: refused('ADA18', 'unknown intent kind '),
  },
  {
    field: 'envelope.intent.kind',
    partition: 'a known verb in the wrong case',
    input: '"TOP_UP"',
    intent: () => ({ kind: 'TOP_UP' }),
    expected: refused('ADA18', 'unknown intent kind TOP_UP'),
  },
  {
    field: 'envelope.intent.kind',
    partition: 'a verb that does not exist',
    input: '"teleport"',
    intent: () => ({ kind: 'teleport' }),
    expected: refused('ADA18', 'unknown intent kind teleport'),
  },

  {
    field: 'top_up.amountBase',
    partition: 'below the positive floor',
    edge: 'below',
    input: '-1',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'USDC', amountBase: -1 }),
    expected: refused('ADA19', 'a top-up must be positive'),
  },
  {
    field: 'top_up.amountBase',
    partition: 'exactly zero, the last refused value',
    edge: 'on',
    input: '0',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'USDC', amountBase: 0 }),
    expected: refused('ADA19', 'a top-up must be positive'),
  },
  {
    field: 'top_up.amountBase',
    partition: 'one base unit, the first accepted value',
    edge: 'above',
    input: '1',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'USDC', amountBase: 1 }),
    expected: accepted('top_up', ['1', '-1']),
  },
  {
    field: 'top_up.amountBase',
    partition: 'an ordinary funding amount',
    input: '5000000',
    intent: (w) => ({
      kind: 'top_up',
      wallet: w.anchorWallet,
      cashCode: 'XSGD',
      amountBase: 5_000_000,
    }),
    expected: accepted('top_up', ['5000000', '-5000000']),
  },
  {
    field: 'top_up.amountBase',
    partition: 'absent, which the positive guard should still refuse, EB-06',
    input: 'field omitted',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'USDC' }),
    expected: refused('ADA19', 'a top-up must be positive'),
    defect: 'EB-06',
  },
  {
    field: 'top_up.cashCode',
    partition: 'inside the enum',
    input: '"XSGD"',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'XSGD', amountBase: 7 }),
    expected: accepted('top_up', ['7', '-7']),
  },
  {
    field: 'top_up.cashCode',
    partition: 'a plausible ticker outside the enum',
    input: '"EURC"',
    intent: (w) => ({ kind: 'top_up', wallet: w.anchorWallet, cashCode: 'EURC', amountBase: 7 }),
    expected: refused('22P02', 'invalid input value for enum ledger.cash_code: "EURC"'),
  },

  {
    field: 'transfer.quantityBase',
    partition: 'below the positive floor',
    edge: 'below',
    input: '-1',
    intent: (w) => ({
      kind: 'transfer',
      payableId: w.transferPayableId,
      fromWallet: w.supplierWallet,
      toWallet: w.lenderWallet,
      quantityBase: -1,
    }),
    expected: refused('ADA19', 'a transfer must be positive'),
  },
  {
    field: 'transfer.quantityBase',
    partition: 'exactly zero, the last refused value',
    edge: 'on',
    input: '0',
    intent: (w) => ({
      kind: 'transfer',
      payableId: w.transferPayableId,
      fromWallet: w.supplierWallet,
      toWallet: w.lenderWallet,
      quantityBase: 0,
    }),
    expected: refused('ADA19', 'a transfer must be positive'),
  },
  {
    field: 'transfer.quantityBase',
    partition: 'one base unit, the first accepted value',
    edge: 'above',
    input: '1',
    intent: (w) => ({
      kind: 'transfer',
      payableId: w.transferPayableId,
      fromWallet: w.supplierWallet,
      toWallet: w.lenderWallet,
      quantityBase: 1,
    }),
    expected: accepted('transfer', ['1', '-1']),
  },
  {
    field: 'transfer.quantityBase',
    partition: 'exactly the whole holding of a 500 base unit payable',
    edge: 'on',
    input: '500',
    intent: (w) => ({
      kind: 'transfer',
      payableId: w.exactPayableId,
      fromWallet: w.supplierWallet,
      toWallet: w.lenderWallet,
      quantityBase: 500,
    }),
    expected: accepted('transfer', ['500', '-500']),
  },
  {
    field: 'transfer.quantityBase',
    partition: 'one more than the whole holding',
    edge: 'above',
    input: '501',
    intent: (w) => ({
      kind: 'transfer',
      payableId: w.shortPayableId,
      fromWallet: w.supplierWallet,
      toWallet: w.lenderWallet,
      quantityBase: 501,
    }),
    expected: refused('ADA21', 'wallet SUPPLIER_WALLET holds 500 unlisted, needs 501'),
  },

  {
    field: 'create_payable.termsDays',
    partition: 'below the one day floor',
    edge: 'below',
    input: '0',
    intent: (w, n) => manualPayable(w, n, { termsDays: 0 }),
    expected: refused('ADA23', 'payment terms must be between 1 and 365 days'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'the shortest legal term',
    edge: 'on',
    input: '1',
    intent: (w, n) => manualPayable(w, n, { termsDays: 1 }),
    expected: accepted('payable_created'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'the longest legal term',
    edge: 'on',
    input: '365',
    intent: (w, n) => manualPayable(w, n, { termsDays: 365 }),
    expected: accepted('payable_created'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'one day past the ceiling',
    edge: 'above',
    input: '366',
    intent: (w, n) => manualPayable(w, n, { termsDays: 366 }),
    expected: refused('ADA23', 'payment terms must be between 1 and 365 days'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'negative',
    input: '-1',
    intent: (w, n) => manualPayable(w, n, { termsDays: -1 }),
    expected: refused('ADA23', 'payment terms must be between 1 and 365 days'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'absent, which the range guard does catch',
    input: 'field omitted',
    intent: (w, n) => manualPayable(w, n, { termsDays: undefined }),
    expected: refused('ADA23', 'payment terms must be between 1 and 365 days'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'a fraction of a day leaks the cast error rather than the range message',
    input: '30.7',
    intent: (w, n) => manualPayable(w, n, { termsDays: 30.7 }),
    expected: refused('22P02', 'invalid input syntax for type integer: "30.7"'),
  },
  {
    field: 'create_payable.termsDays',
    partition: 'a typical term',
    input: '90',
    intent: (w, n) => manualPayable(w, n, { termsDays: 90 }),
    expected: accepted('payable_created'),
  },

  {
    field: 'create_payable.faceBase',
    partition: 'below the positive floor',
    edge: 'below',
    input: '-1',
    intent: (w, n) => manualPayable(w, n, { faceBase: -1 }),
    expected: refused('ADA19', 'the face value must be greater than zero'),
  },
  {
    field: 'create_payable.faceBase',
    partition: 'exactly zero, the last refused value',
    edge: 'on',
    input: '0',
    intent: (w, n) => manualPayable(w, n, { faceBase: 0 }),
    expected: refused('ADA19', 'the face value must be greater than zero'),
  },
  {
    field: 'create_payable.faceBase',
    partition: 'one base unit, the first accepted value',
    edge: 'above',
    input: '1',
    intent: (w, n) => manualPayable(w, n, { faceBase: 1 }),
    expected: accepted('payable_created'),
  },
  {
    field: 'create_payable.faceBase',
    partition: 'absent, which the positive guard does catch',
    input: 'field omitted',
    intent: (w, n) => manualPayable(w, n, { faceBase: undefined }),
    expected: refused('ADA19', 'the face value must be greater than zero'),
  },
  {
    field: 'create_payable.faceBase',
    partition: 'a runbook-sized invoice',
    input: '2500000000',
    intent: (w, n) => manualPayable(w, n, { faceBase: 2_500_000_000 }),
    expected: accepted('payable_created'),
  },

  {
    field: 'create_payable.invoiceRef',
    partition: 'empty',
    input: '""',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: '' }),
    expected: refused('ADA25', 'an invoice reference is required'),
  },
  {
    field: 'create_payable.invoiceRef',
    partition: 'spaces only, which btrim reduces to empty',
    input: '"   "',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: '   ' }),
    expected: refused('ADA25', 'an invoice reference is required'),
  },
  {
    field: 'create_payable.invoiceRef',
    partition: 'absent, which COALESCE turns into empty',
    input: 'field omitted',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: undefined }),
    expected: refused('ADA25', 'an invoice reference is required'),
  },
  {
    field: 'create_payable.invoiceRef',
    partition: 'one character, the shortest accepted reference',
    edge: 'above',
    input: '"X"',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: `X${n}` }),
    expected: accepted('payable_created'),
  },
  {
    field: 'create_payable.invoiceRef',
    partition: 'padded with spaces, which btrim removes',
    input: '"  IR-PADDED  "',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: `  IR-PADDED-${n}  ` }),
    expected: accepted('payable_created'),
  },
  {
    field: 'create_payable.invoiceRef',
    partition: 'already financed for this supplier',
    input: 'a reference already in app.payable',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: w.takenInvoiceRef }),
    expected: refused(
      'ADA22',
      'invoice IR-EB-TAKEN has already been financed for this supplier',
    ),
  },
  {
    field: 'create_payable.invoiceRef',
    partition: 'whitespace that is not a space should still read as empty, EB-08',
    input: '"\\t"',
    intent: (w, n) => manualPayable(w, n, { invoiceRef: '\t' }),
    expected: refused('ADA25', 'an invoice reference is required'),
    defect: 'EB-08',
  },

  {
    field: 'create_payable.supplierId',
    partition: 'a uuid naming nothing',
    input: 'an unused uuid',
    intent: (w, n) => manualPayable(w, n, { supplierId: UNKNOWN_ENTITY }),
    expected: refused('ADA24', 'no such supplier'),
  },
  {
    field: 'create_payable.supplierId',
    partition: 'a real organisation of the wrong type',
    input: "a lender's entity id",
    intent: (w, n) => manualPayable(w, n, { supplierId: w.lenderId }),
    expected: refused('ADA24', 'no such supplier'),
  },
  {
    field: 'create_payable.ref',
    partition: 'already in use by another payable',
    input: 'a ref already in app.payable',
    intent: (w, n) => manualPayable(w, n, { ref: w.takenRef }),
    expected: refused('ADA26', 'reference TP-EB-TAKEN is already in use'),
  },
  {
    field: 'create_payable.ref',
    partition: 'absent, which leaks the table constraint rather than a domain code',
    input: 'field omitted',
    intent: (w, n) => manualPayable(w, n, { ref: undefined }),
    expected: refused(
      '23502',
      'null value in column "ref" of relation "payable" violates not-null constraint',
    ),
  },

  {
    field: 'set_programme_limit.limitBase',
    partition: 'below the non-negative floor',
    edge: 'below',
    input: '-1',
    intent: (w) => ({ kind: 'set_programme_limit', entityId: w.lenderId, limitBase: -1 }),
    expected: refused('ADA19', 'a programme limit cannot be negative'),
  },
  {
    field: 'set_programme_limit.limitBase',
    partition: 'exactly zero, the first accepted value',
    edge: 'on',
    input: '0',
    intent: (w) => ({ kind: 'set_programme_limit', entityId: w.lenderId, limitBase: 0 }),
    expected: accepted('programme_limit_set'),
  },
  {
    field: 'set_programme_limit.limitBase',
    partition: 'one base unit',
    edge: 'above',
    input: '1',
    intent: (w) => ({ kind: 'set_programme_limit', entityId: w.lenderId, limitBase: 1 }),
    expected: accepted('programme_limit_set'),
  },
  {
    field: 'set_programme_limit.limitBase',
    partition: 'explicit null clears the limit',
    input: 'null',
    intent: (w) => ({ kind: 'set_programme_limit', entityId: w.lenderId, limitBase: null }),
    expected: accepted('programme_limit_set'),
  },
  {
    field: 'set_programme_limit.limitBase',
    partition: 'absent, which also clears the limit',
    input: 'field omitted',
    intent: (w) => ({ kind: 'set_programme_limit', entityId: w.lenderId }),
    expected: accepted('programme_limit_set'),
  },
  {
    field: 'set_programme_limit.entityId',
    partition: 'a uuid naming nothing',
    input: 'an unused uuid',
    intent: () => ({ kind: 'set_programme_limit', entityId: UNKNOWN_ENTITY, limitBase: 5 }),
    expected: refused('ADA24', 'no such organisation'),
  },

  {
    field: 'set_certification.status',
    partition: 'inside the enum: uncertified',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId, status: 'uncertified' }),
    input: '"uncertified"',
    expected: accepted('issuer_certification_changed'),
  },
  {
    field: 'set_certification.status',
    partition: 'inside the enum: certified',
    input: '"certified"',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId, status: 'certified' }),
    expected: accepted('issuer_certification_changed'),
  },
  {
    field: 'set_certification.status',
    partition: 'inside the enum: suspended',
    input: '"suspended"',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId, status: 'suspended' }),
    expected: accepted('issuer_certification_changed'),
  },
  {
    field: 'set_certification.status',
    partition: 'a plausible status outside the enum',
    input: '"pending"',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId, status: 'pending' }),
    expected: refused('ADA19', 'unknown certification status pending'),
  },
  {
    field: 'set_certification.status',
    partition: 'a member of the enum in the wrong case',
    input: '"CERTIFIED"',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId, status: 'CERTIFIED' }),
    expected: refused('ADA19', 'unknown certification status CERTIFIED'),
  },
  {
    field: 'set_certification.status',
    partition: 'empty',
    input: '""',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId, status: '' }),
    expected: refused('ADA19', 'unknown certification status '),
  },
  {
    field: 'set_certification.status',
    partition: 'absent, which the enum guard should catch, EB-07',
    input: 'field omitted',
    intent: (w) => ({ kind: 'set_certification', entityId: w.lenderId }),
    expected: refused('ADA19', 'unknown certification status <NULL>'),
    defect: 'EB-07',
  },

  {
    field: 'advance_clock.days',
    partition: 'below the non-negative floor',
    edge: 'below',
    input: '-1',
    intent: () => ({ kind: 'advance_clock', days: -1 }),
    expected: refused('ADA19', 'the demo clock only moves forward'),
  },
  {
    field: 'advance_clock.days',
    partition: 'exactly zero, a legal no-op',
    edge: 'on',
    input: '0',
    intent: () => ({ kind: 'advance_clock', days: 0 }),
    expected: accepted('clock_advanced'),
  },
  {
    field: 'advance_clock.days',
    partition: 'one day forward',
    edge: 'above',
    input: '1',
    intent: () => ({ kind: 'advance_clock', days: 1 }),
    expected: accepted('clock_advanced'),
  },
  {
    field: 'advance_clock.days',
    partition: 'absent, which the forward-only guard should catch, EB-09',
    input: 'field omitted',
    intent: () => ({ kind: 'advance_clock' }),
    expected: refused('ADA19', 'the demo clock only moves forward'),
    defect: 'EB-09',
  },
];

function manualPayable(
  w: World,
  n: number,
  over: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: 'create_payable',
    supplierId: w.supplierId,
    ref: `TP-EB-${n}`,
    invoiceRef: `IR-EB-${n}`,
    faceBase: 1_000_000,
    termsDays: 30,
    ...over,
  };
}

interface Receipt {
  readonly kind: string;
  readonly legs: readonly { readonly amount: string }[];
}

let db: Database;
let world: World;

describe('layer 2: field validation at the ledger.post() boundary', () => {
  beforeAll(async () => {
    db = await freshDatabase('equivalence_boundary', 'fixtures');

    const must = async (intent: Record<string, unknown>) => {
      const result = await post(db.pool, intent);
      if (!result.ok) {
        throw new Error(`suite setup refused ${String(intent.kind)}: ${result.code} ${result.message}`);
      }
      return result;
    };

    const addressOf = async (entityType: string) =>
      (
        await db.pool.query<{ address: string }>(
          `SELECT w.address FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id
            WHERE e.entity_type = $1 ORDER BY e.name LIMIT 1`,
          [entityType],
        )
      ).rows[0]!.address;

    const idOf = async (entityType: string) =>
      (
        await db.pool.query<{ id: string }>(
          "SELECT id::text FROM app.entity WHERE entity_type = $1 ORDER BY name LIMIT 1",
          [entityType],
        )
      ).rows[0]!.id;

    const supplierId = await idOf('supplier');
    const supplierWallet = await addressOf('supplier');

    let tokenId = 970_000;
    const issue = async (ref: string, invoiceRef: string, faceBase: number) => {
      await must({ kind: 'create_payable', supplierId, ref, invoiceRef, faceBase, termsDays: 60 });
      const id = (
        await db.pool.query<{ id: string }>('SELECT id::text FROM app.payable WHERE ref = $1', [ref])
      ).rows[0]!.id;
      await must({ kind: 'submit', payableId: id });
      await must({ kind: 'approve', payableId: id });
      await must({ kind: 'grade', payableId: id, grade: 'AA', gradeRationale: 'suite setup' });
      await must({ kind: 'certify', payableId: id });
      tokenId += 1;
      await must({ kind: 'issue_payable', payableId: id, toWallet: supplierWallet, tokenId });
      await must({ kind: 'accept_receipt', payableId: id, holderWallet: supplierWallet });
      return id;
    };

    world = {
      anchorWallet: await addressOf('anchor'),
      supplierWallet,
      lenderWallet: await addressOf('lender'),
      supplierId,
      lenderId: await idOf('lender'),
      transferPayableId: await issue('TP-EB-XFER', 'IR-EB-XFER', 1_000_000),
      shortPayableId: await issue('TP-EB-SHORT', 'IR-EB-SHORT', 500),
      exactPayableId: await issue('TP-EB-EXACT', 'IR-EB-EXACT', 500),
      takenRef: 'TP-EB-TAKEN',
      takenInvoiceRef: 'IR-EB-TAKEN',
    };

    await must({
      kind: 'create_payable',
      supplierId,
      ref: world.takenRef,
      invoiceRef: world.takenInvoiceRef,
      faceBase: 1_000,
      termsDays: 30,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  // A row carrying a `defect` throws before reaching the inline oracle check,
  // so the books are proved here as well; every scenario ends on the oracle
  // whether its expectation held or not.
  afterEach(async () => {
    expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
  });

  for (const field of [...new Set(DB_CASES.map((c) => c.field))]) {
    describe(field, () => {
      for (const [index, c] of DB_CASES.entries()) {
        if (c.field !== field) continue;
        (c.defect ? it.fails : it)(label(c), async () => {
          const intent = c.intent(world, index);
          const result =
            c.envelope === 'no-key'
              ? await postWithoutKey(intent)
              : await post(db.pool, intent, c.envelope === 'bad-key' ? { key: 'not-a-uuid' } : {});

          if ('refused' in c.expected) {
            const seen = result.ok
              ? { code: 'accepted', message: 'the command was accepted' }
              : { code: result.code ?? 'none', message: result.message };
            expect(seen.code).toBe(c.expected.refused.code);
            expect(seen.message).toBe(
              c.expected.refused.message.replace('SUPPLIER_WALLET', world.supplierWallet),
            );
          } else {
            const seen: Receipt = result.ok
              ? (result.receipt as unknown as Receipt)
              : { kind: `refused ${result.code ?? 'none'}: ${result.message}`, legs: [] };
            expect(seen.kind).toBe(c.expected.accepted.kind);
            expect([...seen.legs.map((l) => l.amount)].sort()).toEqual(
              [...c.expected.accepted.legAmounts].sort(),
            );
          }

          expect(await ledgerHealth(db.pool)).toEqual(HEALTHY);
        });
      }
    });
  }
});

/**
 * `post()` always mints a key, so the one partition it cannot reach is the
 * absent one. This sends the envelope the application would send with the
 * field missing, and reports the refusal in the same shape.
 */
async function postWithoutKey(
  intent: Record<string, unknown>,
): Promise<{ ok: false; code: string | undefined; message: string }> {
  const envelope = { actorUserId: await anyActor(db.pool), intent };
  try {
    await db.pool.query('SELECT ledger.post($1::jsonb)', [JSON.stringify(envelope)]);
    return { ok: false, code: 'accepted', message: 'the command was accepted' };
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return { ok: false, code: err.code, message: err.message ?? String(error) };
  }
}
