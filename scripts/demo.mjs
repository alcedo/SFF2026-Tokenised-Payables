/**
 * Drive the four things a presenter needs working before they open the app.
 *
 *   scripts/serve.sh && node scripts/demo.mjs
 *   APP_URL=http://127.0.0.1:3101 node scripts/demo.mjs
 *
 * scripts/screens.mjs proves every page renders and scripts/runbook.mjs proves
 * the headline path works. Neither notices an empty ERP register or an empty
 * supplier dropdown: a table with no rows renders perfectly and returns 200.
 * This drives the state a visitor actually meets.
 *
 * Deliberately world-agnostic. It asserts only what must hold of any world the
 * app can boot into, so it runs unchanged against the seeded catalogue and
 * against a database carrying nothing but db/fixtures.sql, which is what a
 * freshly provisioned host gets. scripts/fresh.sh runs it against the second.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';

// Candidates rather than one pinned path, so a bumped Playwright build does not
// silently fall back to a browser that is not there.
const EXECUTABLE = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome',
].find((candidate) => candidate && existsSync(candidate));

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

let step = 0;
let failed = 0;

function say(message) {
  step += 1;
  console.log(`${String(step).padStart(2, ' ')}. ${message}`);
}

function check(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`    FAIL  ${message}`);
  }
}

/**
 * Whether the rendered page says this.
 *
 * Case-insensitive on purpose. `innerText` returns text as the reader sees it,
 * and the panel headings carry `text-transform: uppercase`, so a literal match
 * on "Waiting on the ADATA checker" fails against a screen that plainly says
 * it. These assertions are about the words, not the styling.
 */
function says(text, phrase) {
  return new RegExp(phrase, 'i').test(text);
}

async function become(fragment) {
  const select = page.getByLabel('Switch persona');
  const value = await select.locator('option', { hasText: fragment }).first().getAttribute('value');
  if (!value) throw new Error(`no persona matching "${fragment}"`);
  await select.selectOption(value);
  await page.waitForTimeout(700);
}

/** The panel for one payable. Panels are siblings, so the ref picks exactly one. */
function panelFor(ref) {
  return page.locator('section', { hasText: ref }).first();
}

