import { describe, expect, it } from 'vitest';

import {
  attempt,
  canTradeReceipt,
  isTradeable,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATUSES,
  type LifecycleEvent,
  type LifecycleStatus,
  type ReceiptStatus,
  type Role,
  ROLES,
} from '../lifecycle';
import { fromWholeUnits } from '../money';
import { isAbovePar, priceFromPercent } from '../pricing';
import { prdAttempt, prdCanTrade } from './prd-oracle';

describe('lifecycle decision table: every status × event × role', () => {
  const rows: {
    status: LifecycleStatus;
    event: LifecycleEvent;
    actor: Role;
    allow: boolean;
  }[] = [];

  for (const status of LIFECYCLE_STATUSES) {
    for (const event of LIFECYCLE_EVENTS) {
      for (const actor of ROLES) {
        rows.push({
          status,
          event,
          actor,
          allow: prdAttempt(status, event, actor).ok,
        });
      }
    }
  }

  it('has a row for every combination', () => {
    expect(rows).toHaveLength(LIFECYCLE_STATUSES.length * LIFECYCLE_EVENTS.length * ROLES.length);
  });

  for (const row of rows) {
    it(`${row.actor} ${row.event} while ${row.status} → ${row.allow ? 'allow' : 'refuse'}`, () => {
      const result = attempt(row.status, row.event, row.actor);
      expect(result.ok).toBe(row.allow);
      if (row.allow && result.ok) {
        const expected = prdAttempt(row.status, row.event, row.actor);
        if (expected.ok) expect(result.to).toBe(expected.to);
      }
    });
  }
});

describe('receipt × obligation tradeability', () => {
  const receipts: ReceiptStatus[] = ['pending', 'accepted', 'rejected'];
  const rows = LIFECYCLE_STATUSES.flatMap((status) =>
    receipts.map((receipt) => ({
      status,
      receipt,
      allow: prdCanTrade(status, receipt),
    })),
  );

  for (const row of rows) {
    it(`${row.status} / ${row.receipt} → ${row.allow ? 'trade' : 'hold'}`, () => {
      expect(isTradeable(row.status) && canTradeReceipt(row.receipt)).toBe(row.allow);
    });
  }
});

describe('price versus face', () => {
  const face = fromWholeUnits(250_000);
  const rows = [
    { bps: 1, above: false },
    { bps: 9785, above: false },
    { bps: 10_000, above: false },
    { bps: 10_001, above: true },
  ];

  for (const row of rows) {
    it(`${row.bps} bps is ${row.above ? 'above' : 'at or below'} par`, () => {
      const price = priceFromPercent(face, row.bps);
      expect(isAbovePar(face, price)).toBe(row.above);
    });
  }
});
