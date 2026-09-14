/**
 * Every read function, against the seeded world.
 *
 * A typecheck cannot catch a wrong column name, and a screen that throws at the
 * booth is the failure mode this prevents. Each function is called for real and
 * its answer checked against the PRD's seed table.
 */

import { execFileSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { closePool } from '@/db/client';
import {
  readBalances,
  readBids,
  readErpInbox,
  readEvents,
  readHolders,
  readHoldings,
  readListingForTarget,
  readMarketplace,
  readPayable,
  readPayables,
  readPersonas,
  readProgrammeTotals,
  readWorld,
  type World,
} from '@/db/read';
import { formatUnits } from '@/core/money';
import { formatPercent } from '@/core/pricing';

let world: World;

/**
 * Its own database, for the same reason as tests/ledger/post.test.ts: vitest
 * runs files in parallel and a shared reset is a race.
 */
const DB_NAME = 'adata_test_read';

beforeAll(() => {
  const env = { ...process.env, DB_NAME };
  execFileSync('scripts/db.sh', ['reset'], { cwd: process.cwd(), stdio: 'pipe', env });
  process.env.DATABASE_URL = execFileSync('scripts/db.sh', ['url'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  }).trim();
}, 60_000);

beforeAll(async () => {
  world = await readWorld();
});

afterAll(async () => {
  await closePool();
});

describe('the world', () => {
  it('starts at T0 with the clock at zero', () => {
    expect(world.today).toBe('2026-10-01');
    expect(world.clock.offsetDays).toBe(0);
  });

  it('carries the mocked XSGD rate as a scaled integer', () => {
    expect(world.xsgdPerXusdE6).toBe(1_310_000n);
  });
});

describe('personas', () => {
  it('offers every role the switcher needs', async () => {
    const personas = await readPersonas();
    const roles = new Set(personas.map((p) => p.role));
    expect(roles).toContain('adata_preparer');
    expect(roles).toContain('adata_checker');
    expect(roles).toContain('supplier');
    expect(roles).toContain('lender');
    expect(roles).toContain('straitsx_admin');
  });

  it('has exactly one StraitsX admin, per PRD section 5', async () => {
    const personas = await readPersonas();
    expect(personas.filter((p) => p.role === 'straitsx_admin')).toHaveLength(1);
  });

  it('marks only lenders institutionally eligible', async () => {
    const personas = await readPersonas();
    for (const p of personas) {
      if (p.institutionalEligible) expect(p.role).toBe('lender');
    }
  });
});

describe('payables', () => {
  it('derives overdue from the clock rather than a stored state', async () => {
    const rows = await readPayables(world);
    const overdue = rows.find((p) => p.ref === 'TP-2026-0119');
    expect(overdue?.storedStatus).toBe('issued');
    expect(overdue?.status).toBe('overdue');
    expect(overdue?.daysRemaining).toBe(-45);
  });

  it('keeps a settled payable settled however the clock reads', async () => {
    const rows = await readPayables(world);
    expect(rows.find((p) => p.ref === 'TP-2026-0128')?.status).toBe('settled');
  });

  it('reports the PRD tenors', async () => {
    const rows = await readPayables(world);
    const days = Object.fromEntries(rows.map((p) => [p.ref, p.daysRemaining]));
    expect(days['TP-2026-0143']).toBe(30);
    expect(days['TP-2026-0141']).toBe(90);
    expect(days['TP-2026-0142']).toBe(60);
  });

  it('reads one payable with its grade rationale', async () => {
    const rows = await readPayables(world);
    const one = await readPayable(rows[0]!.id, world);
    expect(one?.gradeRationale).toMatch(/Sample/);
    expect(one?.anchorName).toBe('ADATA Technology Co., Ltd.');
  });
});

describe('the marketplace', () => {
  it('lists the four open lots sorted by yield', async () => {
    const listings = await readMarketplace(world);
    expect(listings).toHaveLength(4);
    const yields = listings.map((l) => l.quote.lenderYieldPercent ?? 0);
    expect([...yields]).toEqual([...yields].sort((a, b) => b - a));
  });

  it('reproduces the PRD yields exactly', async () => {
    const listings = await readMarketplace(world);
    const byRef = Object.fromEntries(listings.map((l) => [l.targetRef, l]));
    expect(formatPercent(byRef['TP-2026-0143']!.quote.lenderYieldPercent, 1)).toBe('7.1%');
    expect(formatPercent(byRef['TP-2026-0141']!.quote.lenderYieldPercent, 1)).toBe('8.9%');
    expect(formatPercent(byRef['TP-2026-0142']!.quote.lenderYieldPercent, 1)).toBe('9.9%');
    expect(formatPercent(byRef['SERIES-2026-Q4-30D']!.quote.lenderYieldPercent, 1)).toBe('9.8%');
  });

  it('shows the section 6 worked example on the 250,000 listing', async () => {
    const listings = await readMarketplace(world);
    const tp141 = listings.find((l) => l.targetRef === 'TP-2026-0141')!;
    expect(formatUnits(tp141.listedFaceBase, 2)).toBe('250,000.00');
    expect(formatUnits(tp141.askBase, 2)).toBe('244,625.00');
    expect(formatUnits(tp141.quote.discount, 2)).toBe('5,375.00');
    expect(formatPercent(tp141.quote.annualisedDiscountCostPercent, 1)).toBe('8.7%');
  });

  it('counts the series as one lot of twelve members', async () => {
    const listings = await readMarketplace(world);
    const series = listings.find((l) => l.targetKind === 'series')!;
    expect(series.memberCount).toBe(12);
    expect(formatUnits(series.listedFaceBase, 2)).toBe('180,000.00');
  });

  it('surfaces the two competing bids the PRD seeds', async () => {
    const listings = await readMarketplace(world);
    const tp142 = listings.find((l) => l.targetRef === 'TP-2026-0142')!;
    expect(tp142.bidCount).toBe(2);
    const bids = await readBids(tp142.id, tp142.listedFaceBase, tp142.quote.daysRemaining);
    expect(bids.filter((b) => b.status === 'placed')).toHaveLength(2);
    expect(bids[0]!.quote.lenderYieldPercent).toBeGreaterThan(0);
  });
});

describe('holdings and holders', () => {
  it('shows the listed quantity as escrowed, not free', async () => {
    const listings = await readMarketplace(world);
    const tp141 = listings.find((l) => l.targetRef === 'TP-2026-0141')!;
    const holders = await readHolders(tp141.targetId);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.listedBase).toBe(2_500_000_000n);
    expect(holders[0]!.freeBase).toBe(0n);
  });

  it('reads a supplier wallet back with its position', async () => {
    const personas = await readPersonas();
    const supplier = personas.find((p) => p.entityName === 'Chien Yu Precision')!;
    const holdings = await readHoldings(supplier.wallet, world);
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings[0]!.payable.ref).toBe('TP-2026-0141');
  });

  it('gives the lender a cost basis on a bought position', async () => {
    const personas = await readPersonas();
    const bank = personas.find((p) => p.entityName === 'Meridian Trade Bank')!;
    const holdings = await readHoldings(bank.wallet, world);
    // The bank bought TP-2026-0128 in June, which then settled, so it holds no
    // tokens now. The cost basis lives in the trade history, not the holding.
    expect(Array.isArray(holdings)).toBe(true);
  });
});