/** Arm a control and confirm it, the way a presenter does. */
async function fire(name, within) {
  const button = within.getByRole('button', { name, exact: false }).first();
  await button.click();
  const confirm = within.getByRole('button', { name: `Confirm: ${name}`, exact: false }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

async function openApprovals() {
  await page.goto(`${BASE}/adata/approvals`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Approval queue' }).first().waitFor({ timeout: 15_000 });
}

/**
 * Reload the queue until one payable's panel says something, and hand back what
 * it says.
 *
 * Waiting on the outcome rather than on the control's own success notice. A
 * write revalidates the whole layout, and the control that performed it is
 * unmounted by the re-render as soon as the status it belonged to is gone, so
 * its notice is not something to hold an assertion against. The queue moving is
 * the effect worth observing anyway.
 */
async function queueSaysOf(ref, phrase, what) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await openApprovals();
    const panel = panelFor(ref);
    if (await panel.count()) {
      const text = await panel.innerText();
      if (says(text, phrase)) return text;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${ref} never ${what} (looking for "${phrase}")`);
}

try {
  await page.goto(`${BASE}/adata/create`, { waitUntil: 'domcontentloaded' });
  await become('Wei-Ling Chen');
  await page.goto(`${BASE}/adata/create`, { waitUntil: 'domcontentloaded' });

  // ------------------------------------------------- 1. the ERP register --
  // The headline way in. Empty, the preparer's only option is to type an
  // invoice by hand, which is the path the PRD calls the exception.
  const selectable = await page.locator('table.ledger input[type=radio]:not([disabled])').count();
  check(selectable > 0, 'the ERP register offers no selectable invoice');
  const suppliersInRegister = new Set(
    await page.locator('table.ledger tbody tr td:nth-child(3)').allInnerTexts(),
  );
  check(
    suppliersInRegister.size >= 2,
    `the ERP register names ${suppliersInRegister.size} supplier(s), expected at least 2`,
  );
  say(
    `the ERP register arrives with ${selectable} invoices across ${suppliersInRegister.size} suppliers`,
  );

  // Picking one has to produce a complete draft without further typing.
  await page.locator('table.ledger input[type=radio]:not([disabled])').first().check();
  await page.waitForTimeout(300);
  const preview = await page.locator('body').innerText();
  check(says(preview, 'XUSD'), 'selecting an ERP invoice showed no face value');
  check(says(preview, 'Maturity date'), 'selecting an ERP invoice showed no maturity date');
  say('selecting one fills the draft: face, terms, issue and maturity dates');

  // ------------------------------------------- 2. manual entry prefilling --
  await page.goto(`${BASE}/adata/create?mode=manual`, { waitUntil: 'domcontentloaded' });

  const supplierOptions = await page.getByLabel('Supplier').locator('option').count();
  check(
    supplierOptions >= 2,
    `the supplier dropdown offers ${supplierOptions} option(s), expected at least 2`,
  );
  say(`manual entry offers ${supplierOptions} suppliers without onboarding anyone`);

  const suggested = await page.getByLabel('Invoice reference').inputValue();
  check(suggested !== '', 'the invoice reference opened empty rather than suggested');
  check(
    /^INV-TW-\d{5,}$/.test(suggested),
    `the suggested invoice reference "${suggested}" is not of the form INV-TW-nnnnn`,
  );
  say(`the invoice reference opens pre-filled with ${suggested}`);

  // Read the reference off the summary that shows it, not off the page. The
  // chrome strip names a payable of its own on every screen, so a body-wide
  // match picks whichever the acting persona is being nudged towards.
  const summary = page.locator('dl', { hasText: 'New reference' }).first();
  const payableRef = (await summary.innerText()).match(/TP-2026-\d{4}/)?.[0];
  if (!payableRef) throw new Error('manual entry showed no new payable reference');

  // Accept the suggestion untouched. If it collides with anything already on
  // the books, ledger.post() refuses here and the payable never reaches the
  // queue: "uniquely generated" is a claim about the database, not the regex.
  await page.getByLabel('Invoice face').fill('137500');
  await page.getByLabel('Payment terms').fill('60');
  await page.waitForTimeout(400);
  await fire('Create payable', page);

  const asDraft = await queueSaysOf(payableRef, 'Draft', 'reached the approval queue');
  check(
    says(asDraft, `Invoice\\s+${suggested}`),
    `${payableRef} did not carry the suggested invoice reference ${suggested}`,
  );
  say(`created ${payableRef} on the suggested reference, unedited`);

  // The next visit must not offer the number just used.
  await page.goto(`${BASE}/adata/create?mode=manual`, { waitUntil: 'domcontentloaded' });
  const nextSuggestion = await page.getByLabel('Invoice reference').inputValue();
  check(nextSuggestion !== suggested, `the suggestion stayed at ${suggested} after it was used`);
  say(`the suggestion advanced to ${nextSuggestion}`);

  // ------------------------------------------- 3. who the queue waits on --
  await openApprovals();
  const draftText = await panelFor(payableRef).innerText();
  check(says(draftText, 'Your turn'), `${payableRef} does not tell the preparer it is their move`);
  check(
    says(draftText, 'submit it for approval'),
    `${payableRef} does not say what the preparer must do`,
  );
  check(
    says(await page.locator('body').innerText(), 'waiting on you, Wei-Ling Chen'),
    'the queue header does not count what is waiting on the acting persona',
  );
  say('the queue tells the preparer it is their move, and what the move is');

  await fire('Submit for approval', panelFor(payableRef));
  const pending = await queueSaysOf(payableRef, 'Waiting on the ADATA checker', 'left draft');
  check(
    says(pending, 'Hsu Po-Chun'),
    `after submission ${payableRef} does not name the person who must act`,
  );
  check(
    says(pending, 'must approve it'),
    `after submission ${payableRef} does not name the awaited action`,
  );
  say('after submission it names the ADATA checker, Hsu Po-Chun, and the action');

  // The handover is the thing being proved: the same row reads differently to
  // the person who owes the next move.
  await become('Hsu Po-Chun');
  await openApprovals();
  const asChecker = await panelFor(payableRef).innerText();
  check(says(asChecker, 'Your turn'), 'the checker is not told the payable is theirs to approve');
  check(says(asChecker, 'approve it'), 'the checker is not told what to do');
  say('switching to the checker flips the same row to "Your turn"');

  await fire('Approve', panelFor(payableRef));
  const approved = await queueSaysOf(
    payableRef,
    'Waiting on the StraitsX admin',
    'handed off to StraitsX',
  );
  check(says(approved, 'Nadia Rahman'), `after approval ${payableRef} does not name the admin`);
  check(says(approved, 'assign a grade'), `after approval ${payableRef} does not ask for a grade`);
  check(says(approved, 'certify it'), `after approval ${payableRef} does not name the next action`);
  say('after approval it hands off to StraitsX, naming Nadia Rahman, the grade, and certification');
} catch (error) {
  failed += 1;
  console.error(`\nthrew at step ${step}: ${error.message}`);
} finally {
  await browser.close();
}

if (failed > 0) {
  console.log(`\n${failed} check${failed === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('\nthe demo opens ready: register filled, reference suggested, queue named');
