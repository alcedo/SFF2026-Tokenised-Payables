/**
 * Drive every pathway that leaves issuance, through the real UI.
 *
 *   scripts/serve.sh && node scripts/pathways.mjs
 *   node scripts/pathways.mjs --only accept-settle
 *   node scripts/pathways.mjs --shots
 *
 * scripts/runbook.mjs walks one long line through the app: issue, list, bid,
 * accept, advance, settle. It proves the headline path works and says nothing
 * about the branches leaving it. tests/techniques/model-based.test.ts covers
 * those branches exhaustively, but it calls ledger.post() directly and never
 * renders a screen, so a branch the ledger allows and no button reaches passes
 * there and fails a user.
 *
 * This is the gap between the two: the tree rooted at an issued payable, every
 * branch of it driven by clicking, as the persona who would really click it.
 *
 * A pathway is a row in PATHWAYS, not a function, so the set of pathways is a
 * list a reader can check against the lifecycle rather than control flow they
 * have to trace. Each row gets its own world, rebuilt through the app's own
 * reset, so no pathway can see what another one left behind.
 *
 * Three verdicts, because two would hide the interesting answer:
 *   PASS         the UI drove it and the ledger agrees
 *   FAIL         the UI drove it and the ledger disagrees, or a step broke
 *   UNREACHABLE  the ledger supports it and no control in the UI reaches it
 *
 * A row marked `expects: 'blocked'` asks the opposite question, whether the
 * system refuses something, so for those a missing control is the refusal
 * working and counts as a pass rather than as a gap.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import pg from 'pg';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/adata';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.argv.includes('--shots');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const OUT = 'out/pathways';

const PREPARER = 'Wei-Ling Chen';
const CHECKER = 'Hsu Po-Chun';
const ADMIN = 'Nadia Rahman';
const SUPPLIER = 'Tang Mei-Hua';
const OTHER_SUPPLIER = 'Kuo Shih-Chieh';
const LENDER = 'Sébastien Baptiste';
const OTHER_LENDER = 'Rina Okafor';

/** 250,000 XUSD on 90-day terms to Chien Yu Precision, present in both worlds. */
const INVOICE = '5100084412';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

class Unreachable extends Error {}

/** Declare a pathway unreachable rather than failing it, when no control exists. */
const unreachable = (what) => {
  throw new Unreachable(what);
};

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * The four things that must hold of the books after any sequence of commands,
 * asserted after every pathway. Same query tests/support/database.ts runs, so a
 * pathway driven by clicking is held to the standard a generated command
 * sequence is held to.
 */
