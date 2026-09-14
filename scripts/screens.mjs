/**
 * Visit every screen as every persona and fail on anything broken.
 *
 * "It builds" says nothing about whether a page renders: a wrong column name, a
 * null that was assumed present, or a client component throwing on hydration all
 * compile perfectly. This drives the real app in a real browser and treats a
 * console error, a failed request or a non-200 as a failure.
 *
 *   node scripts/screens.mjs            check every screen
 *   node scripts/screens.mjs --shots    also write a PNG of each
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const SHOTS = process.argv.includes('--shots');
const OUT = 'out/screens';

const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Persona name fragment -> the screens that persona can reach. */
const TOURS = [
  { persona: 'Wei-Ling Chen', label: 'adata-preparer', paths: ['/adata', '/adata/create', '/adata/create?mode=manual', '/adata/approvals', '/adata/settlement', '/explorer'] },
  { persona: 'Hsu Po-Chun', label: 'adata-checker', paths: ['/adata/approvals'] },
  { persona: 'Tang Mei-Hua', label: 'supplier', paths: ['/supplier', '/supplier/offers', '/transfer'] },
  { persona: 'Rina Okafor', label: 'lender', paths: ['/lender', '/lender/portfolio', '/transfer', '/reset'] },
  { persona: 'Nadia Rahman', label: 'admin', paths: ['/admin', '/admin/certification', '/admin/grading', '/overdue', '/explorer', '/reset'] },
];

if (SHOTS) await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });

let failures = 0;

/** Switch persona through the real control, so the tour exercises it too. */
async function becomePersona(page, fragment) {
  await page.goto(BASE + '/lender', { waitUntil: 'domcontentloaded' });
  const select = page.getByLabel('Switch persona');
  const option = await select.locator('option', { hasText: fragment }).first().getAttribute('value');
  if (!option) throw new Error(`no persona matching "${fragment}"`);
  await select.selectOption(option);
  await page.waitForTimeout(600);
}

for (const tour of TOURS) {
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`));

  try {
    await becomePersona(page, tour.persona);
  } catch (e) {
    console.log(`FAIL  ${tour.label}: could not switch persona — ${e.message}`);
    failures++;
    await page.close();
    continue;
  }

  for (const path of tour.paths) {
    problems.length = 0;
    const response = await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);

    const status = response?.status() ?? 0;
    // A prefetch of a redirecting route is not a page failure.
    const real = problems.filter((p) => !p.includes('_rsc='));

    if (status !== 200 || real.length > 0) {
      failures++;
      console.log(`FAIL  ${tour.label} ${path} (${status})`);
      for (const p of real.slice(0, 3)) console.log(`        ${p}`);
    } else {
      const heading = await page.locator('h1').first().textContent().catch(() => null);
      console.log(`  ok  ${tour.label.padEnd(15)} ${path.padEnd(24)} ${heading?.trim() ?? ''}`);
    }

    if (SHOTS) {
      await page.screenshot({
        path: `${OUT}/${tour.label}${path.replace(/\//g, '-') || '-home'}.png`,
        fullPage: true,
      });
    }
  }
  await page.close();
}

await browser.close();

if (failures > 0) {
  console.log(`\n${failures} screen${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('\nevery screen renders');
