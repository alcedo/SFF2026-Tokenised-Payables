/**
 * Screenshot a running screen.
 *
 *   node scripts/shot.mjs /lender out/marketplace.png [width] [height]
 *
 * Exists so "does this look right" is a command anyone can re-run against the
 * real app rather than a description of what it looked like once. Fails loudly
 * on a console error or a failed request, because a screenshot of a broken page
 * is worse than no screenshot.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const [path = '/', out = 'out/shot.png', width = '1440', height = '900'] = process.argv.slice(2);
const base = process.env.APP_URL ?? 'http://127.0.0.1:3100';

await mkdir(dirname(out), { recursive: true });

// This environment preinstalls a Chromium that may not match the build the
// installed Playwright expects, and downloading another is both slow and
// blocked. Point at the one that is already here.
const EXECUTABLE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 2,
});

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));

const response = await page.goto(base + path, { waitUntil: 'domcontentloaded' });
if (!response || response.status() >= 400) {
  console.error(`FAIL ${path} returned ${response?.status()}`);
  await browser.close();
  process.exit(1);
}

await page.screenshot({ path: out, fullPage: true });
await browser.close();

if (problems.length > 0) {
  console.error(`FAIL ${path} rendered with problems:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`ok   ${path} -> ${out}`);
