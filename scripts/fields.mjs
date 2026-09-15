import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
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

let failed = 0;
function check(ok, message) {
  if (ok) console.log(`PASS  ${message}`);
  else {
    console.error(`FAIL  ${message}`);
    failed += 1;
  }
}

async function become(fragment) {
  const select = page.getByLabel('Switch persona');
  await select.waitFor();
  const value = await select.locator('option', { hasText: fragment }).first().getAttribute('value');
  if (!value) throw new Error(`no persona matching "${fragment}"`);
  await select.selectOption(value);
  await page.waitForTimeout(400);
}

try {
  await page.goto(`${BASE}/adata/create?mode=manual`, { waitUntil: 'domcontentloaded' });
  await become('Wei-Ling Chen');
  await page.goto(`${BASE}/adata/create?mode=manual`, { waitUntil: 'domcontentloaded' });

  const face = page.getByLabel('Invoice face');
  const terms = page.getByLabel('Payment terms');
  const create = page.getByRole('button', { name: 'Create payable' });

  await face.fill('0');
  await terms.fill('90');
  check(!(await create.isVisible()), 'zero face does not arm Create payable');

  await face.fill('0.00005');
  check(!(await create.isVisible()), 'half a base unit does not arm Create payable');

  await face.fill('0.0001');
  await terms.fill('0');
  check(!(await create.isVisible()), 'zero-day terms do not arm Create payable');

  await terms.fill('366');
  check(!(await create.isVisible()), '366-day terms do not arm Create payable');

  await terms.fill('1');
  check(await create.isVisible(), 'minimum face and 1-day terms arm Create payable');

  await terms.fill('365');
  check(await create.isVisible(), '365-day terms still arm Create payable');
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  await browser.close();
}

if (failed > 0) process.exit(1);
console.log('PASS  field boundaries in the browser');