async function books() {
  const [r] = await q(`
    SELECT
      (SELECT count(*) FROM ledger.prove_books_balance())                  AS projection_mismatches,
      (SELECT count(*) FROM (SELECT asset_id FROM ledger.account_balance
          GROUP BY asset_id HAVING SUM(balance) <> 0) c)                   AS unconserved_assets,
      (SELECT count(*) FROM ledger.account_balance
         WHERE balance < 0 AND class = 'wallet')                           AS negative_balances,
      (SELECT count(*) FROM (SELECT entry_id FROM ledger.journal_leg
          GROUP BY entry_id, asset_id HAVING SUM(amount) <> 0) u)          AS unbalanced_entries
  `);
  const broken = Object.entries(r).filter(([, v]) => Number(v) !== 0);
  if (broken.length) throw new Error(`books do not reconcile: ${broken.map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

async function payable(ref) {
  const [row] = await q(
    `SELECT ref, lifecycle_status, receipt_status, face_base FROM app.payable WHERE ref = $1`,
    [ref],
  );
  if (!row) throw new Error(`no payable ${ref}`);
  return row;
}

/** Who holds how much of a payable, and how much of it each has out on the market. */
async function holdings(ref) {
  return q(
    `SELECT e.name AS holder, h.quantity_base, h.free_base, h.listed_base
       FROM ledger.v_holding h
       JOIN app.wallet w  ON w.address = h.wallet_address
       JOIN app.entity e  ON e.id = w.entity_id
       JOIN app.payable p ON p.id = h.payable_id
      WHERE p.ref = $1 AND h.quantity_base > 0
      ORDER BY e.name`,
    [ref],
  );
}

async function heldBy(ref, entityFragment) {
  const rows = await holdings(ref);
  return rows.find((r) => r.holder.includes(entityFragment)) ?? null;
}

async function listingState(ref) {
  const [row] = await q(
    `SELECT l.status FROM app.listing l JOIN app.payable p ON p.id = l.target_payable_id
      WHERE p.ref = $1 ORDER BY l.created_at DESC LIMIT 1`,
    [ref],
  );
  return row?.status ?? null;
}

async function bidStates(ref) {
  return q(
    `SELECT b.status, count(*)::int AS n
       FROM app.bid b
       JOIN app.listing l ON l.id = b.listing_id
       JOIN app.payable p ON p.id = l.target_payable_id
      WHERE p.ref = $1 GROUP BY b.status ORDER BY b.status`,
    [ref],
  );
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const browser = await chromium.launch({
    executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (SHOTS) await mkdir(OUT, { recursive: true });

  const shot = async (name) => {
    if (SHOTS) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  };

  async function become(fragment) {
    const select = page.getByLabel('Switch persona');
    const value = await select.locator('option', { hasText: fragment }).first().getAttribute('value');
    if (!value) throw new Error(`no persona matching "${fragment}"`);
    await select.selectOption(value);
    await page.waitForTimeout(700);
  }

  async function go(path, as) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    if (as) {
      await become(as);
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    }
  }

  /** Arm a control, then confirm it, the way the screens ask a presenter to. */
  async function clickThrough(name, within = page) {
    const button = within.getByRole('button', { name, exact: false }).first();
    await button.click();
    const confirm = within.getByRole('button', { name: `Confirm: ${name}`, exact: false }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await page.waitForTimeout(900);
  }

  async function canClick(name, within = page) {
    return (await within.getByRole('button', { name, exact: false }).count()) > 0;
  }

  async function bodyText() {
    return page.locator('body').innerText();
  }

  async function expectOnScreen(needle, where) {
    const text = await bodyText();
    expect(text.includes(needle), `expected "${needle}" on ${where}`);
  }

  /**
   * Rebuild the minimal world through the app's own reset screen. The schema is
   * dropped and reloaded, so every persona gets a new id and the session cookie
   * from the previous pathway now names a user that does not exist. Landing on
   * '/' and switching again is what re-establishes it.
   */
  async function resetWorld() {
    await go('/', ADMIN);
    await page.goto(`${BASE}/reset`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: 'Minimal world' }).check();
    await page.getByRole('textbox', { name: 'Type RESET to confirm' }).fill('RESET');
    await clickThrough('Reset the world');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  }

  /**
   * ERP invoice to issued token, the prelude every pathway shares. Returns the
   * reference the system assigned, read off the queue row rather than guessed,
   * because the marketplace sorts by yield and "the newest" is not a position.
   */
  async function issue({ invoice = INVOICE } = {}) {
    await go('/adata/create', PREPARER);
    const row = page.locator('tr', { hasText: invoice }).first();
    await row.locator('input[type=radio]').check();
    await page.waitForTimeout(300);
    await clickThrough('Create payable');

    await go('/adata/approvals');
    const waiting = page
      .locator('section', { has: page.getByRole('button', { name: 'Submit for approval' }) })
      .first();
    const ref = (await waiting.innerText()).match(/TP-\d{4}-\d{4}/)?.[0];
    if (!ref) throw new Error('could not read the new payable reference');
    await clickThrough('Submit for approval');

    await go('/adata/approvals', CHECKER);
    await clickThrough('Approve');

    await go('/admin/grading', ADMIN);
    await clickThrough('Assign grade');
    await page.getByRole('button', { name: 'Certify', exact: true }).first().waitFor();
    await clickThrough('Certify');

    await go('/adata/approvals');
    await clickThrough('Issue to supplier');

    const state = await payable(ref);
    expect(state.lifecycle_status === 'issued', `after issuing, ${ref} is ${state.lifecycle_status}`);
    expect(state.receipt_status === 'pending', `after issuing, receipt is ${state.receipt_status}`);
    return ref;
  }

  /** Issue, then have the supplier take delivery, the root of every trade pathway. */
  async function issueAccepted(opts) {
    const ref = await issue(opts);
    await go('/supplier', SUPPLIER);
    await clickThrough('Accept');
    const state = await payable(ref);
    expect(state.receipt_status === 'accepted', `after accepting, receipt is ${state.receipt_status}`);
    return ref;
  }

  async function decline(ref) {
    await go('/supplier', SUPPLIER);
    if (!(await canClick('Decline'))) unreachable('no "Decline" control in the supplier inbox');
    await clickThrough('Decline');
    return payable(ref);
  }

  /**
   * Publish a listing from whoever currently holds the payable. The seller
   * reaches the form through their own screen, so the route differs for a
   * supplier selling what was issued to them and a lender relisting what they
   * bought, but the form is the same one.
   */
  async function list(ref, { as = SUPPLIER, from = '/supplier', quantity = null, buyNow = '245500', minPrice = null } = {}) {
    await go(from, as);
    const financing = page.getByRole('link', { name: /Request financing|Relist/ }).first();
    if ((await financing.count()) === 0) unreachable(`no financing link on ${from} for ${as}`);
    await financing.click();
    await page.waitForTimeout(900);
    if (quantity !== null) await page.getByLabel('Quantity to list').fill(String(quantity));
    if (minPrice !== null) await page.getByLabel('Minimum price as a percentage of face').fill(String(minPrice));
    if (buyNow !== null) await page.getByLabel('Buy now price').fill(String(buyNow));
    await page.waitForTimeout(300);
    if (!(await canClick('Publish listing'))) unreachable('the listing form never offered "Publish listing"');
    await clickThrough('Publish listing');
    return listingState(ref);
  }

  /** Open the marketplace detail screen for a payable, as a lender would. */
  async function openLot(ref, as = LENDER) {
    await go('/lender', as);
    const link = page.getByRole('link', { name: ref, exact: false }).first();
    if ((await link.count()) === 0) unreachable(`${ref} never appeared on the marketplace`);
    await link.click();
    await page.waitForTimeout(900);
  }

  async function bid(ref, { as = LENDER, percent = '97.85' } = {}) {
    await openLot(ref, as);
    const field = page.getByLabel('Price as a percentage of face').first();
    if ((await field.count()) === 0) unreachable(`no bid field on the lot screen for ${as}`);
    await field.fill(percent);
    await page.waitForTimeout(300);
    await clickThrough('Place bid');
  }

  async function buyNow(ref, as = LENDER) {
    await openLot(ref, as);
    if (!(await canClick('Buy now'))) unreachable(`no "Buy now" control on the lot screen for ${as}`);
    await clickThrough('Buy now');
  }

  async function acceptBid(as = SUPPLIER) {
    await go('/supplier/offers', as);
    if (!(await canClick('Accept'))) unreachable('no "Accept" control on the offers screen');
    await clickThrough('Accept');
  }

  async function withdrawListing(as = SUPPLIER) {
    await go('/supplier/offers', as);
    if (!(await canClick('Withdraw listing'))) unreachable('no "Withdraw listing" control on the offers screen');
    await clickThrough('Withdraw listing');
  }

  async function transfer({ as = SUPPLIER, quantity = null } = {}) {
    await go('/transfer', as);
    if (quantity !== null) await page.getByLabel('Quantity to send').fill(String(quantity));
    await page.waitForTimeout(300);
    if (!(await canClick('Send payable'))) unreachable('the transfer form never offered "Send payable"');
    await clickThrough('Send payable');
  }

  /** Move the demo clock to the next maturity, the control a presenter uses. */
  async function toMaturity() {
    await go('/', PREPARER);
    await clickThrough('Next maturity');
  }

  async function advanceDays(times = 1) {
    await go('/', PREPARER);
    for (let i = 0; i < times; i += 1) await clickThrough('+30d');
  }

  async function settle({ as = PREPARER, asset = 'XUSD' } = {}) {
    await go('/adata/settlement', as);
    const pick = page.getByRole('button', { name: asset, exact: true }).first();
    if ((await pick.count()) > 0) {
      await pick.click();
      await page.waitForTimeout(400);
    }
    const button = page.getByRole('button', { name: 'Fund settlement', exact: false }).first();
    if ((await button.count()) === 0) unreachable('no "Fund settlement" control on the settlement screen');
    if (await button.isDisabled()) {
      const why = (await button.getAttribute('title')) ?? 'disabled with no reason given';
      return { refused: true, why };
    }
    await clickThrough('Fund settlement');
    return { refused: false };
  }

  async function cancelPayable(as = CHECKER) {
    await go('/adata/approvals', as);
    if (!(await canClick('Cancel payable'))) unreachable('no "Cancel payable" control on the approvals queue');
    await clickThrough('Cancel payable');
  }

  async function setProgrammeLimit(limit) {
    await go('/admin/certification', ADMIN);
    await page.getByRole('textbox', { name: 'Programme limit' }).fill(String(limit));
    await page.waitForTimeout(400);
    await clickThrough('Set limit');
  }

  const ctx = {
    page, go, become, clickThrough, canClick, bodyText, expectOnScreen, shot,
    issue, issueAccepted, decline, list, openLot, bid, buyNow, acceptBid,
    withdrawListing, transfer, toMaturity, advanceDays, settle, cancelPayable,
    setProgrammeLimit, unreachable, expect, q, INVOICE,
    payable, holdings, heldBy, listingState, bidStates,
    SUPPLIER, OTHER_SUPPLIER, LENDER, OTHER_LENDER, PREPARER, CHECKER, ADMIN,
  };

  const results = [];
  for (const pathway of PATHWAYS) {
    if (ONLY && pathway.id !== ONLY) continue;
    const started = Date.now();
    let verdict = 'PASS';
    let detail = '';
    try {
      await resetWorld();
      await pathway.drive(ctx);
      await books();
    } catch (error) {
      if (error instanceof Unreachable && pathway.expects === 'blocked') {
        // The pathway asks whether the system refuses something. A control that
        // is not on the screen at all is the strongest form of refusing it, so
        // this is the pathway passing, not a gap in the UI.
        detail = `refused by omission: ${error.message}`;
      } else {
        verdict = error instanceof Unreachable ? 'UNREACHABLE' : 'FAIL';
        detail = error.message.split('\n')[0].slice(0, 150);
        await shot(`${pathway.id}-${verdict}`);
      }
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    results.push({ id: pathway.id, describes: pathway.describes, verdict, detail, secs });
    const mark = { PASS: '  ok', FAIL: 'FAIL', UNREACHABLE: 'n/a ' }[verdict];
    console.log(`${mark}  ${pathway.id.padEnd(28)} ${pathway.describes}${detail ? `\n        ${detail}` : ''}`);
  }

  await browser.close();
  await pool.end();

  const failed = results.filter((r) => r.verdict === 'FAIL');
  const unreachable_ = results.filter((r) => r.verdict === 'UNREACHABLE');
  console.log(`\n${results.length} pathways: ${results.filter((r) => r.verdict === 'PASS').length} pass, ${failed.length} fail, ${unreachable_.length} unreachable`);
  if (unreachable_.length) {
    console.log('\nsupported by the ledger, not reachable by clicking:');
    for (const r of unreachable_) console.log(`  ${r.id.padEnd(28)} ${r.detail}`);
  }
  if (failed.length) {
    console.log('\nfailures:');
    for (const r of failed) console.log(`  ${r.id.padEnd(28)} ${r.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

/**
 * The tree rooted at an issued payable. Read it against db/schema.sql's
 * lifecycle_edge rows and the market state machines: between them they are the
 * branches a payable can take, and each one below is a claim that a user can
 * actually take it by clicking.
 */
const PATHWAYS = [
  {
    id: 'issue',
    describes: 'ERP invoice reaches an issued token awaiting acceptance',
    drive: async ({ issue }) => {
      await issue();
    },
  },
  {
    id: 'accept',
    describes: 'supplier takes delivery, and the whole face is theirs',
    drive: async ({ issueAccepted, heldBy, expect }) => {
      const ref = await issueAccepted();
      const held = await heldBy(ref, 'Chien Yu');
      expect(held, 'the supplier holds nothing after accepting');
      expect(Number(held.quantity_base) === 2500000000, `supplier holds ${held.quantity_base}, expected the full face`);
      expect(Number(held.free_base) === 2500000000, 'the accepted holding is not free to trade');
    },
  },
  {
    id: 'decline',
    describes: 'supplier refuses delivery, and the face returns to the anchor',
    drive: async ({ issue, decline, heldBy, expect }) => {
      const ref = await issue();
      const after = await decline(ref);
      expect(after.receipt_status === 'rejected', `after declining, receipt is ${after.receipt_status}`);
      expect(after.lifecycle_status === 'issued', `declining moved the obligation to ${after.lifecycle_status}`);
      const anchor = await heldBy(ref, 'ADATA');
      expect(anchor && Number(anchor.quantity_base) === 2500000000, 'the refused face did not return to the anchor');
    },
  },
  {
    id: 'decline-then-cancel',
    describes: 'a refused payable is cancelled by the checker, burning it back',
    drive: async ({ issue, decline, cancelPayable, payable, holdings, expect }) => {
      const ref = await issue();
      await decline(ref);
      await cancelPayable();
      const after = await payable(ref);
      expect(after.lifecycle_status === 'cancelled', `after cancelling, status is ${after.lifecycle_status}`);
      expect((await holdings(ref)).length === 0, 'a cancelled payable still has holders');
    },
  },
  {
    id: 'cancel-after-accept',
    expects: 'blocked',
    describes: 'an accepted payable cannot be cancelled out from under its holder',
    drive: async ({ issueAccepted, cancelPayable, payable, expect }) => {
      const ref = await issueAccepted();
      await cancelPayable();
      const after = await payable(ref);
      expect(after.lifecycle_status === 'issued', `an accepted payable was cancelled, status is now ${after.lifecycle_status}`);
    },
  },
  {
    id: 'list-whole',
    describes: 'the accepted holding is listed whole on the marketplace',
    drive: async ({ issueAccepted, list, heldBy, expect }) => {
      const ref = await issueAccepted();
      const status = await list(ref);
      expect(status === 'open', `after publishing, the listing is ${status}`);
      const held = await heldBy(ref, 'Chien Yu');
      expect(Number(held.listed_base) === 2500000000, `only ${held.listed_base} of the face went on the market`);
      expect(Number(held.free_base) === 0, 'the whole holding was listed but some is still free');
    },
  },
  {
    id: 'list-partial',
    describes: 'part is listed and the remainder stays free with the seller',
    drive: async ({ issueAccepted, list, heldBy, expect }) => {
      const ref = await issueAccepted();
      const status = await list(ref, { quantity: '100000' });
      expect(status === 'open', `after publishing, the listing is ${status}`);
      const held = await heldBy(ref, 'Chien Yu');
      expect(Number(held.listed_base) === 1000000000, `listed ${held.listed_base}, expected 100,000 of face`);
      expect(Number(held.free_base) === 1500000000, `${held.free_base} left free, expected the 150,000 remainder`);
    },
  },
  {
    id: 'list-before-accept',
    expects: 'blocked',
    describes: 'a payable awaiting acceptance cannot be listed',
    drive: async ({ issue, list, listingState, expect }) => {
      const ref = await issue();
      try {
        await list(ref);
      } catch (error) {
        if (error.constructor.name !== 'Unreachable') throw error;
      }
      expect((await listingState(ref)) === null, 'a payable still awaiting acceptance was listed');
    },
  },
  {
    id: 'cancel-listing',
    describes: 'the seller withdraws the listing and gets the quantity back',
    drive: async ({ issueAccepted, list, withdrawListing, listingState, heldBy, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      await withdrawListing();
      expect((await listingState(ref)) === 'cancelled', `after withdrawing, the listing is ${await listingState(ref)}`);
      const held = await heldBy(ref, 'Chien Yu');
      expect(Number(held.free_base) === 2500000000, `${held.free_base} came back free, expected the whole face`);
    },
  },
  {
    id: 'bid-accept',
    describes: 'a lender bids, the seller accepts, and the lot changes hands',
    drive: async ({ issueAccepted, list, bid, acceptBid, heldBy, listingState, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      await bid(ref);
      await acceptBid();
      expect((await listingState(ref)) === 'filled', `after accepting, the listing is ${await listingState(ref)}`);
      const buyer = await heldBy(ref, 'Kestrel');
      expect(buyer && Number(buyer.quantity_base) === 2500000000, 'the buyer did not receive the lot');
      expect(!(await heldBy(ref, 'Chien Yu')), 'the seller still holds the lot they sold');
    },
  },
  {
    id: 'bid-withdraw',
    describes: 'a lender takes their own bid back off the table',
    drive: async ({ issueAccepted, list, bid, openLot, canClick, clickThrough, bidStates, unreachable, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      await bid(ref);
      await openLot(ref);
      if (!(await canClick('Withdraw bid'))) unreachable('no "Withdraw bid" control anywhere on the lot screen');
      await clickThrough('Withdraw bid');
      const states = await bidStates(ref);
      expect(states.some((s) => s.status === 'withdrawn'), `bids are ${JSON.stringify(states)}, none withdrawn`);
    },
  },
  {
    id: 'buy-now',
    describes: 'a lender takes the lot outright at the published price',
    drive: async ({ issueAccepted, list, buyNow, heldBy, listingState, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      await buyNow(ref);
      expect((await listingState(ref)) === 'filled', `after buying now, the listing is ${await listingState(ref)}`);
      const buyer = await heldBy(ref, 'Kestrel');
      expect(buyer && Number(buyer.quantity_base) === 2500000000, 'the buyer did not receive the lot');
    },
  },
  {
    id: 'buy-now-twice',
    expects: 'blocked',
    describes: 'a filled listing refuses a second buyer',
    drive: async ({ issueAccepted, list, buyNow, heldBy, unreachable, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      await buyNow(ref, LENDER);
      try {
        await buyNow(ref, OTHER_LENDER);
      } catch (error) {
        if (error.constructor.name !== 'Unreachable') throw error;
      }
      expect(!(await heldBy(ref, 'Meridian')), 'a second buyer took a lot that was already filled');
    },
  },
  {
    id: 'self-bid',
    expects: 'blocked',
    describes: 'a seller cannot bid on their own listing',
    drive: async ({ issueAccepted, list, bid, bidStates, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      try {
        await bid(ref, { as: SUPPLIER });
      } catch (error) {
        if (error.constructor.name !== 'Unreachable') throw error;
      }
      const states = await bidStates(ref);
      expect(states.length === 0, `the seller's own bid was recorded: ${JSON.stringify(states)}`);
    },
  },
  {
    id: 'transfer-whole',
    describes: 'the holder sends the whole payable to another wallet',
    drive: async ({ issueAccepted, transfer, holdings, expect }) => {
      const ref = await issueAccepted();
      await transfer({});
      const after = await holdings(ref);
      expect(after.length === 1, `after a whole transfer there are ${after.length} holders`);
      expect(!after[0].holder.includes('Chien Yu'), 'the sender still holds the payable they sent');
    },
  },
  {
    id: 'transfer-partial',
    describes: 'a part transfer splits the holding between two wallets',
    drive: async ({ issueAccepted, transfer, holdings, expect }) => {
      const ref = await issueAccepted();
      await transfer({ quantity: '100000' });
      const after = await holdings(ref);
      expect(after.length === 2, `after a part transfer there are ${after.length} holders, expected 2`);
      const total = after.reduce((sum, h) => sum + Number(h.quantity_base), 0);
      expect(total === 2500000000, `the split holdings sum to ${total}, not the face`);
    },
  },
  {
    id: 'settle',
    describes: 'the payable matures and the anchor pays the holder in XUSD',
    drive: async ({ issueAccepted, toMaturity, settle, payable, expect }) => {
      const ref = await issueAccepted();
      await toMaturity();
      const outcome = await settle({});
      expect(!outcome.refused, `settlement was refused: ${outcome.why}`);
      const after = await payable(ref);
      expect(after.lifecycle_status === 'settled', `after settling, status is ${after.lifecycle_status}`);
    },
  },
  {
    id: 'settle-xsgd',
    describes: 'the anchor discharges the same obligation funded in XSGD',
    drive: async ({ issueAccepted, toMaturity, settle, payable, expect }) => {
      const ref = await issueAccepted();
      await toMaturity();
      const outcome = await settle({ asset: 'XSGD' });
      expect(!outcome.refused, `XSGD settlement was refused: ${outcome.why}`);
      const after = await payable(ref);
      expect(after.lifecycle_status === 'settled', `after settling in XSGD, status is ${after.lifecycle_status}`);
    },
  },
  {
    id: 'settle-early',
    expects: 'blocked',
    describes: 'a payable that has not matured cannot be settled',
    drive: async ({ issueAccepted, settle, payable, expect }) => {
      const ref = await issueAccepted();
      const outcome = await settle({});
      const after = await payable(ref);
      expect(after.lifecycle_status === 'issued', `an unmatured payable settled anyway, status is ${after.lifecycle_status}`);
    },
  },
  {
    id: 'settle-twice',
    expects: 'blocked',
    describes: 'a settled payable cannot be settled again',
    drive: async ({ issueAccepted, toMaturity, settle, payable, expect }) => {
      const ref = await issueAccepted();
      await toMaturity();
      await settle({});
      try {
        await settle({});
      } catch (error) {
        if (error.constructor.name !== 'Unreachable') throw error;
      }
      const after = await payable(ref);
      expect(after.lifecycle_status === 'settled', `status after a second settlement is ${after.lifecycle_status}`);
    },
  },
  {
    id: 'settle-after-trade',
    describes: 'the anchor pays whoever holds it at maturity, not the original supplier',
    drive: async ({ issueAccepted, list, buyNow, toMaturity, settle, payable, expect }) => {
      const ref = await issueAccepted();
      await list(ref);
      await buyNow(ref);
      await toMaturity();
      const outcome = await settle({});
      expect(!outcome.refused, `settlement after a trade was refused: ${outcome.why}`);
      const after = await payable(ref);
      expect(after.lifecycle_status === 'settled', `after settling, status is ${after.lifecycle_status}`);
    },
  },
  {
    id: 'settle-split',
    describes: 'a payable split across two holders pays both at maturity',
    drive: async ({ issueAccepted, transfer, toMaturity, settle, holdings, payable, expect }) => {
      const ref = await issueAccepted();
      await transfer({ quantity: '100000' });
      expect((await holdings(ref)).length === 2, 'the holding did not split');
      await toMaturity();
      const outcome = await settle({});
      expect(!outcome.refused, `settling a split payable was refused: ${outcome.why}`);
      const after = await payable(ref);
      expect(after.lifecycle_status === 'settled', `after settling, status is ${after.lifecycle_status}`);
    },
  },
  {
    id: 'overdue',
    describes: 'a payable past its maturity reads as overdue and still settles',
    drive: async ({ issueAccepted, advanceDays, go, bodyText, settle, payable, expect, PREPARER }) => {
      const ref = await issueAccepted();
      await advanceDays(5);
      await go('/overdue', PREPARER);
      const text = await bodyText();
      expect(text.includes(ref), `${ref} is 60 days past due and not on the overdue screen`);
      const outcome = await settle({});
      expect(!outcome.refused, `an overdue payable could not be settled: ${outcome.why}`);
      expect((await payable(ref)).lifecycle_status === 'settled', 'the overdue payable did not settle');
    },
  },
  {
    id: 'issue-over-limit',
    expects: 'blocked',
    describes: 'an issuance beyond the programme limit is refused',
    drive: async ({ issue, setProgrammeLimit, q, expect }) => {
      await setProgrammeLimit('100000');
      try {
        await issue();
      } catch {
        // The prelude asserts it reached 'issued'; past the limit it must not,
        // so the throw is the expected outcome and the ledger below is the proof.
      }
      const rows = await q(`SELECT ref, lifecycle_status FROM app.payable WHERE lifecycle_status = 'issued'`);
      expect(rows.length === 0, `a payable issued past the programme limit: ${JSON.stringify(rows)}`);
    },
  },
  {
    id: 'settle-never-accepted',
    describes: 'a payable the supplier never took delivery of still matures and pays',
    drive: async ({ issue, toMaturity, settle, payable, expect }) => {
      const ref = await issue();
      await toMaturity();
      const outcome = await settle({});
      const after = await payable(ref);
      expect(
        after.lifecycle_status === 'settled' && after.receipt_status === 'pending',
        `expected the anchor to pay an unaccepted payable, got ${after.lifecycle_status}/${after.receipt_status}`
          + (outcome.refused ? ` (refused: ${outcome.why})` : ''),
      );
    },
  },
  {
    id: 'issue-suspended-issuer',
    expects: 'blocked',
    describes: 'a suspended issuer cannot issue',
    drive: async ({ issue, go, page, canClick, clickThrough, q, unreachable, expect, ADMIN }) => {
      await go('/admin/certification', ADMIN);
      // By its own label, not by role: the persona switcher is a combobox too,
      // and it is on every screen, so the first one on the page is that.
      const status = page.getByLabel('Certification status');
      if ((await status.count()) === 0) unreachable('no certification status control on the admin screen');
      await status.selectOption('suspended');
      await page.waitForTimeout(400);
      if (!(await canClick('Change status'))) unreachable('no "Change status" control on the admin screen');
      await clickThrough('Change status');
      try {
        await issue();
      } catch {
        // The prelude asserts it reached 'issued'. Under suspension it must not,
        // so the throw is expected and the ledger below is what proves it.
      }
      const rows = await q(`SELECT ref FROM app.payable WHERE lifecycle_status = 'issued'`);
      expect(rows.length === 0, `a suspended issuer issued anyway: ${JSON.stringify(rows)}`);
    },
  },
  {
    id: 'grade-by-supplier',
    expects: 'blocked',
    describes: 'a supplier cannot assign the credit grade on their own payable',
    drive: async ({ go, canClick, clickThrough, page, q, expect, SUPPLIER, PREPARER, CHECKER }) => {
      await go('/adata/create', PREPARER);
      const row = page.locator('tr', { hasText: INVOICE }).first();
      await row.locator('input[type=radio]').check();
      await page.waitForTimeout(300);
      await clickThrough('Create payable');
      await go('/adata/approvals');
      await clickThrough('Submit for approval');
      await go('/adata/approvals', CHECKER);
      await clickThrough('Approve');

      await go('/admin/grading', SUPPLIER);
      if (!(await canClick('Assign grade'))) return;
      await clickThrough('Assign grade');
      const graded = await q(`SELECT ref, grade FROM app.payable WHERE grade IS NOT NULL`);
      expect(graded.length === 0, `a supplier assigned grade ${graded[0]?.grade} to ${graded[0]?.ref}`);
    },
  },
];

run().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
