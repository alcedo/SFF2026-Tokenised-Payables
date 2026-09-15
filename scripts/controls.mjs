/**
 * List every control the app offers, per screen, per persona.
 *
 *   scripts/serve.sh && node scripts/controls.mjs
 *   node scripts/controls.mjs --persona "Tang Mei-Hua"
 *
 * Written for whoever is about to automate a pathway and needs the real button
 * label rather than the one they assumed. A guessed selector fails as a timeout
 * thirty seconds later and reads like a broken feature, so this prints the
 * truth up front: what is on the page, what it is called, and who can see it.
 *
 * It also answers the question a pathway test exists to ask. A branch the
 * ledger allows and no screen offers shows up here as an absence.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ONE = process.argv.includes('--persona') ? process.argv[process.argv.indexOf('--persona') + 1] : null;

const PERSONAS = [
  'Wei-Ling Chen',
  'Hsu Po-Chun',
  'Nadia Rahman',
  'Tang Mei-Hua',
  'Sébastien Baptiste',
];

const ROUTES = [
  '/', '/adata', '/adata/create', '/adata/approvals', '/adata/settlement',
  '/admin', '/admin/accounts', '/admin/certification', '/admin/grading',
  '/supplier', '/supplier/offers', '/lender', '/lender/portfolio',
  '/explorer', '/overdue', '/transfer', '/onboarding', '/reset',
];

const browser = await chromium.launch({
  executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

async function become(fragment) {
  const select = page.getByLabel('Switch persona');
  const value = await select.locator('option', { hasText: fragment }).first().getAttribute('value');
  if (!value) throw new Error(`no persona matching "${fragment}"`);
  await select.selectOption(value);
  await page.waitForTimeout(600);
}

/**
 * The chrome strip repeats on every screen, so its controls are collected once
 * and subtracted from each page. What is left is what that screen actually adds.
 */
async function controlsOn(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const grab = (role) =>
    page.getByRole(role).evaluateAll((nodes) =>
      nodes.map((n) => (n.getAttribute('aria-label') || n.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean),
    );
  return {
    buttons: await grab('button'),
    textboxes: await grab('textbox'),
    radios: await grab('radio'),
    links: (await grab('link')).filter((l) => l.length < 40),
  };
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

for (const persona of ONE ? [ONE] : PERSONAS) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await become(persona);
  console.log(`\n${'='.repeat(70)}\n${persona}\n${'='.repeat(70)}`);

  const chrome = await controlsOn('/');
  const isChrome = new Set(chrome.buttons);

  for (const route of ROUTES) {
    const { buttons, textboxes, radios, links } = await controlsOn(route);
    const own = buttons.filter((b) => !isChrome.has(b));
    const status = page.url().includes(route) || route === '/' ? '' : `  -> ${page.url().replace(BASE, '')}`;
    const parts = [];
    if (own.length) parts.push(`btn: ${[...new Set(own)].join(' | ')}`);
    if (textboxes.length) parts.push(`text: ${[...new Set(textboxes)].join(' | ')}`);
    if (radios.length) parts.push(`radio: ${[...new Set(radios)].slice(0, 6).join(' | ')}`);
    console.log(`\n  ${route}${status}`);
    if (parts.length) for (const p of parts) console.log(`      ${p}`);
    else console.log('      (nothing to click)');
    if (links.length) console.log(`      links: ${[...new Set(links)].slice(0, 10).join(' | ')}`);
  }
}

await browser.close();
