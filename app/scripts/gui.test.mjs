// The shell's basic chat interactions, driven in a real browser against the mock daemon (VITE_MOCK=1), the way a
// person uses them: open a conversation, send, the keyboard coming up, reading older messages while a reply
// arrives, the projects page. Runs on the Mac Mini bench (quick-rkeychat.sh) and here: `npm run test:gui`.
// Each test starts its own page; the Vite server is one per run, on a port of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(here, '..')); // Tailwind's content globs are relative to the working directory: run from app/ wherever we were started
const PORT = Number(process.env.GUI_PORT || 5199);
const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336; // what an iPhone keyboard takes

let server, browser;
before(async () => {
  process.env.VITE_MOCK = '1';
  server = await createServer({ configFile: path.join(here, '../vite.config.ts'), root: path.join(here, '..'), server: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open({ phone = true } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: PHONE, isMobile: true, hasTouch: true, colorScheme: 'dark' } : { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  return { page, ctx, errors };
}

const box = async (loc) => {
  const b = await loc.boundingBox();
  assert.ok(b, 'the element is on screen');
  return b;
};
const scrollTop = (list) => list.evaluate((el) => el.scrollTop);
const bottomEdgeText = (list) =>
  list.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const node = document.elementFromPoint(r.left + r.width / 2, r.bottom - 3);
    return node?.textContent?.trim().slice(0, 60) ?? '';
  });

// the phone's conversation: Projects in the dock, then a PearDrive thread ("The long one" is taller than any screen)
async function openThread(page, title = 'The long one') {
  await page.getByRole('tab', { name: 'Projects' }).tap();
  await page.waitForTimeout(400);
  await page.getByText(title).first().tap();
  await page.getByLabel('Message PearDrive').waitFor();
  await page.waitForTimeout(600);
}

test('send: the message appears at the bottom, the field clears, the list stays at the end', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page);
    const field = page.getByLabel('Message PearDrive');
    await field.tap();
    await field.fill('Truncate in the middle, please.');
    await page.getByRole('button', { name: 'Send', exact: true }).tap(); // a phone's Return key is a new line

    await page.waitForTimeout(400);
    const list = page.getByLabel('Messages');
    const mine = list.getByText('Truncate in the middle, please.').last();
    const [m, l] = [await box(mine), await box(list)];
    assert.ok(m.y + m.height <= l.y + l.height + 1, 'my message is inside the list, at its bottom');
    assert.ok(l.y + l.height - (m.y + m.height) < 60, `my message sits at the bottom of the list (gap ${Math.round(l.y + l.height - (m.y + m.height))}px)`);
    assert.equal(await field.inputValue(), '', 'the field is empty again');
    // the mock answers a few seconds later; the list follows, since we were at the end
    await page.getByText('mock reply to').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    const reply = await box(list.getByText('mock reply to').first());
    assert.ok(reply.y + reply.height <= l.y + l.height + 1, 'the reply is visible at the bottom');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('a word with no spaces (a pasted link) wraps inside its bubble instead of running off the screen (2026-11-23)', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page);
    const link = 'pearcore://EmJqNuSyW3a7eBiFnKrPvTzX4b8fCjGoLsQwU1Y5c9gDkHpMtRxV2Z6dAhEmJqNuSyW3a7eBiFnKrPvTzX4b8fCjGoLsQwU1Y5c9gDkHpMtRxV2Z6dAhEmJqNuSyW3a7eBiFnKrPvTzX4b8fCjGoLsQwU1Y5c9gDkHpMtRxV2Z6dAhEmJqNuSyW3a7eBiFnKrPvTzX4b'; // a made-up link of the real shape (never a real one: a notes link reads someone's notes)
    await page.getByLabel('Message PearDrive').fill(link);
    await page.getByRole('button', { name: 'Send' }).tap();
    const bubble = page.getByRole('button', { name: /^guy: pearcore:\/\// });
    await bubble.waitFor({ timeout: 4000 });
    const b = await box(bubble);
    assert.ok(b.x >= 0, `the bubble starts on screen (x ${Math.round(b.x)})`);
    assert.ok(b.x + b.width <= PHONE.width, `the bubble ends on screen (right edge ${Math.round(b.x + b.width)} of ${PHONE.width})`);
    assert.ok(b.height > 60, `the link wraps onto several lines (height ${Math.round(b.height)})`);
    const page_w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.equal(page_w, PHONE.width, 'the page did not grow sideways');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('keyboard: the chat slides up as one piece; the last message stays above the field; nothing jumps', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page);
    const list = page.getByLabel('Messages');
    const field = page.getByLabel('Message PearDrive');
    const before = { top: await scrollTop(list), edge: await bottomEdgeText(list), field: await box(field), list: await box(list) };
    assert.ok(before.edge.length, 'something sits at the bottom edge');
    // the keyboard comes up: the viewport loses its height (what the WebView does; main.tsx follows the visual viewport)
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD });
    await page.waitForTimeout(500);
    const after = { top: await scrollTop(list), edge: await bottomEdgeText(list), field: await box(field), list: await box(list) };
    const shrunk = before.list.height - after.list.height;
    assert.ok(shrunk > KEYBOARD - 60, `the list gave up its height to the keyboard (${Math.round(shrunk)}px)`);
    assert.ok(Math.abs(after.top - before.top - shrunk) <= 4, `the scroll moved by exactly the lost height (${Math.round(after.top - before.top)} vs ${Math.round(shrunk)})`);
    assert.equal(after.edge, before.edge, 'the same message sits against the bottom edge');
    assert.ok(after.field.y + after.field.height <= PHONE.height - KEYBOARD + 1, 'the field is above the keyboard');
    // and back down: the same place again
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await scrollTop(list)) - before.top) <= 4, 'back where it was');
    assert.equal(await bottomEdgeText(list), before.edge);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('reading older messages: the keyboard keeps the same message at the bottom edge; a reply does not move the view', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page);
    const list = page.getByLabel('Messages');
    const field = page.getByLabel('Message PearDrive');
    // a message goes out first, so a reply is on its way while we read
    await field.tap();
    await field.fill('One more thing.');
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await page.waitForTimeout(900); // the daemon's echo of my message replaces the pending row, and my own messages always show
    const max = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
    assert.ok(max > 300, `the conversation is taller than the screen (${max}px of scroll)`);
    await list.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 250); });
    await page.waitForTimeout(200);
    const up = { top: await scrollTop(list), edge: await bottomEdgeText(list) };
    assert.ok(up.top < max - 100, 'we are reading older messages, not at the end');
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD });
    await page.waitForTimeout(500);
    assert.equal(await bottomEdgeText(list), up.edge, 'the keyboard did not change what sits at the bottom edge');
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(500);
    // the same message is at the bottom edge again; the offset may differ by the status line that came up meanwhile
    assert.equal(await bottomEdgeText(list), up.edge, 'the keyboard going away keeps the same message at the bottom edge');
    assert.ok(Math.abs((await scrollTop(list)) - up.top) <= 30, 'the keyboard going away puts us back where we were');
    // the reply lands while we read: the view must not move
    await page.getByText('mock reply to').first().waitFor({ state: 'attached', timeout: 8000 });
    await page.waitForTimeout(400);
    // the status line ("@rkeychat is thinking…") coming and going shifts the box by a few px; the reading place, measured
    // from the bottom edge, must not move
    assert.equal(await bottomEdgeText(list), up.edge, 'a reply arriving did not move what we were reading');
    assert.ok(Math.abs((await scrollTop(list)) - up.top) <= 30, `a reply arriving did not move the view (${await scrollTop(list)} vs ${up.top})`);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('phone: a project opens from the list and Back returns to it', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page);
    await page.getByRole('button', { name: 'Back' }).first().tap();
    await page.waitForTimeout(400);
    assert.ok(await page.getByText('The long one').first().isVisible(), 'the projects list is back');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('phone: the project pane sets the rounds per message; the line follows (2026-11-23, "set rounds")', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page);
    await page.getByRole('button', { name: 'Project' }).first().tap();
    await page.getByRole('button', { name: 'Back' }).first().waitFor({ timeout: 4000 });
    await page.getByText(/Rounds: 3 rounds per message/).first().waitFor({ timeout: 4000 });
    const field = page.getByRole('textbox', { name: 'Rounds per message' });
    await field.fill('5');
    await page.getByLabel('Rounds').getByRole('button', { name: 'Set' }).last().tap();
    await page.getByText(/Rounds: 5 rounds per message/).first().waitFor({ timeout: 4000 });
    // lifting the limit says so; setting rounds again brings the limit back
    await page.getByRole('button', { name: 'No limit' }).tap();
    await page.getByText(/Rounds: no round limit/).first().waitFor({ timeout: 4000 });
    await field.fill('4');
    await page.getByLabel('Rounds').getByRole('button', { name: 'Set' }).last().tap();
    await page.getByText(/Rounds: 4 rounds per message/).first().waitFor({ timeout: 4000 });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('desktop: Enter sends, Shift+Enter makes a new line', async () => {
  const { page, ctx, errors } = await open({ phone: false });
  try {
    await page.getByRole('radio', { name: 'Projects' }).click(); // the sidebar opens on Home; the list is one click away
    await page.waitForTimeout(600);
    await page.getByText('The long one').first().click();
    const field = page.getByLabel('Message PearDrive');
    await field.waitFor();
    await field.click();
    await field.type('first line');
    await field.press('Shift+Enter');
    await field.type('second line');
    assert.match(await field.inputValue(), /first line\nsecond line/);
    await field.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(await field.inputValue(), '');
    assert.ok(await page.getByText('second line').last().isVisible());
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('debug note: a bubble at the bottom follows the note to the Mac and goes once it is there; the button shows the Mac connected', async () => {
  const { page, ctx, errors } = await open();
  try {
    await page.getByRole('tab', { name: 'Projects' }).tap();
    await page.waitForTimeout(400);
    const start = page.getByRole('button', { name: /^Start a debug note/ }).first();
    // the dot: the mock's Mac is on the notes space
    assert.match(await start.getAttribute('aria-label'), /macbook is connected/, 'the button says who is connected');
    assert.equal(await page.locator('[data-connection="connected"]').count(), 1, 'a connected dot sits on the button');
    await start.tap();
    await page.waitForTimeout(1200); // two quick taps on one spot would be a double-tap (zoom) on a phone
    await page.getByRole('button', { name: /^Stop the debug note/ }).first().tap();
    // the bubble comes up at the bottom, above the dock, and says the note is on its way
    const bubble = page.locator('[data-sync-state]');
    await bubble.waitFor({ timeout: 3000 });
    const [b, dock] = [await box(bubble), await box(page.getByRole('tab', { name: 'Projects' }))];
    assert.ok(b.y + b.height <= dock.y + 1, `the bubble sits above the dock (bubble bottom ${Math.round(b.y + b.height)}, dock top ${Math.round(dock.y)})`);
    assert.ok(PHONE.height - (b.y + b.height) < 130, `the bubble is right at the bottom (${Math.round(PHONE.height - (b.y + b.height))}px up)`);
    assert.ok(Math.abs(b.x + b.width / 2 - PHONE.width / 2) < 4, 'the bubble is centred');
    assert.match(await bubble.textContent(), /Waiting|Sending|macbook/);
    // it follows the files to the Mac and glows once they are there
    await page.locator('[data-sync-state="sending"]').waitFor({ timeout: 6000 });
    assert.match(await bubble.textContent(), /Sending to macbook/);
    await page.locator('[data-sync-state="synced"]').waitFor({ timeout: 6000 });
    assert.match(await bubble.textContent(), /On macbook/);
    // and goes on its own a few seconds later
    await bubble.waitFor({ state: 'detached', timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('the bot\'s profile opens from its picture in the chat; its permission mode, model and provider change from there', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page, /Reading the folder/); // PearDrive › General: the seat @rkeychat has spoken here
    await page.getByRole('button', { name: 'Open rkeychat\'s profile' }).first().tap();
    await page.getByText('Role in this project').waitFor({ timeout: 4000 });
    assert.ok(await page.getByText('Permissions').isVisible(), 'the permission section is on the bot\'s profile');
    assert.match(await page.getByText(/Edits · Default · Claude login/).first().textContent(), /Edits · Default/, 'the line under the name says how it runs');
    const modes = page.getByRole('radiogroup', { name: 'Permission mode' });
    assert.equal(await modes.getByRole('radio', { name: /bypass/i }).count(), 0, 'bypass is never offered');
    await modes.getByRole('radio', { name: 'Ask' }).tap();
    await page.getByText(/Ask · Default · Claude login/).first().waitFor({ timeout: 4000 });
    // the model chips and the provider control
    await page.getByRole('button', { name: 'Opus 5.5' }).tap();
    await page.getByText(/Ask · Opus 5.5 · Claude login/).first().waitFor({ timeout: 4000 });
    await page.getByRole('radiogroup', { name: 'Provider' }).getByRole('radio', { name: 'ppq' }).tap();
    await page.getByText(/Ask · Opus 5.5 · via ppq/).first().waitFor({ timeout: 4000 });
    // Auto: one tap, no limit; then a grant of five turns, with how much is left under the mode
    await modes.getByRole('radio', { name: 'Auto' }).tap();
    await page.getByText(/Auto · Opus 5.5 · via ppq/).first().waitFor({ timeout: 4000 });
    assert.match(await page.getByText(/Now: no limit/).first().textContent(), /no limit/, 'Auto with nothing set runs until switched');
    await page.getByRole('textbox', { name: 'Auto turns' }).fill('5');
    await page.getByRole('button', { name: 'Set' }).last().tap();
    await page.getByText(/Auto \(5 turns\) · Opus 5.5 · via ppq/).first().waitFor({ timeout: 4000 });
    assert.match(await page.getByText(/Now: 5 turns left/).first().textContent(), /5 turns left/, 'the grant and what is left of it');
    // the settings live on the profile only: the conversation shows no line for the request or the host's word
    await page.getByRole('button', { name: 'Back' }).first().tap();
    await page.waitForTimeout(400);
    await openThread(page, /Reading the folder/);
    assert.equal(await page.getByText(/now runs:/).count(), 0, 'no "now runs" line in the chat');
    assert.equal(await page.getByText(/changed @rkeychat's settings/).count(), 0, 'no "changed the settings" line in the chat');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('an agent asks for a permission: the card sits in the conversation; Allow once answers it and the card says who did', async () => {
  const { page, ctx, errors } = await open();
  try {
    await openThread(page, /Reading the folder/); // PearDrive › General (its last message) holds the mock's open ask
    const card = page.locator('[data-ask-state="open"]');
    await card.waitFor({ timeout: 4000 });
    assert.match(await card.textContent(), /rkeychat asks for Bash/);
    assert.match(await card.textContent(), /npm run release/);
    assert.match(await card.textContent(), /min left/);
    const allow = card.getByRole('button', { name: 'Allow once' });
    assert.ok(await allow.isVisible(), 'the owner\'s device sees the three answers');
    assert.ok(await card.getByRole('button', { name: 'Deny' }).isVisible());
    // Needs you lists it too
    await page.getByRole('button', { name: 'Back' }).first().tap();
    await page.getByRole('tab', { name: 'Home' }).tap();
    await page.waitForTimeout(500);
    assert.ok(await page.getByText('asks for Bash').first().isVisible(), 'the ask is in Needs you');
    await openThread(page, /Reading the folder/);
    await page.locator('[data-ask-state="open"]').getByRole('button', { name: 'Allow once' }).tap();
    // answered, the card is gone: the ask is one line of the block of permissions asked (the 8:58 memo), closed
    const fold = page.locator('[data-ask-fold]');
    await fold.waitFor({ timeout: 4000 });
    assert.equal(await page.locator('[data-ask-state]').count(), 0, 'no card is left once the ask is answered');
    assert.match(await fold.textContent(), /rkeychat asked for Bash: npm run release -- --tag 0\.4\.0 · allowed/);
    assert.equal(await fold.getAttribute('data-ask-fold'), 'closed');
    await fold.getByRole('button').first().tap();
    await page.waitForTimeout(300);
    assert.equal(await fold.getAttribute('data-ask-fold'), 'open');
    assert.match(await fold.textContent(), /Bash: npm run release.*allowed · guy/s, 'open: one line per ask with its answer');
    const foldBox = await box(fold);
    assert.ok(foldBox.x >= 0 && foldBox.x + foldBox.width <= PHONE.width, 'the block fits the screen');
    // and it left Needs you
    await page.getByRole('button', { name: 'Back' }).first().tap();
    await page.getByRole('tab', { name: 'Home' }).tap();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText('asks for Bash').count(), 0, 'answered: no longer in Needs you');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

// First run (2026-11-24, the build for Guy's brother): a computer that was just installed sees the flow instead of the
// shell. `?setup=fresh` puts the mock in that state: no login, no provider, nothing chosen.
async function openFresh({ phone = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: PHONE, isMobile: true, hasTouch: true, colorScheme: 'dark' } : { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/app/?setup=fresh`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { page, ctx, errors };
}

test('first run: Connect your AI, one step at a time; a key for PPQ connects it; Continue, the folder, Ready, and the shell opens with nothing to set up', async () => {
  const { page, ctx, errors } = await openFresh();
  try {
    assert.ok(await page.getByText('Connect your AI').first().isVisible(), 'the flow stands in for the shell');
    assert.ok(await page.getByText('Step 1 of 3').isVisible());
    const cont = page.getByRole('button', { name: 'Continue' });
    assert.equal(await cont.isEnabled(), false, 'nothing is connected yet: Continue waits');
    // the four ways, Claude first
    const choices = await page.getByRole('radio').allTextContents();
    assert.match(choices[0], /Claude subscription/);
    assert.match(choices[1], /PPQ/);
    assert.match(choices[2], /OpenRouter/);
    assert.match(choices[3], /llama\.cpp/);
    await page.getByRole('radio', { name: 'PPQ' }).click();
    await page.getByLabel('PPQ API key').fill('sk-test-1234');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Key saved · new bots run on it').waitFor({ timeout: 4000 });
    assert.equal(await cont.isEnabled(), true, 'a ready provider connects the AI');
    await cont.click();
    await page.getByText('Where projects live').waitFor();
    assert.ok(await page.getByText('Step 2 of 3').isVisible());
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.match(await page.getByLabel('Setup summary').textContent(), /AI: PPQ/);
    await page.getByRole('button', { name: 'Open rKeyChat' }).click();
    await page.getByRole('radio', { name: 'Home' }).waitFor({ timeout: 4000 });
    assert.equal(await page.getByText('Connect your AI').count(), 0, 'connected: no standing notice on Home');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('first run: the Claude login opens the browser and takes a pasted code; Log in appears as who it is', async () => {
  const { page, ctx, errors } = await openFresh();
  try {
    await page.getByRole('radio', { name: 'Claude subscription' }).click();
    await page.getByRole('button', { name: 'Log in with Claude' }).click();
    await page.getByText('Finish in the browser, then paste the code it shows.').waitFor({ timeout: 4000 });
    assert.ok(await page.getByRole('link', { name: /Open the sign-in page/ }).isVisible(), 'the URL is there when the browser did not open');
    await page.getByLabel('Login code').fill('abcd-1234');
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByText(/Logged in as ben@example.com/).first().waitFor({ timeout: 4000 });
    assert.equal(await page.getByRole('button', { name: 'Continue' }).isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('first run skipped: Home keeps a "Connect your AI" notice that opens the flow again; it closes', async () => {
  const { page, ctx, errors } = await openFresh();
  try {
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.getByText('Where projects live').waitFor();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.getByText('Ready', { exact: true }).waitFor();
    assert.match(await page.getByLabel('Setup summary').textContent(), /not connected yet/);
    await page.getByRole('button', { name: 'Open rKeyChat' }).click();
    const notice = page.getByRole('button', { name: 'Connect your AI' });
    await notice.first().waitFor({ timeout: 4000 });
    assert.ok((await notice.count()) >= 1, 'the notice stands on Home');
    await notice.first().click();
    await page.getByText('Step 1 of 3').waitFor();
    await page.getByRole('button', { name: 'Close setup' }).click();
    await notice.first().waitFor({ timeout: 4000 });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('first run on a phone: agents run on a computer, two steps, no folder to pick', async () => {
  const { page, ctx, errors } = await openFresh({ phone: true });
  try {
    await page.getByText('Your AI runs on a computer').waitFor();
    assert.ok(await page.getByText('Step 1 of 2').isVisible());
    await page.getByRole('button', { name: 'Continue' }).tap();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open rKeyChat' }).tap();
    await page.getByRole('tab', { name: 'Home' }).waitFor({ timeout: 4000 });
    assert.equal(await page.getByText('Connect your AI').count(), 0, 'a phone gets no agent notice');
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('updates: Settings shows the running copy and "Update to 0.3.2"; a version opens its notes and signature; one press downloads and restarts, the sidebar notice following', async () => {
  const { page, ctx, errors } = await open({ phone: false });
  try {
    // the sidebar notice is there before Settings is even opened
    const notice = page.getByRole('button', { name: 'Update to 0.3.2' });
    await notice.first().waitFor();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByText('0.3.1 · build 2026-11-25.1 · abc1234').waitFor();
    await page.getByText('/Applications/rKeyChat.app').first().waitFor();
    assert.equal(await notice.count(), 2, 'the notice in the sidebar and the button in the Updates block');
    // a version's window: notes, and who signed it
    await page.getByRole('button', { name: 'Release notes for 0.3.2' }).click();
    await page.getByText('Signed by the rKeyChat publisher').waitFor();
    await page.getByText(/the previous copy is kept/).waitFor();
    await page.keyboard.press('Escape'); // the release window closes
    await page.getByText('Signed by the rKeyChat publisher').waitFor({ state: 'hidden' });
    // one press: download with progress, then the swap
    await notice.last().click();
    await page.getByText(/Downloading update…|Downloading 0\.3\.2/).first().waitFor({ timeout: 3000 });
    await page.getByText('Restarting…').waitFor({ timeout: 6000 });
    await page.getByText(/Installing 0\.3\.2/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('updates: a copy on the newest version has no notice and says so in Settings', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  try {
    await page.goto(`http://127.0.0.1:${PORT}/app/?updates=none`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByText("You're up to date").waitFor();
    assert.equal(await page.getByRole('button', { name: /^Update to/ }).count(), 0);
  } finally {
    await ctx.close();
  }
});
