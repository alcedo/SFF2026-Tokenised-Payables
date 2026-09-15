export type LedgerView =
  | { readonly mode: 'closed' }
  | { readonly mode: 'log' }
  | { readonly mode: 'receipt'; readonly txHash: string };

export const LEDGER_PARAM = 'ledger';
export const TX_PARAM = 'tx';

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function readParam(
  params: URLSearchParams | Readonly<Record<string, string | string[] | undefined>>,
  key: string,
): string | null {
  if (params instanceof URLSearchParams) {
    const value = params.get(key);
    return value === null || value === '' ? null : value;
  }
  const value = first(params[key]);
  return value === null || value === undefined || value === '' ? null : value;
}

/** Parse search params. `tx` wins when both params are set. */
export function parseLedgerSearch(
  params: URLSearchParams | Readonly<Record<string, string | string[] | undefined>>,
): LedgerView {
  const tx = readParam(params, TX_PARAM);
  if (tx !== null) return { mode: 'receipt', txHash: tx };
  const ledger = readParam(params, LEDGER_PARAM);
  if (ledger === 'log') return { mode: 'log' };
  return { mode: 'closed' };
}

/**
 * Write overlay params onto a copy of the current query, leaving marketplace
 * filters and other keys alone.
 */
export function applyLedgerView(current: URLSearchParams, view: LedgerView): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete(LEDGER_PARAM);
  next.delete(TX_PARAM);
  if (view.mode === 'log') next.set(LEDGER_PARAM, 'log');
  if (view.mode === 'receipt') next.set(TX_PARAM, view.txHash);
  return next;
}

/** Path-relative href that preserves unrelated query keys. */
export function ledgerHref(current: URLSearchParams, view: LedgerView): string {
  const query = applyLedgerView(current, view).toString();
  return query === '' ? '?' : `?${query}`;
}

export type LedgerEvent =
  | { readonly type: 'open_log' }
  | { readonly type: 'open_receipt'; readonly txHash: string }
  | { readonly type: 'back_to_log' }
  | { readonly type: 'close' };

export function transition(_view: LedgerView, event: LedgerEvent): LedgerView {
  switch (event.type) {
    case 'open_log':
    case 'back_to_log':
      return { mode: 'log' };
    case 'open_receipt':
      return { mode: 'receipt', txHash: event.txHash };
    case 'close':
      return { mode: 'closed' };
  }
}
