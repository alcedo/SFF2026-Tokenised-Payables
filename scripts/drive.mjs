/**
 * Drive one screen, or one short path through several, without writing a script.
 *
 * screens.mjs proves every page renders and runbook.mjs proves the whole demo
 * in one fixed order. Neither helps when the question is "does this one
 * control on this one page still do what it says". Until now the answer was to
 * copy `become` and `clickThrough` out of the runbook into a scratch file, and
 * the audit trail has three of those. This is the reusable form.
 *
 * Steps run in the order given. Every step is logged, numbered, to stdout and
 * to out/drive/<run>/steps.log. Any failed expectation stops the run, saves
 * out/drive/<run>/fail.png, and exits 1. Evidence is never deleted by this
 * script; only the browser it opened is closed.
 *
 *   node scripts/drive.mjs [--run NAME] [--base URL] STEP...
 *
 * Steps:
 *   --as "Tang Mei-Hua"           switch persona through the real control, by name fragment
 *   --go /supplier                open a path
 *   --click "Accept"              click a button by name; confirms "Confirm: Accept" if it appears
 *   --link "Request financing"    click a link by name (a regex when written /^SERIES-/)
 *   --fill "Buy now price=245500" fill a labelled field
 *   --select "Tenor=30 days or less" choose an option in a labelled dropdown, by its visible text
 *   --radio 5100084412            check the radio in the table row containing that text
 *   --press XSGD                  press an exact-named button with no confirm step (asset pickers, filters, +30d)
 *   --tap "Show the 12 invoices"  click any element by its visible text (a disclosure summary, a tab, a row)
 *   --in "TP-2026-0158"           scope following steps to the section or row containing that text; --in "" clears
 *   --expect "Awaiting your acceptance"  the page (or scope) must contain this text
 *   --absent "Issue to supplier"  the page (or scope) must not contain this text
 *   --disabled Approve            a button with this name must be present and disabled (a refusal the UI shows, not hides)
 *   --url grade=AAA               the address must contain this text
 *   --grab REF=TP-2026-\d{4}      capture the first regex match; later steps may write {REF}
 *   --text                        print the page (or scope) text, for reading a state you did not predict
 *   --shot inbox                  save out/drive/<run>/NN-inbox.png, full page
 *   --aria inbox                  save out/drive/<run>/NN-inbox.aria.txt, the accessibility tree
 *   --wait 1000                   pause, in milliseconds; prefer an --expect when there is something to wait for
 *
 * Example, one page:
 *   node scripts/drive.mjs --as "Tang Mei-Hua" --go /supplier --expect "Awaiting your acceptance" --shot inbox
 *
 * From a script, the same verbs as methods:
 *   import { open } from '../scripts/drive.mjs';
 *   const d = await open({ run: 'settlement-look' });
 *   await d.as('Wei-Ling Chen'); await d.go('/adata/settlement'); await d.shot('due'); await d.close();
 */
import { chromium } from 'playwright';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

const ACTION_TIMEOUT = 15_000;

