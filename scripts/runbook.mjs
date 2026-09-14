/**
 * Drive the five-minute runbook through the real UI, click by click.
 *
 * This is the executable form of the PRD's headline acceptance criterion: "A
 * viewer can issue → list → bid → accept → advance time → settle within five
 * minutes." The SQL suites prove the ledger; this proves a person can actually
 * reach those operations through the screens, in order, as the right personas.
 *
 *   scripts/serve.sh && node scripts/runbook.mjs [--shots]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const SHOTS = process.argv.includes('--shots');
const OUT = 'out/runbook';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (SHOTS) await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

let step = 0;
const started = Date.now();
const fail = (m) => {
  console.error(`\nFAIL at step ${step}: ${m}`);
  process.exitCode = 1;
};

async function shot(name) {
  if (SHOTS) await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
}

async function say(message) {
  step += 1;
  console.log(`${String(step).padStart(2, ' ')}. ${message}`);
}

async function become(fragment) {
  const select = page.getByLabel('Switch persona');
  const value = await select.locator('option', { hasText: fragment }).first().getAttribute('value');
  if (!value) throw new Error(`no persona matching "${fragment}"`);
  await select.selectOption(value);
  await page.waitForTimeout(700);
}

/** Arm a control, then confirm it. Mirrors what a presenter actually does. */
async function clickThrough(name) {
  const button = page.getByRole('button', { name, exact: false }).first();
  await button.click();
  const confirm = page.getByRole('button', { name: `Confirm: ${name}`, exact: false }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(900);
}

async function expectText(needle, where) {
  const body = await page.locator('body').innerText();
  if (!body.includes(needle)) throw new Error(`expected "${needle}" on ${where}`);
}

try {
  // ---------------------------------------------------------------- 1. issue
  await page.goto(`${BASE}/adata/create`, { waitUntil: 'domcontentloaded' });
  await become('Wei-Ling Chen');
  await page.goto(`${BASE}/adata/create`, { waitUntil: 'domcontentloaded' });
  await say('ADATA preparer opens the ERP invoice register');

  // The runbook invoice, seeded by db/seed.sql: document 5100084412, which is
  // 250,000 XUSD on 90-day terms to the active supplier. Matched by document
  // number because several invoices share an amount.
  const row = page.locator('tr', { hasText: '5100084412' }).first();
  await row.locator('input[type=radio]').check();
  await page.waitForTimeout(300);
  await expectText('250,000.0000 XUSD', 'the create screen');
  await shot('erp-picker');
  await say('selects the 250,000 XUSD invoice on 90-day terms');

  await clickThrough('Create payable');
  await say('creates the payable as a draft');

  await page.goto(`${BASE}/adata/approvals`, { waitUntil: 'domcontentloaded' });
  // Capture the reference the system assigned. The marketplace sorts by yield,
  // not by age, so "the newest listing" is not a position on the page.
  const created = (await page.locator('body').innerText()).match(/TP-2026-\d{4}/)?.[0];
  if (!created) throw new Error('could not read the new payable reference');
  await clickThrough('Submit for approval');
  await say('submits it for approval');

  await become('Hsu Po-Chun');
  await page.goto(`${BASE}/adata/approvals`, { waitUntil: 'domcontentloaded' });
  await shot('approval-queue');
  await clickThrough('Approve');
  await say('a different person, the ADATA checker, approves it');

  await become('Nadia Rahman');
  await page.goto(`${BASE}/admin/grading`, { waitUntil: 'domcontentloaded' });
  await clickThrough('Assign grade');
  await say('StraitsX assigns a sample grade with its rationale');

  await page.goto(`${BASE}/adata/approvals`, { waitUntil: 'domcontentloaded' });
  await clickThrough('Certify');
  await say('StraitsX certifies it under the programme');

  await page.goto(`${BASE}/adata/approvals`, { waitUntil: 'domcontentloaded' });
  await clickThrough('Issue to supplier');
  await say('issues the full face to the supplier wallet');

  // ----------------------------------------------------------------- 2. list
  await become('Tang Mei-Hua');
  await page.goto(`${BASE}/supplier`, { waitUntil: 'domcontentloaded' });
  // PRD §3 question 7: the payable lands in an inbox and must be accepted.
  await expectText('Awaiting your acceptance', 'the supplier inbox');
  await shot('supplier-inbox');
  await clickThrough('Accept');
  await say('supplier takes delivery from the inbox');

  await page.goto(`${BASE}/supplier`, { waitUntil: 'domcontentloaded' });
  await expectText('8.7%', 'the supplier dashboard');
  await expectText('244,625.00', 'the supplier dashboard');
  await expectText('18.0%', 'the supplier dashboard');
  await shot('supplier-comparison');
  await say('supplier sees 244,625 proceeds at 8.7% against an 18% bank rate');

  await page.getByRole('link', { name: 'Request financing' }).first().click();
  await page.waitForTimeout(800);
  await shot('request-financing');
  await clickThrough('Publish listing');
  await say('lists the whole payable at 97.85% of face');

  // ------------------------------------------------------------------ 3. bid
  await become('Rina Okafor');
  await page.goto(`${BASE}/lender`, { waitUntil: 'domcontentloaded' });
  await say(`lender opens the marketplace and finds ${created}`);

  // PRD §8 screen 9 asks for filters on maturity, tenor, grade, ticket size
  // and yield. The filter lives in the URL, so what the presenter narrows to
  // is also a link they can send afterwards.
  const allLots = await page.locator('table.ledger tbody tr').count();
  await page.getByRole('button', { name: 'AAA', exact: true }).click();
  await page.waitForTimeout(900);
  const aaaLots = await page.locator('table.ledger tbody tr').count();
  if (aaaLots >= allLots) throw new Error('filtering to AAA did not narrow the book');
  if (!page.url().includes('grade=AAA')) throw new Error('the filter did not reach the URL');
  await shot('marketplace-filtered');
  await say(`filters to AAA paper: ${aaaLots} of ${allLots} lots, and the URL carries it`);

  await page.getByRole('button', { name: 'Clear' }).click();
  await page.waitForTimeout(900);
  if ((await page.locator('table.ledger tbody tr').count()) !== allLots) {
    throw new Error('clearing the filter did not restore the book');
  }
  await say('clears it again, and the whole book comes back');

  // PRD §8 screen 10: "Expand a Series to inspect its members."
  await page.getByRole('link', { name: /^SERIES-/ }).first().click();
  await page.waitForTimeout(900);
  const members = await page.locator('details table.ledger tbody tr').count();
  if (members < 2) throw new Error('a series lot showed no member invoices');
  await page.locator('details summary').click();
  await page.waitForTimeout(400);
  await expectText('one holder across every member', 'the expanded series');
  await shot('series-members');
  await say(`opens the series lot and expands its ${members} member invoices`);

  await page.goto(`${BASE}/lender`, { waitUntil: 'domcontentloaded' });

  // PRD §8 screen 11 pairs buy-now with bidding. Proved here on a seeded lot
  // rather than on the runbook's own payable, so the headline path stays
  // issue → list → bid → accept and this stays the aside it is on the day.
  await page.getByRole('link', { name: 'TP-2026-0149', exact: true }).first().click();
  await page.waitForTimeout(900);
  await expectText('Buy now', 'a listing with a published buy-now price');
  await shot('buy-now');
  await clickThrough('Buy now');
  await expectText('Receipt', 'the buy-now result');
  await say('takes a different lot outright at its published price, no bidding');

  await page.goto(`${BASE}/lender/portfolio`, { waitUntil: 'domcontentloaded' });
  await expectText('TP-2026-0149', 'the portfolio after buying now');
  await say('that lot is in the portfolio immediately, with its cost basis');

  await page.goto(`${BASE}/lender`, { waitUntil: 'domcontentloaded' });

  // Open it by reference rather than by position: listings are sorted by yield.
  await page.getByRole('link', { name: created, exact: true }).first().click();
  await page.waitForTimeout(900);
  await expectText('Anchor obligor', 'the payable detail');
  await shot('payable-detail');
  await say('reads the detail, which leads with ADATA and the obligation');

  await clickThrough('Place bid');
  await say('bids at the ask, funded in USDC');

  // --------------------------------------------------------------- 4. accept
  await become('Tang Mei-Hua');
  await page.goto(`${BASE}/supplier/offers`, { waitUntil: 'domcontentloaded' });
  await shot('offers-received');
  await clickThrough('Accept');
  await say('supplier accepts the offer; the trade settles atomically');

  await page.goto(`${BASE}/supplier`, { waitUntil: 'domcontentloaded' });
  await expectText('244,625.00', 'the supplier dashboard after the sale');
  await say('supplier now holds 244,625 XUSD, 90 days early');

  // -------------------------------------------------------- 5. advance time
  await become('Wei-Ling Chen');
  await page.goto(`${BASE}/adata`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: '+30d' }).click();
    await page.waitForTimeout(1000);
  }
  await say('fast-forwards 90 days; every tenor and yield re-ages at once');

  // -------------------------------------------------------------- 6. settle
  await page.goto(`${BASE}/adata/settlement`, { waitUntil: 'domcontentloaded' });
  await expectText('Settlement', 'the settlement screen');
  await shot('settlement');
  await clickThrough('Fund settlement');
  await say('ADATA funds settlement to the current holder');

  await page.goto(`${BASE}/explorer`, { waitUntil: 'domcontentloaded' });
  await expectText('Balanced', 'the explorer');
  await shot('explorer');
  await say('the books still reconcile to the journal after the full run');

  // --------------------------------------------------- 7. the other way in
  // PRD §8 screen 2 offers manual entry alongside the ERP import. Shown last
  // because the ERP picker is the headline path, and the draft it leaves
  // behind is cleared by the reset immediately below.
  await become('Wei-Ling Chen');
  await page.goto(`${BASE}/adata/create?mode=manual`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Invoice reference').fill('INV-TW-BYHAND-01');
  await page.getByLabel('Invoice face').fill('412500');
  await page.getByLabel('Payment terms').fill('45');
  await page.waitForTimeout(400);
  await expectText('412,500.0000 XUSD', 'the manual entry preview');
  await shot('manual-entry');
  await clickThrough('Create payable');
  // Creation is an audit event, not a chain one, so §10 gives it no receipt.
  await expectText('Done.', 'the manual creation result');
  await say('creates a second payable by hand, for an invoice the ERP does not have');

  await page.goto(`${BASE}/adata/approvals`, { waitUntil: 'domcontentloaded' });
  await expectText('INV-TW-BYHAND-01', 'the approval queue');
  await say('it lands in the same approval queue as an imported one');

  // The same invoice cannot be financed twice, whichever way it was entered.
  await page.goto(`${BASE}/adata/create?mode=manual`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Invoice reference').fill('INV-TW-BYHAND-01');
  await page.getByLabel('Invoice face').fill('412500');
  await page.getByLabel('Payment terms').fill('45');
  await page.waitForTimeout(400);
  await clickThrough('Create payable');
  await expectText('already been financed for this supplier', 'the duplicate refusal');
  await say('entering the same invoice again is refused, not silently duplicated');

  // ------------------------------------------------------- 8. reset guards
  // The demo runs on a public URL, so the one control that destroys everyone
  // else's session is checked here rather than trusted. Last, because a
  // successful reset is also how the world is handed to the next presenter.
  await become('Rina Okafor');
  await page.goto(`${BASE}/reset`, { waitUntil: 'domcontentloaded' });
  await expectText('Only the StraitsX administrator', 'reset as a lender');
  if (await page.getByRole('button', { name: 'Reset the world' }).isVisible().catch(() => false)) {
    throw new Error('a lender was offered the reset button');
  }
  await say('a lender cannot reach the reset control at all');

  await become('Nadia Rahman');
  await page.goto(`${BASE}/reset`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Type RESET to confirm').fill('reset');
  await page.getByRole('button', { name: 'Reset the world' }).click();
  await page.waitForTimeout(1200);
  await expectText('Type RESET exactly', 'the refused reset');
  await expectText('T0 + 90d', 'the clock after a refused reset');
  await say('a mistyped confirmation is refused, and the clock has not moved');

  await page.getByLabel('Type RESET to confirm').fill('RESET');
  await page.getByRole('button', { name: 'Reset the world' }).click();
  await page.waitForTimeout(6000);
  await expectText('T0', 'the clock after the reset');
  await page.goto(`${BASE}/lender`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').innerText();
  if (body.includes(created)) throw new Error(`${created} survived the reset`);
  await shot('after-reset');
  await say('the admin resets the world, and it is seeded and ready for the next run');

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\nrunbook complete in ${seconds}s of machine time`);
} catch (e) {
  fail(e.message);
  await shot('failure');
} finally {
  await browser.close();
}
