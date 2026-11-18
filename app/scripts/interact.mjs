// Drive the mock app once: send a message, wait for the agent's reply, open a new conversation, rename it.
// Prints what it saw; saves screens/desktop-reply.png. Usage: node scripts/interact.mjs [baseUrl]
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:5180/app/';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../screens');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base, { waitUntil: 'networkidle' });
await page.getByText('Why does sync stall on Zorin?').first().click();
await page.waitForTimeout(600);

// Send with Enter.
const box = page.getByLabel('Message PearDrive');
await box.click();
await box.fill('Lower the retry to 5 s and log the peer, please.');
await box.press('Enter');
await page.waitForTimeout(300);
console.log('pending shown:', await page.getByText('Lower the retry to 5 s').count());
await page.waitForTimeout(1500);
console.log('thinking line:', await page.getByText('@rkeychat is thinking').count());
await page.getByText('mock reply to').first().waitFor({ timeout: 8000 });
console.log('reply arrived, markdown bold:', await page.getByText('Markdown').count());
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'desktop-reply.png') });

// Unread badge on another conversation: send into General via the sidebar of the other project? The mock only
// replies in the conversation written to, so check the selected one has no badge.
// New conversation with ⌘N, then rename.
await page.keyboard.press('Meta+n');
await page.waitForTimeout(700);
console.log('new conversation selected:', await page.locator('[role="heading"], h1, h2, [aria-level]').filter({ hasText: 'New conversation' }).count() > 0);
await page.getByRole('button', { name: 'Rename' }).first().click();
await page.waitForTimeout(200);
await page.keyboard.type('Retry timing');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
console.log('renamed:', await page.getByText('Retry timing').count());

// Archive it from the menu, then reopen from the project pane.
await page.getByRole('button', { name: 'Conversation' }).first().click();
await page.getByRole('menuitem', { name: 'Archive' }).click();
await page.waitForTimeout(600);
console.log('archived toast:', await page.getByText('Conversation archived').count());
await page.getByText('Archived · 2').click();
await page.waitForTimeout(200);
console.log('archived list shows it:', await page.getByText('Retry timing').count());

// New project through the dialog (no bridge in a browser).
await page.getByText('New project').click();
await page.getByRole('textbox', { name: 'Folder' }).fill('/Users/guy/Anjou/pearkit');
await page.getByRole('button', { name: 'Create' }).click();
await page.waitForTimeout(1200);
console.log('project toast:', await page.getByText('Project ready.').count(), 'sidebar has pearkit:', await page.getByText('pearkit', { exact: true }).count());
await page.screenshot({ path: path.join(out, 'desktop-new-project.png') });

await browser.close();
if (errors.length) {
  console.log('\nErrors:');
  for (const e of errors) console.log(' -', e.slice(0, 300));
  process.exitCode = 1;
}
