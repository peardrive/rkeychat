// Screenshots of the mock app (npm run dev:mock on :5180) at desktop and phone sizes → app/screens/.
// Each shot also exercises a flow and throws when something expected is missing. Usage: node scripts/screens.mjs [baseUrl]
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console ${m.text().slice(0, 200)}`); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1700); // the mock's feed events (an approval, a mention) arrive within 1.5 s
  try {
    if (before) await before(page);
  } catch (e) {
    errors.push(`${name}: ${e.message.split('\n')[0]}`);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await ctx.close();
  console.log('saved', name);
}

const must = async (page, locator, what) => {
  if (!(await locator.count())) throw new Error(`missing: ${what}`);
};
const openRedesign = async (page, tap = false) => {
  const row = page.getByText('Redesign the share row').first();
  await (tap ? row.tap() : row.click());
  await page.waitForTimeout(700);
};

const desktop = { width: 1280, height: 800 };
const phone = { width: 390, height: 844, mobile: true };

await shot('desktop-home', { ...desktop, before: async (page) => { await must(page, page.getByText('wants to log in'), 'the approval in the feed'); await must(page, page.getByText('mentioned you'), 'the mention in the feed'); } });
await shot('desktop-dark', { ...desktop, before: openRedesign });
await shot('desktop-light', { ...desktop, scheme: 'light', before: openRedesign });
await shot('desktop-message-actions', {
  ...desktop,
  before: async (page) => {
    await openRedesign(page);
    await page.getByRole('button', { name: /Actions$/ }).last().click();
    await page.waitForTimeout(300);
    await must(page, page.getByRole('button', { name: 'React 👍' }), 'the emoji row on a tapped message');
  },
});
await shot('desktop-files', {
  ...desktop,
  before: async (page) => {
    await openRedesign(page);
    await page.getByRole('button', { name: 'Files' }).first().click();
    await page.waitForTimeout(600);
    await must(page, page.getByText('share-row.png'), 'a file in the files list');
  },
});
await shot('desktop-menu', {
  ...desktop,
  before: async (page) => {
    await page.getByRole('button', { name: 'PearDrive actions' }).click();
    await page.waitForTimeout(300);
    await must(page, page.getByRole('menuitem', { name: 'Move to organization…' }), 'the project menu');
  },
});
await shot('desktop-new-project', {
  ...desktop,
  before: async (page) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Notes app');
    await page.getByRole('button', { name: 'Anjou', exact: true }).click();
    await page.waitForTimeout(300);
  },
});
await shot('desktop-profile', {
  ...desktop,
  before: async (page) => {
    await openRedesign(page);
    await page.getByRole('button', { name: '@rkeychat' }).first().click();
    await page.waitForTimeout(500);
    await must(page, page.getByText('Role in this project'), 'the bot profile');
  },
});
await shot('desktop-settings', {
  ...desktop,
  before: async (page) => {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForTimeout(700);
    await must(page, page.getByText('Workspace folder'), 'the settings page');
  },
});

await shot('desktop-debug-note', {
  ...desktop,
  before: async (page) => {
    await openRedesign(page);
    await page.getByRole('button', { name: 'Start a debug note' }).first().click();
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: /Actions$/ }).last().click();
    await page.waitForTimeout(500);
    await must(page, page.getByRole('button', { name: /^Stop the debug note/ }), 'the running note on the button');
  },
});

await shot('phone-home', { ...phone, before: async (page) => { await must(page, page.getByText('wants to log in'), 'the approval on the phone home'); } });
await shot('phone-conversation', {
  ...phone,
  before: async (page) => {
    await openRedesign(page, true);
    await must(page, page.getByRole('button', { name: 'Back' }), 'a back control on the conversation page');
    await must(page, page.getByRole('button', { name: 'Files' }), 'the glass bar');
  },
});
await shot('phone-project', {
  ...phone,
  before: async (page) => {
    await openRedesign(page, true);
    await page.getByRole('button', { name: 'Project' }).first().tap();
    await page.waitForTimeout(500);
    await must(page, page.getByRole('button', { name: 'Back' }), 'a back control on the project sheet');
  },
});
await shot('phone-new-project', {
  ...phone,
  before: async (page) => {
    await page.getByRole('button', { name: 'New', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'New project' }).tap();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('From the phone');
    await page.waitForTimeout(400);
  },
});
await shot('phone-profile', {
  ...phone,
  before: async (page) => {
    await openRedesign(page, true);
    await page.getByText('@rkeychat is thinking').first().tap();
    await page.waitForTimeout(500);
    await must(page, page.getByText('Role in this project'), 'the bot profile from the thinking line');
  },
});

await browser.close();
if (errors.length) {
  console.log('\nProblems:');
  for (const e of errors) console.log(' -', e);
  process.exitCode = 1;
}
