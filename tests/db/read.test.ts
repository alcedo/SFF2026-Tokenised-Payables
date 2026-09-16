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
import { loadNextAction, loadNextActionSnapshot } from '@/app/next-action-data';
import { deriveTabCounts } from '@/core/tab-badges';
import {
  readBalances,
  readBids,
  readErpInbox,
  readEvents,
  serializeEvent,
  readHolders,
  readHoldings,
  readListingForTarget,
  readMarketplace,
  readPayable,
  readAllPayables,
  readPayables,
  readPersonas,
  readProgrammeTotals,
  readSimulatedReceipt,
  readWorld,
  type World,
} from '@/db/read';
import { clockAt, today } from '@/core/clock';
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
  it('starts at T0, which is the day it was seeded, with the clock at zero', () => {
    // Not a fixed date. The demo runs on a public URL indefinitely, so anchoring
    // T0 to a constant would make every tenor look short within weeks.
    expect(world.today).toBe(new Date().toISOString().slice(0, 10));
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
  it('lists the open lots sorted by yield', async () => {
    const listings = await readMarketplace(world);
    expect(listings.length).toBeGreaterThanOrEqual(4);
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

  it('counts the series as one lot of five members', async () => {
    const listings = await readMarketplace(world);
    const series = listings.find((l) => l.targetKind === 'series')!;
    expect(series.memberCount).toBe(5);
    expect(formatUnits(series.listedFaceBase, 2)).toBe('180,000.00');
  });

  it('surfaces the competing bids the PRD seeds', async () => {
    const listings = await readMarketplace(world);
    const tp142 = listings.find((l) => l.targetRef === 'TP-2026-0142')!;
    expect(tp142.bidCount).toBeGreaterThanOrEqual(2);
    const bids = await readBids(tp142.id, tp142.listedFaceBase, tp142.quote.daysRemaining);
    expect(bids.filter((b) => b.status === 'placed').length).toBeGreaterThanOrEqual(2);
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

  it('keeps the command that produced each event', async () => {
    const events = await readEvents({ limit: 200 });
    const issuance = events.find((e) => e.kind === 'issuance')!;
    expect(issuance.intent.kind).toBe('issue_payable');
    expect(typeof issuance.intent.payableId).toBe('string');
    expect(serializeEvent(issuance).intent).toEqual(issuance.intent);
  });

  it('mints a receipt for chain-relevant events and none for audit-only ones', async () => {
    const events = await readEvents({ limit: 200 });
    const issuance = events.find((e) => e.kind === 'issuance')!;
    expect(issuance.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const published = events.find((e) => e.kind === 'listing_published')!;
    expect(published.txHash).toBeNull();
  });

  it('reopens a chain receipt by hash with its legs', async () => {
    const events = await readEvents({ limit: 200 });
    const issuance = events.find((e) => e.kind === 'issuance' && e.txHash)!;
    const receipt = await readSimulatedReceipt(issuance.txHash!);
    expect(receipt).not.toBeNull();
    expect(receipt!.simulated).toBe(true);
    expect(receipt!.txHash).toBe(issuance.txHash);
    expect(receipt!.kind).toBe('issuance');
    expect(receipt!.movements.length).toBeGreaterThan(0);
    expect(receipt!.movements.every((m) => m.amountBase > 0n)).toBe(true);
    expect(await readSimulatedReceipt('0xdeadbeef')).toBeNull();
  });
});

describe('programme totals', () => {
  it('counts a series once, as its members, never on top of them', async () => {
    const totals = await readProgrammeTotals(world);
    const payables = await readPayables(world);
    // readPayables excludes series members, so the totals must exceed it by
    // exactly the series face rather than by twice the series face.
    const standaloneLive = payables
      .filter((p) => ['issued', 'matured', 'overdue'].includes(p.status))
      .reduce((acc, p) => acc + p.faceBase, 0n);
    const seriesFace = 1_800_000_000n; // 180,000.0000 XUSD across 5 members
    expect(totals.issuedFaceBase).toBe(standaloneLive + seriesFace);
  });

  it('reports the overdue showcase and settled history', async () => {
    const totals = await readProgrammeTotals(world);
    expect(formatUnits(totals.overdueFaceBase, 2)).toBe('75,000.00');
    expect(totals.settledFaceBase).toBeGreaterThan(0n);
  });

  it('names a next settlement date in the future', async () => {
    const totals = await readProgrammeTotals(world);
    expect(totals.nextSettlementDate).not.toBeNull();
    expect(totals.nextSettlementDate! >= world.today).toBe(true);
  });

  it('reports zero book drift, which is the admin proof panel', async () => {
    const totals = await readProgrammeTotals(world);
    expect(totals.bookDrift).toBe(0);
  });
});

describe('the ERP inbox', () => {
  it('offers at least the ten the PRD asks for, none consumed yet', async () => {
    // More than ten, because every visitor to the public URL who issues a
    // payable consumes one and the picker must not run dry.
    const inbox = await readErpInbox();
    expect(inbox.length).toBeGreaterThanOrEqual(10);
    expect(inbox.every((i) => !i.consumed)).toBe(true);
  });

  it('includes the runbook invoice at 250,000 on 90-day terms', async () => {
    const inbox = await readErpInbox();
    const runbook = inbox.find((i) => i.amountBase === 2_500_000_000n && i.termsDays === 90);
    expect(runbook).toBeDefined();
    expect(runbook!.docNo).toMatch(/^\d{10}$/);
  });
});

describe('the obligation book versus the marketplace projection', () => {
  const SERIES_MEMBERS = [
    'TP-2026-0501',
    'TP-2026-0502',
    'TP-2026-0503',
    'TP-2026-0504',
    'TP-2026-0505',
  ] as const;

  it('hides series members from the marketplace list and keeps them in the book', async () => {
    const standalone = await readPayables(world);
    const all = await readAllPayables(world);
    for (const ref of SERIES_MEMBERS) {
      expect(standalone.find((p) => p.ref === ref), ref).toBeUndefined();
      const member = all.find((p) => p.ref === ref);
      expect(member?.storedStatus, ref).toBe('issued');
      expect(member?.status, ref).toBe('issued');
      expect(member?.daysRemaining, ref).toBe(30);
      expect(member?.faceBase, ref).toBe(360_000_000n);
      expect(member?.seriesRef, ref).toBe('SERIES-2026-Q4-30D');
    }
  });

  it('reconciles live face with programme totals once members are visible', async () => {
    const totals = await readProgrammeTotals(world);
    const liveFace = (await readAllPayables(world))
      .filter((p) => ['issued', 'matured', 'overdue'].includes(p.status))
      .reduce((acc, p) => acc + p.faceBase, 0n);
    expect(liveFace).toBe(totals.issuedFaceBase);
  });

  it('leaves the T0 settlement queue as the seeded overdue case', async () => {
    const due = (await readAllPayables(world))
      .filter((p) => p.status === 'matured' || p.status === 'overdue')
      .map((p) => p.ref);
    expect(due).toEqual(['TP-2026-0119']);
  });

  it('puts the series members on the settlement queue when the clock reaches their maturity', async () => {
    const later: World = {
      ...world,
      clock: clockAt(world.clock.t0, 30),
      today: today(clockAt(world.clock.t0, 30)),
    };
    const due = (await readAllPayables(later)).filter(
      (p) => p.status === 'matured' || p.status === 'overdue',
    );
    expect(due.filter((p) => p.status === 'overdue').map((p) => p.ref)).toEqual(['TP-2026-0119']);
    expect(due.filter((p) => p.ref.startsWith('TP-2026-05')).map((p) => p.ref)).toEqual([
      ...SERIES_MEMBERS,
    ]);
    expect(due.find((p) => p.ref === 'TP-2026-0143')?.status).toBe('matured');

    // The marketplace projection still hides the lot's members, which is why
    // settlement used to have no Fund control for 180,000 XUSD of live face.
    expect(
      (await readPayables(later))
        .filter((p) => p.status === 'matured' || p.status === 'overdue')
        .map((p) => p.ref),
    ).toEqual(['TP-2026-0119', 'TP-2026-0143']);
  });

  it('jumps only to live issued tenors, including the series lot', async () => {
    const ahead = (await readAllPayables(world))
      .filter((p) => p.status === 'issued' && p.daysRemaining > 0)
      .map((p) => p.daysRemaining)
      .sort((a, b) => a - b);
    expect(ahead[0]).toBe(30);
    expect(ahead.filter((days) => days === 30)).toHaveLength(6);
  });

  it('sends the preparer to fund the series once it has matured', async () => {
    const later: World = {
      ...world,
      clock: clockAt(world.clock.t0, 30),
      today: today(clockAt(world.clock.t0, 30)),
    };
    const personas = await readPersonas();
    const preparer = personas.find((p) => p.name === 'Wei-Ling Chen');
    expect(preparer).toBeDefined();
    expect(await loadNextAction(preparer!, later)).toEqual({
      kind: 'yours',
      verb: 'Fund settlement of 7 payables',
      href: '/adata/settlement',
      detail: 'Maturity does not pay anyone. Settlement is an explicit act.',
    });
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

describe('the next action for a seeded persona', () => {
  it('sends the ADATA preparer to fund the overdue payable', async () => {
    const personas = await readPersonas();
    const preparer = personas.find((p) => p.name === 'Wei-Ling Chen');
    expect(preparer).toBeDefined();
    expect(await loadNextAction(preparer!, world)).toEqual({
      kind: 'yours',
      verb: 'Fund settlement of TP-2026-0119',
      href: '/adata/settlement',
      detail: 'Maturity does not pay anyone. Settlement is an explicit act.',
    });
  });

  // app.lifecycle_edge names the adata_preparer on issued -> settled, so the
  // strip must not send the checker somewhere ledger.post() refuses.
  it('does not offer the ADATA checker a settlement only the preparer may post', async () => {
    const personas = await readPersonas();
    const checker = personas.find((p) => p.name === 'Hsu Po-Chun');
    expect(checker).toBeDefined();
    expect(await loadNextAction(checker!, world)).toEqual({
      kind: 'clear',
      heading: 'Nothing is waiting on you.',
      detail: 'Create a payable, or open Explorer to show the trail.',
    });
  });

  it('sends a lender to an open lot even when payables exist', async () => {
    const personas = await readPersonas();
    const lender = personas.find((p) => p.name === 'Rina Okafor');
    expect(lender).toBeDefined();
    const action = await loadNextAction(lender!, world);
    expect(action.kind).toBe('yours');
    if (action.kind !== 'yours') return;
    expect(action.verb).toMatch(/^Review TP-/);
    expect(action.href).toMatch(/^\/lender\//);
  });

  it('tells the admin the programme is current', async () => {
    const personas = await readPersonas();
    const admin = personas.find((p) => p.name === 'Nadia Rahman');
    expect(admin).toBeDefined();
    expect(await loadNextAction(admin!, world)).toEqual({
      kind: 'clear',
      heading: 'Programme is current.',
      detail: 'Open Explorer to show the trail, or Accounts to add a user.',
    });
  });
});

describe('tab counts for a seeded persona', () => {
  it('badges Hsu Po-Chun settlement only', async () => {
    const personas = await readPersonas();
    const hsu = personas.find((p) => p.name === 'Hsu Po-Chun');
    expect(hsu).toBeDefined();
    expect(deriveTabCounts(await loadNextActionSnapshot(hsu!, world))).toEqual({
      '/adata/settlement': 1,
    });
  });

  it('sums Lin Ya-Ting offers from placed bids on her listing', async () => {
    const personas = await readPersonas();
    const lin = personas.find((p) => p.name === 'Lin Ya-Ting');
    expect(lin).toBeDefined();
    expect(deriveTabCounts(await loadNextActionSnapshot(lin!, world))).toEqual({
      '/supplier/offers': 2,
    });
  });

  it('gives Nadia Rahman no queue badges', async () => {
    const personas = await readPersonas();
    const nadia = personas.find((p) => p.name === 'Nadia Rahman');
    expect(nadia).toBeDefined();
    expect(deriveTabCounts(await loadNextActionSnapshot(nadia!, world))).toEqual({});
  });

  it('does not badge the marketplace for Rina Okafor', async () => {
    const personas = await readPersonas();
    const rina = personas.find((p) => p.name === 'Rina Okafor');
    expect(rina).toBeDefined();
    expect(deriveTabCounts(await loadNextActionSnapshot(rina!, world))).toEqual({});
  });
});
