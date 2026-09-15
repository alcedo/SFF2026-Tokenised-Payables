import { describe, expect, it } from 'vitest';

import { applyLedgerView, ledgerHref, parseLedgerSearch, transition } from '../ledger-view';

describe('parseLedgerSearch', () => {
  it('is closed when neither param is set', () => {
    expect(parseLedgerSearch(new URLSearchParams('grade=AAA'))).toEqual({ mode: 'closed' });
  });

  it('opens the log from ledger=log', () => {
    expect(parseLedgerSearch(new URLSearchParams('ledger=log'))).toEqual({ mode: 'log' });
  });

  it('opens a receipt from tx, even when ledger=log is also set', () => {
    expect(parseLedgerSearch(new URLSearchParams('ledger=log&tx=0xabc'))).toEqual({
      mode: 'receipt',
      txHash: '0xabc',
    });
  });

  it('treats an empty tx as absent', () => {
    expect(parseLedgerSearch(new URLSearchParams('tx=&ledger=log'))).toEqual({ mode: 'log' });
  });
});

describe('applyLedgerView', () => {
  it('preserves unrelated query keys when opening a receipt', () => {
    const next = applyLedgerView(new URLSearchParams('grade=AAA&tenor=30'), {
      mode: 'receipt',
      txHash: '0xdead',
    });
    expect(next.get('grade')).toBe('AAA');
    expect(next.get('tenor')).toBe('30');
    expect(next.get('ledger')).toBe('tx');
    expect(next.get('tx')).toBe('0xdead');
  });

  it('strips overlay keys on close and keeps the rest', () => {
    const next = applyLedgerView(new URLSearchParams('grade=AAA&ledger=log&tx=0xdead'), {
      mode: 'closed',
    });
    expect(next.toString()).toBe('grade=AAA');
  });

  it('builds a relative href', () => {
    expect(ledgerHref(new URLSearchParams(), { mode: 'log' })).toBe('?ledger=log');
    expect(ledgerHref(new URLSearchParams('grade=A'), { mode: 'closed' })).toBe('?grade=A');
    expect(ledgerHref(new URLSearchParams(), { mode: 'closed' })).toBe('?');
  });
});

describe('transition', () => {
  it('closes from any mode', () => {
    expect(transition({ mode: 'log' }, { type: 'close' })).toEqual({ mode: 'closed' });
    expect(transition({ mode: 'receipt', txHash: '0x1' }, { type: 'close' })).toEqual({
      mode: 'closed',
    });
  });

  it('opens a receipt from the log and returns with back_to_log', () => {
    expect(transition({ mode: 'log' }, { type: 'open_receipt', txHash: '0x1' })).toEqual({
      mode: 'receipt',
      txHash: '0x1',
    });
    expect(transition({ mode: 'receipt', txHash: '0x1' }, { type: 'back_to_log' })).toEqual({
      mode: 'log',
    });
  });
});
