/**
 * Measure the demo-controls top bar: every font size, every control height.
 *
 *   scripts/serve.sh && node scripts/topbar.mjs
 *   node scripts/topbar.mjs --shots     also write a PNG of the bar
 *
 * The bar is chrome, so no page test covers it and "looks right" is the only
 * check it has ever had. That is not a check. This reads the computed style of
 * every rendered element inside the bar and fails when a text-bearing one is
 * not at the bar's declared size, or when a control is too short to hold that
 * text comfortably.
 *
 * It exists because the sizes used to live in fourteen separate Tailwind
 * literals, where "make them consistent" was a promise nobody could verify.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const SHOTS = process.argv.includes('--shots');
const OUT = 'out/topbar';
const EXECUTABLE = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p));

const FONT_PX = Number(process.env.TOPBAR_FONT_PX ?? 16);
const MIN_CONTROL_PX = Number(process.env.TOPBAR_MIN_CONTROL_PX ?? 28);

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 950 },
];

/**
 * Read the bar in the page. Returns one row per rendered element that carries
 * its own text, plus the bar's own box.
 */
function probe() {
  const bar = document.querySelector('.chrome-tools');
  if (!bar) return { error: 'no .chrome-tools on the page' };

  const ownText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');

  const rows = [];
  for (const el of bar.querySelectorAll('*')) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const style = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const isControl = tag === 'button' || tag === 'select' || tag === 'a' || tag === 'input';
    if (!ownText(el) && !isControl) continue;
    rows.push({
      tag,
      label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 34),
      fontPx: parseFloat(style.fontSize),
      heightPx: Math.round(box.height * 10) / 10,
      isControl,
    });
  }

  const barBox = bar.getBoundingClientRect();
  return {
    barHeightPx: Math.round(barBox.height * 10) / 10,
    barFontPx: parseFloat(getComputedStyle(bar).fontSize),
    docOverflowPx: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    rows,
  };
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
if (SHOTS) await mkdir(OUT, { recursive: true });

let failures = 0;

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(BASE + '/adata/approvals', { waitUntil: 'networkidle' });

  const result = await page.evaluate(probe);
  if (result.error) {
    console.log(`${viewport.name}: FAIL ${result.error}`);
    failures++;
    await context.close();
    continue;
  }

  console.log(`\n=== ${viewport.name} (${viewport.width}px) ===`);
  console.log(`bar height ${result.barHeightPx}px | bar font ${result.barFontPx}px | doc overflow ${result.docOverflowPx}px`);

  const sizes = new Set(result.rows.map((r) => r.fontPx));
  for (const row of result.rows) {
    const bad = row.fontPx !== FONT_PX;
    const short = row.isControl && row.heightPx < MIN_CONTROL_PX;
    const mark = bad || short ? 'FAIL' : 'ok  ';
    console.log(
      `  ${mark} ${row.tag.padEnd(6)} ${String(row.fontPx).padStart(5)}px  h=${String(row.heightPx).padStart(5)}px  ${row.label}`,
    );
    if (bad || short) failures++;
  }

  console.log(`  distinct font sizes in bar: ${[...sizes].sort((a, b) => a - b).join(', ')}`);
  if (result.docOverflowPx > 0) {
    console.log(`  FAIL document pans horizontally by ${result.docOverflowPx}px`);
    failures++;
  }

  if (SHOTS) {
    await page.locator('.chrome-tools').screenshot({ path: `${OUT}/${viewport.name}.png` });
  }
  await context.close();
}

await browser.close();
console.log(failures === 0 ? '\ntopbar ok' : `\ntopbar: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