export async function open({ run, base, viewport } = {}) {
  const BASE = base ?? process.env.APP_URL ?? 'http://127.0.0.1:3100';
  const RUN = run ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const OUT = `out/drive/${RUN}`;
  await mkdir(OUT, { recursive: true });
  const LOG = `${OUT}/steps.log`;

  const browser = await chromium.launch({
    executablePath: CHROMIUM_CANDIDATES.find((p) => existsSync(p)),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: viewport ?? { width: 1440, height: 1000 } });
  page.setDefaultTimeout(ACTION_TIMEOUT);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('_rsc=')) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

  let step = 0;
  let scope = null; // a Locator, or null for the whole page
  let opened = false;
  const grabbed = {};

  const nn = () => String(step).padStart(2, '0');
  const where = () => scope ?? page.locator('body');

  async function log(message) {
    step += 1;
    const line = `${String(step).padStart(2, ' ')}. ${message}`;
    console.log(line);
    await appendFile(LOG, line + '\n');
  }

  async function ensureOpen() {
    if (!opened) await go('/');
  }

  /** Wait until no ActionButton is mid-flight; the label reads "Working…" while it is. */
  async function settled() {
    await page
      .waitForFunction(
        () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Working…')),
        null,
        { timeout: ACTION_TIMEOUT },
      )
      .catch(() => {});
    await page.waitForTimeout(300);
  }

  async function go(path) {
    scope = null;
    const response = await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    opened = true;
    const status = response?.status() ?? 0;
    if (status !== 200) throw new Error(`${path} answered ${status}`);
    await page.waitForTimeout(300);
    const heading = (await page.locator('h1').first().textContent().catch(() => ''))?.trim();
    await log(`open ${path}${heading ? ` — "${heading}"` : ''}`);
  }

  async function as(fragment) {
    await ensureOpen();
    const select = page.getByLabel('Switch persona');
    await select.waitFor();
    const option = select.locator('option', { hasText: fragment }).first();
    const value = await option.getAttribute('value');
    if (!value) throw new Error(`no persona matching "${fragment}"`);
    const label = (await option.textContent())?.trim();
    await select.selectOption(value);
    // The select is controlled by server state and disabled while the switch
    // is in flight, so "enabled again and showing the new name" is the signal.
    await page.waitForFunction(
      (f) => {
        const s = document.querySelector('select[aria-label="Switch persona"]');
        return s && !s.disabled && s.options[s.selectedIndex]?.textContent?.includes(f);
      },
      fragment,
      { timeout: ACTION_TIMEOUT },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await log(`act as ${label}`);
  }

  async function click(name) {
    const button = where().getByRole('button', { name, exact: false }).first();
    await button.click();
    const confirm = where().getByRole('button', { name: `Confirm: ${name}`, exact: false }).first();
    let confirmed = false;
    if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) {
      await confirm.click();
      confirmed = true;
    }
    await settled();
    await log(`click "${name}"${confirmed ? ' and confirm' : ''}`);
  }

  async function press(name) {
    await where().getByRole('button', { name, exact: true }).first().click();
    await settled();
    await page.waitForTimeout(500);
    await log(`press "${name}"`);
  }

  async function tap(text) {
    await where().getByText(text, { exact: false }).first().click();
    await page.waitForTimeout(400);
    await log(`tap "${text}"`);
  }

  async function link(name) {
    const pattern = typeof name === 'string' && /^\/.*\/$/.test(name) ? new RegExp(name.slice(1, -1)) : name;
    await where().getByRole('link', { name: pattern, exact: typeof pattern === 'string' }).first().click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);
    scope = null;
    await log(`follow link "${name}" → ${page.url().replace(BASE, '')}`);
  }

  async function fill(label, value) {
    await where().getByLabel(label).fill(String(value));
    await page.waitForTimeout(300);
    await log(`fill "${label}" with ${value}`);
  }

  async function select(label, optionText) {
    await where().getByLabel(label).selectOption({ label: optionText });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(600);
    await log(`select "${optionText}" in "${label}"`);
  }

  async function radio(rowText) {
    const row = where().locator('tr', { hasText: rowText }).first();
    await row.locator('input[type=radio]').check();
    await page.waitForTimeout(300);
    await log(`select the row containing "${rowText}"`);
  }

  /**
   * Scope to the smallest section or table row containing the text. A page
   * usually nests both (a section holding a table of rows), so "smallest" is
   * decided by text length rather than by which tag matched first.
   */
  async function within(text) {
    if (!text) {
      scope = null;
      await log('scope: whole page');
      return;
    }
    const candidates = page.locator('section, tr, details, article', { hasText: text });
    const n = await candidates.count();
    if (n === 0) throw new Error(`nothing on the page contains "${text}"`);
    let best = null;
    let bestLength = Infinity;
    let bestTag = '';
    for (let i = 0; i < n; i += 1) {
      const el = candidates.nth(i);
      const length = (await el.innerText()).length;
      if (length < bestLength) {
        best = el;
        bestLength = length;
        bestTag = await el.evaluate((e) => e.tagName.toLowerCase());
      }
    }
    scope = best;
    await log(`scope: the ${bestTag === 'tr' ? 'row' : bestTag} containing "${text}"`);
  }

  // innerText carries CSS text-transform, so labels the stylesheet uppercases
  // would never match as written. Compare without case.
  const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());

  async function expect(needle) {
    const text = await where().innerText();
    if (!has(text, needle)) throw new Error(`expected "${needle}"${scope ? ' in scope' : ''}, not found`);
    await log(`see "${needle}"`);
  }

  async function absent(needle) {
    const text = await where().innerText();
    if (has(text, needle)) throw new Error(`expected "${needle}" to be gone, still present`);
    await log(`confirm "${needle}" is gone`);
  }

  async function disabled(name) {
    const button = where().getByRole('button', { name, exact: false }).first();
    await button.waitFor();
    if (await button.isEnabled()) throw new Error(`expected the "${name}" button to be disabled, it is enabled`);
    await log(`button "${name}" is disabled`);
  }

  async function url(needle) {
    if (!page.url().includes(needle)) throw new Error(`expected the address to contain "${needle}", got ${page.url()}`);
    await log(`address carries ${needle}`);
  }

  async function grab(name, pattern) {
    const text = await where().innerText();
    const match = text.match(new RegExp(pattern, 'i'))?.[0];
    if (!match) throw new Error(`nothing matched /${pattern}/${scope ? ' in scope' : ''}`);
    grabbed[name] = match;
    await log(`grab ${name} = ${match}`);
    return match;
  }

  async function text() {
    // Unscoped, read the main region: the demo-controls bar and the persona
    // list repeat on every page and only bury the state being read.
    const main = page.locator('main');
    const target = scope ?? ((await main.count()) > 0 ? main.first() : page.locator('body'));
    const body = await target.innerText();
    console.log(body);
    await log(`read ${body.length} characters of ${scope ? 'scope' : 'page'} text`);
    return body;
  }

  async function shot(name) {
    const path = `${OUT}/${nn()}-${name}.png`;
    await page.screenshot({ path, fullPage: true });
    await log(`screenshot ${path}`);
    return path;
  }

  async function aria(name) {
    const path = `${OUT}/${nn()}-${name}.aria.txt`;
    await writeFile(path, await where().ariaSnapshot());
    await log(`aria snapshot ${path}`);
    return path;
  }

  async function wait(ms) {
    await page.waitForTimeout(Number(ms));
    await log(`wait ${ms}ms`);
  }

  async function fail(error) {
    const path = `${OUT}/fail.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    const line = `FAIL after step ${step}: ${error.message}\n      screenshot ${path}`;
    console.error(line);
    await appendFile(LOG, line + '\n');
  }

  async function close() {
    if (consoleErrors.length > 0) {
      console.log(`\n${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'} during the run:`);
      for (const e of consoleErrors.slice(0, 10)) console.log(`      ${e}`);
      await appendFile(LOG, consoleErrors.map((e) => `console: ${e}`).join('\n') + '\n');
    }
    await browser.close();
    console.log(`\nevidence in ${OUT}`);
  }

  return {
    page,
    base: BASE,
    out: OUT,
    grabbed,
    consoleErrors,
    go,
    as,
    click,
    press,
    tap,
    link,
    fill,
    select,
    radio,
    within,
    expect,
    absent,
    disabled,
    url,
    grab,
    text,
    shot,
    aria,
    wait,
    fail,
    close,
  };
}

