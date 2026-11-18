// Screenshots against the running daemon (it serves app/dist at /app/): app/screens/live-desktop.png, live-phone.png.
// Usage: node scripts/screens-live.mjs [baseUrl]   (build first: npm run build)
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:4455/app/';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../screens');
const browser = await chromium.launch();
const errors = [];
for (const [name, viewport] of [['live-desktop', { width: 1280, height: 800 }], ['live-phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console ${m.text()}`); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (name === 'live-phone') {
    // Open the first conversation row (title + snippet rows are the ones with a time at the right).
    const named = page.getByRole('link', { name: /Say hello/ });
    const row = (await named.count()) ? named.first() : page.getByRole('link').first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(1200); }
  }
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await ctx.close();
  console.log('saved', name);
}
await browser.close();
if (errors.length) { console.log('\nErrors:'); for (const e of errors) console.log(' -', e.slice(0, 300)); process.exitCode = 1; }
