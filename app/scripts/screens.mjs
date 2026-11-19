// Screenshots of the mock app (npm run dev:mock on :5180) at desktop and phone sizes → app/screens/.
// Usage: node scripts/screens.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:5180/app/';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../screens');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function shot(name, { width, height, scheme = 'dark', before, mobile = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console ${m.text()}`); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (before) await before(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await ctx.close();
  console.log('saved', name);
}

const openRedesign = async (page) => {
  await page.getByText('Redesign the share row').first().click();
  await page.waitForTimeout(700);
};

await shot('desktop-dark', { width: 1280, height: 800, before: openRedesign });
await shot('desktop-light', { width: 1280, height: 800, scheme: 'light', before: openRedesign });
await shot('desktop-empty-conversation', {
  width: 1280, height: 800,
  before: async (page) => {
    await page.getByText('New conversation').first().click();
    await page.waitForTimeout(700);
  },
});
await shot('desktop-menu', {
  width: 1280, height: 800,
  before: async (page) => {
    await openRedesign(page);
    await page.getByRole('button', { name: 'Conversation' }).first().click();
    await page.waitForTimeout(300);
  },
});
await shot('desktop-new-project', {
  width: 1280, height: 800,
  before: async (page) => {
    await page.getByText('New project').click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Notes app');
    await page.waitForTimeout(400);
  },
});
// Phone: a touch device. A project row taps open and closed; a conversation row opens the conversation page.
const phone = { width: 390, height: 844, mobile: true };
await shot('phone-list', {
  ...phone,
  before: async (page) => {
    await page.getByRole('button', { name: 'pearcast', exact: true }).tap();
    await page.waitForTimeout(300);
    if (await page.getByText('Chapter markers').count()) throw new Error('pearcast did not collapse on tap');
    await page.getByRole('button', { name: 'pearcast', exact: true }).tap();
    await page.waitForTimeout(300);
    if (!(await page.getByText('Chapter markers').count())) throw new Error('pearcast did not expand on tap');
  },
});
await shot('phone-conversation', {
  ...phone,
  before: async (page) => {
    await page.getByText('Redesign the share row').first().tap();
    await page.waitForTimeout(700);
    if (!(await page.getByRole('button', { name: 'Back' }).count())) throw new Error('no back control on the conversation page');
  },
});
await shot('phone-project', {
  ...phone,
  before: async (page) => {
    await page.getByText('Redesign the share row').first().tap();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Show project' }).first().tap();
    await page.waitForTimeout(500);
    if (!(await page.getByRole('button', { name: 'Back' }).count())) throw new Error('no back control on the project page');
  },
});
await shot('phone-new-project', {
  ...phone,
  before: async (page) => {
    await page.getByText('New project').tap();
    await page.getByRole('textbox', { name: 'Name' }).fill('From the phone');
    await page.waitForTimeout(400);
  },
});

await browser.close();
if (errors.length) {
  console.log('\nPage errors:');
  for (const e of errors) console.log(' -', e);
  process.exitCode = 1;
}