// ----------------------------------------------------------------- the CLI

const STEPS = new Set([
  'as', 'go', 'click', 'link', 'fill', 'select', 'radio', 'press', 'tap', 'in', 'expect', 'absent', 'disabled', 'url', 'grab', 'text', 'shot', 'aria', 'wait',
]);
const NO_ARG = new Set(['text']);

function parse(argv) {
  const opts = {};
  const steps = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`expected a --step, got "${flag}"`);
    const name = flag.slice(2);
    if (name === 'run' || name === 'base') {
      opts[name] = argv[++i];
      continue;
    }
    if (!STEPS.has(name)) throw new Error(`unknown step --${name}`);
    const arg = NO_ARG.has(name) ? undefined : argv[++i];
    if (!NO_ARG.has(name) && arg === undefined) throw new Error(`--${name} needs a value`);
    steps.push({ name, arg });
  }
  return { opts, steps };
}

async function main() {
  let parsed;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error('usage: node scripts/drive.mjs [--run NAME] [--base URL] --as PERSONA --go PATH [--click NAME ...]');
    process.exit(2);
  }
  if (parsed.steps.length === 0) {
    console.error('no steps given; see the header of scripts/drive.mjs');
    process.exit(2);
  }

  const d = await open(parsed.opts);
  const sub = (s) => (s === undefined ? s : s.replace(/\{(\w+)\}/g, (m, k) => d.grabbed[k] ?? m));

  try {
    for (const { name, arg } of parsed.steps) {
      const value = sub(arg);
      switch (name) {
        case 'as': await d.as(value); break;
        case 'go': await d.go(value); break;
        case 'click': await d.click(value); break;
        case 'link': await d.link(value); break;
        case 'fill': {
          const eq = value.indexOf('=');
          if (eq < 1) throw new Error(`--fill wants "Label=value", got "${value}"`);
          await d.fill(value.slice(0, eq), value.slice(eq + 1));
          break;
        }
        case 'select': {
          const eq = value.indexOf('=');
          if (eq < 1) throw new Error(`--select wants "Label=option text", got "${value}"`);
          await d.select(value.slice(0, eq), value.slice(eq + 1));
          break;
        }
        case 'radio': await d.radio(value); break;
        case 'press': await d.press(value); break;
        case 'tap': await d.tap(value); break;
        case 'in': await d.within(value); break;
        case 'expect': await d.expect(value); break;
        case 'absent': await d.absent(value); break;
        case 'disabled': await d.disabled(value); break;
        case 'url': await d.url(value); break;
        case 'grab': {
          const eq = value.indexOf('=');
          if (eq < 1) throw new Error(`--grab wants "NAME=regex", got "${value}"`);
          await d.grab(value.slice(0, eq), value.slice(eq + 1));
          break;
        }
        case 'text': await d.text(); break;
        case 'shot': await d.shot(value); break;
        case 'aria': await d.aria(value); break;
        case 'wait': await d.wait(value); break;
        default: throw new Error(`unhandled step ${name}`);
      }
    }
  } catch (e) {
    await d.fail(e);
    process.exitCode = 1;
  } finally {
    await d.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