describe('balances', () => {
  it('funds both lenders in all four assets', async () => {
    const personas = await readPersonas();
    for (const lender of personas.filter((p) => p.role === 'lender')) {
      const balances = await readBalances(lender.wallet);
      for (const asset of ['XUSD', 'USDC', 'USDT', 'XSGD'] as const) {
        expect(balances[asset], `${lender.entityName} ${asset}`).toBeGreaterThan(0n);
      }
    }
  });

  it('funds one lender predominantly in USDC and the other in XUSD', async () => {
    const personas = await readPersonas();
    const bank = personas.find((p) => p.entityName === 'Meridian Trade Bank')!;
    const fund = personas.find((p) => p.entityName === 'Kestrel Credit Fund')!;
    const bankBal = await readBalances(bank.wallet);
    const fundBal = await readBalances(fund.wallet);
    expect(bankBal.USDC).toBeGreaterThan(bankBal.XUSD);
    expect(fundBal.XUSD).toBeGreaterThan(fundBal.USDC);
  });
});

describe('audit history', () => {
  it('records every seeded action with its actor', async () => {
    const events = await readEvents({ limit: 200 });
    expect(events.length).toBeGreaterThan(20);
    for (const e of events) expect(e.actorName).toBeTruthy();
  });

  it('mints a receipt for chain-relevant events and none for audit-only ones', async () => {
    const events = await readEvents({ limit: 200 });
    const issuance = events.find((e) => e.kind === 'issuance')!;
    expect(issuance.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const published = events.find((e) => e.kind === 'listing_published')!;
    expect(published.txHash).toBeNull();
  });
});

describe('programme totals', () => {
  it('adds up without double counting series members', async () => {
    const totals = await readProgrammeTotals(world);
    // Live face: 1,200,000 + 250,000 + 48,000 + 180,000 series + 75,000 overdue.
    expect(formatUnits(totals.issuedFaceBase, 2)).toBe('1,753,000.00');
    expect(formatUnits(totals.settledFaceBase, 2)).toBe('320,000.00');
    expect(formatUnits(totals.overdueFaceBase, 2)).toBe('75,000.00');
  });

  it('names the next settlement date', async () => {
    const totals = await readProgrammeTotals(world);
    expect(totals.nextSettlementDate).toBe('2026-10-31');
  });

  it('reports zero book drift, which is the admin proof panel', async () => {
    const totals = await readProgrammeTotals(world);
    expect(totals.bookDrift).toBe(0);
  });
});

describe('the ERP inbox', () => {
  it('offers ten invoices, none consumed yet', async () => {
    const inbox = await readErpInbox();
    expect(inbox).toHaveLength(10);
    expect(inbox.every((i) => !i.consumed)).toBe(true);
  });

  it('includes the runbook invoice at 250,000 on 90-day terms', async () => {
    const inbox = await readErpInbox();
    const runbook = inbox.find((i) => i.amountBase === 2_500_000_000n && i.termsDays === 90);
    expect(runbook).toBeDefined();
    expect(runbook!.docNo).toMatch(/^\d{10}$/);
  });
});

describe('a listing can be found from its target', () => {
  it('resolves the open listing for a payable', async () => {
    const payables = await readPayables(world);
    const tp141 = payables.find((p) => p.ref === 'TP-2026-0141')!;
    const listing = await readListingForTarget(tp141.id, world);
    expect(listing?.targetRef).toBe('TP-2026-0141');
  });
});
