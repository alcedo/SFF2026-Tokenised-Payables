import { describe, expect, it } from 'vitest';

import { nextPayableRef, suggestInvoiceRef } from '../references';

describe('payable references', () => {
  it('continues the seeded series', () => {
    expect(nextPayableRef(['TP-2026-0139', 'TP-2026-0140', 'TP-2026-0141'])).toBe('TP-2026-0142');
  });

  it('starts at one on an empty programme', () => {
    expect(nextPayableRef([])).toBe('TP-2026-0001');
  });

  it('takes the highest rather than the last', () => {
    expect(nextPayableRef(['TP-2026-0141', 'TP-2026-0004'])).toBe('TP-2026-0142');
  });

  it('keeps four digits past the first hundred', () => {
    expect(nextPayableRef(['TP-2026-0099'])).toBe('TP-2026-0100');
  });
});

describe('invoice reference suggestions', () => {
  it('continues the highest numeric reference in the register', () => {
    expect(
      suggestInvoiceRef(['INV-TW-88301', 'INV-TW-91710', 'INV-TW-90551']),
    ).toBe('INV-TW-91711');
  });

  it('starts at one when nothing has been invoiced yet', () => {
    expect(suggestInvoiceRef([])).toBe('INV-TW-00001');
  });

  /**
   * INV-TW-88Q4A is the runbook's invoice. Reading its digits as 88 would
   * suggest INV-TW-00089, thousands below what the register already holds.
   */
  it('ignores references that are not a pure number', () => {
    expect(suggestInvoiceRef(['INV-TW-88Q4A', 'INV-TW-88301'])).toBe('INV-TW-88302');
    expect(suggestInvoiceRef(['INV-TW-88Q4A'])).toBe('INV-TW-00001');
  });

  it('ignores references from another series', () => {
    expect(suggestInvoiceRef(['TP-2026-0141', 'INV-SG-99999', 'INV-TW-00041'])).toBe(
      'INV-TW-00042',
    );
  });

  it('never suggests a reference it was given', () => {
    const taken = ['INV-TW-00001', 'INV-TW-00002', 'INV-TW-00003'];
    const suggested = suggestInvoiceRef(taken);
    expect(suggested).toBe('INV-TW-00004');
    expect(taken).not.toContain(suggested);
  });

  /**
   * The preparer creates one, the page reloads with it on the books, and the
   * next suggestion has to have moved on. A generator that hands back the same
   * number twice is refused by the database the second time.
   */
  it('advances once the suggestion has been used', () => {
    const taken = ['INV-TW-91710'];
    const first = suggestInvoiceRef(taken);
    expect(first).toBe('INV-TW-91711');
    expect(suggestInvoiceRef([...taken, first])).toBe('INV-TW-91712');
  });

  it('reads a five-digit series and a shorter one as the same sequence', () => {
    expect(suggestInvoiceRef(['INV-TW-123'])).toBe('INV-TW-00124');
  });
});
