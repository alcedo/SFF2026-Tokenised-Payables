import { describe, expect, it } from 'vitest';

import {
  parseAmount,
  parseHoldingQuantity,
  parseInvoiceRef,
  parseOptionalBuyNow,
  parsePricePercent,
  parseRequiredName,
  parseTermsDays,
} from '../input';
import { fromBaseUnits, fromWholeUnits } from '../money';
import { nextPayableRef, suggestInvoiceRef } from '../references';

interface Partition<T> {
  readonly name: string;
  readonly input: string;
  readonly want: T | 'reject';
}

function accepted<T>(result: { ok: boolean; value?: T }, value: T) {
  expect(result).toEqual({ ok: true, value });
}

function rejected(result: { ok: boolean; reason?: string }) {
  expect(result.ok).toBe(false);
  expect(result.reason ?? '').not.toBe('');
}

describe('amount: partitions and boundaries', () => {
  const cases: Partition<bigint>[] = [
    { name: 'minimum representable unit', input: '0.0001', want: 1n },
    { name: 'one whole unit', input: '1', want: 10_000n },
    { name: 'PRD worked example face', input: '250000', want: 2_500_000_000n },
    { name: 'four explicit decimals', input: '250000.0000', want: 2_500_000_000n },
    { name: 'grouped thousands', input: '250,000.00', want: 2_500_000_000n },
    { name: 'trailing zeros past four decimals', input: '1.50000000', want: 15_000n },
    { name: 'just below one whole unit', input: '0.9999', want: 9999n },
    { name: 'empty', input: '', want: 'reject' },
    { name: 'whitespace only', input: '   ', want: 'reject' },
    { name: 'zero', input: '0', want: 'reject' },
    { name: 'zero with decimals', input: '0.0000', want: 'reject' },
    { name: 'negative of the minimum', input: '-0.0001', want: 'reject' },
    { name: 'half a base unit', input: '0.00005', want: 'reject' },
    { name: 'non-zero digits past four decimals', input: '1.00001', want: 'reject' },
    { name: 'scientific notation', input: '1e5', want: 'reject' },
    { name: 'letters', input: 'ten', want: 'reject' },
    { name: 'two dots', input: '1.2.3', want: 'reject' },
    { name: 'bare dot', input: '.', want: 'reject' },
  ];

  for (const row of cases) {
    it(row.name, () => {
      const result = parseAmount(row.input);
      if (row.want === 'reject') rejected(result);
      else accepted(result, fromBaseUnits(row.want));
    });
  }
});

describe('payment terms: partitions and boundaries', () => {
  const cases: Partition<number>[] = [
    { name: 'lower bound', input: '1', want: 1 },
    { name: 'ADATA 30-day terms', input: '30', want: 30 },
    { name: 'PRD worked example tenor', input: '90', want: 90 },
    { name: 'ADATA 180-day terms', input: '180', want: 180 },
    { name: 'upper bound', input: '365', want: 365 },
    { name: 'padded whitespace', input: '  90  ', want: 90 },
    { name: 'zero days', input: '0', want: 'reject' },
    { name: 'just below lower bound', input: '-1', want: 'reject' },
    { name: 'just above upper bound', input: '366', want: 'reject' },
    { name: 'fractional day', input: '1.5', want: 'reject' },
    { name: 'empty', input: '', want: 'reject' },
    { name: 'not a number', input: 'ninety', want: 'reject' },
  ];

  for (const row of cases) {
    it(row.name, () => {
      const result = parseTermsDays(row.input);
      if (row.want === 'reject') rejected(result);
      else accepted(result, row.want);
    });
  }
});

describe('price percent: partitions and boundaries', () => {
  const cases: Partition<number>[] = [
    { name: 'one basis point', input: '0.01', want: 1 },
    { name: 'PRD worked example 97.85%', input: '97.85', want: 9785 },
    { name: 'par', input: '100', want: 10_000 },
    { name: 'zero', input: '0', want: 'reject' },
    { name: 'just below zero', input: '-0.01', want: 'reject' },
    { name: 'just above par', input: '100.01', want: 'reject' },
    { name: 'empty', input: '', want: 'reject' },
    { name: 'not a number', input: 'par', want: 'reject' },
  ];

  for (const row of cases) {
    it(row.name, () => {
      const result = parsePricePercent(row.input);
      if (row.want === 'reject') rejected(result);
      else accepted(result, row.want);
    });
  }
});

describe('holding quantity against free balance', () => {
  const free = fromWholeUnits(250_000);

  it('accepts the full unlisted holding (upper bound)', () => {
    accepted(parseHoldingQuantity('250000', free), free);
  });

  it('accepts one base unit (lower bound)', () => {
    accepted(parseHoldingQuantity('0.0001', free), fromBaseUnits(1n));
  });

  it('rejects one base unit over the holding', () => {
    rejected(parseHoldingQuantity('250000.0001', free));
  });

  it('rejects zero', () => {
    rejected(parseHoldingQuantity('0', free));
  });
});

describe('optional buy-now against a minimum price', () => {
  const min = fromWholeUnits(244_625);

  it('blank means bids only', () => {
    accepted(parseOptionalBuyNow('', min), null);
    accepted(parseOptionalBuyNow('   ', min), null);
  });

  it('accepts a price equal to the minimum (lower bound)', () => {
    accepted(parseOptionalBuyNow('244625', min), min);
  });

  it('accepts a price above the minimum', () => {
    accepted(parseOptionalBuyNow('250000', min), fromWholeUnits(250_000));
  });

  it('rejects a price one base unit below the minimum', () => {
    rejected(parseOptionalBuyNow('244624.9999', min));
  });
});

describe('names and invoice references', () => {
  it('accepts a trimmed company name', () => {
    accepted(parseRequiredName('  Formosa Precision  '), 'Formosa Precision');
  });

  it('rejects a blank name', () => {
    rejected(parseRequiredName(''));
    rejected(parseRequiredName('   '));
  });

  it('accepts a trimmed invoice reference', () => {
    accepted(parseInvoiceRef(' INV-TW-88213 '), 'INV-TW-88213');
  });

  it('rejects a blank invoice reference', () => {
    rejected(parseInvoiceRef(''));
    rejected(parseInvoiceRef('   '));
  });
});

describe('reference generators at their boundaries', () => {
  it('starts a payable series at 0001', () => {
    expect(nextPayableRef([])).toBe('TP-2026-0001');
  });

  it('rolls from 0999 to 1000 without dropping a digit', () => {
    expect(nextPayableRef(['TP-2026-0999'])).toBe('TP-2026-1000');
  });

  it('starts an invoice series at 00001', () => {
    expect(suggestInvoiceRef([])).toBe('INV-TW-00001');
  });

  it('does not treat a mixed invoice number as a sequence member', () => {
    expect(suggestInvoiceRef(['INV-TW-88Q4A'])).toBe('INV-TW-00001');
  });
});
