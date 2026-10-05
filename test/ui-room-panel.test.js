// The room panel is the only place the room's hard rules can be changed, so its
// markup is worth a test. The web UI is a plain <script>, so we run it in a vm
// over a DOM stub thin enough to be obvious and append an accessor to reach the
// script's own scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function loadUI () {
  const html = readFileSync(join(here, '..', 'src', 'ui', 'index.html'), 'utf8')
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

  // anything the page touches at load time answers, and answers with itself
  const el = () => new Proxy(function () {}, {
    apply: () => el(),
    set: () => true,
    get (_, k) {
      if (k === 'classList') return { toggle () {}, add () {}, remove () {}, contains: () => false }
      if (k === 'style') return { setProperty () {}, removeProperty () {} }
      if (k === 'dataset') return {}
      if (k === 'tagName') return 'DIV'
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return ''
      if (k === 'hidden') return true
      if (k === 'children' || k === 'childNodes') return []
      if (k === 'parentElement' || k === 'closest') return null
      if (k === Symbol.toPrimitive) return () => ''
      return el()
    }
  })
  const doc = {
    getElementById: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener () {},
    documentElement: el(),
    body: el(),
    activeElement: null
  }
  const noop = () => {}
  const ctx = createContext({
    document: doc,
    addEventListener: noop,
    removeEventListener: noop,
    scrollTo: noop,
    innerWidth: 1400,
    innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener () {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    IntersectionObserver: class { observe () {} disconnect () {} },
    ResizeObserver: class { observe () {} disconnect () {} },
    MutationObserver: class { observe () {} disconnect () {} },
    performance: { now: () => 0 },
    history: { replaceState: noop, pushState: noop },
    AbortController,
    TextDecoder,
    TextEncoder,
    FormData,
    Blob,
    crypto,
    alert: noop,
    confirm: () => true,
    window: { innerWidth: 1400, innerHeight: 900, addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener () {} }) },
    localStorage: { getItem: () => null, setItem () {}, removeItem () {} },
    location: { origin: 'http://127.0.0.1:4455', href: 'http://127.0.0.1:4455/', hash: '', search: '' },
    navigator: { clipboard: null, mediaDevices: null, userAgent: 'node' },
    EventSource: class { addEventListener () {} close () {} },
    fetch: () => new Promise(() => {}),
    requestAnimationFrame: () => 0,
    Audio: class { addEventListener () {} play () { return Promise.resolve() } },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    URL,
    Date,
    Math,
    JSON
  })
  ctx.globalThis = ctx
  ctx.window.location = ctx.location
  // appended inside the same script, so it can see the script's own const/let
  runInContext(src + '\n;globalThis.__ui = { renderRoomPage, setState (s, p) { S = s; people = p } };', ctx)
  return ctx.__ui
}

const roomFixture = (over = {}) => ({
  topic: 'a'.repeat(64),
  name: 'PearDrive Lab',
  owner: true,
  root: 'ed25519:' + 'b'.repeat(64),
  style: 'concise',
  log: [],
  members: [],
  participants: [
    { name: 'guy', role: 'human', status: 'active', local: true, online: true, keys: [] },
    { name: 'claude', role: 'agent', status: 'active', online: true, keys: [] },
    { name: 'kimi-mini', role: 'agent', status: 'active', online: true, keys: [] },
    { name: 'kimi-zorin', role: 'agent', status: 'active', online: false, keys: [] }
  ],
  charter: {
    text: 'This room is the PearDrive lab.',
    order: ['claude', 'kimi-mini', 'kimi-zorin'],
    agents: { 'kimi-zorin': { wake: 'mention', role: 'security', tokensPerDay: 2_000_000 } }
  },
  budget: { used: 1, limit: 3, paused: false, unlimited: false, until: 0, agents: { paused: [], limits: {}, posts: {} } },
  spend: { claude: { total: 1_500_000, wakes: 4, cacheRead: 1_400_000 } },
  overBudget: {},
  ...over
})

const render = (over) => {
  const ui = loadUI()
  const room = roomFixture(over)
  ui.setState({ current: room, rooms: [room], device: { participants: [{ name: 'guy', role: 'human' }] } }, { local: [], known: [] })
  return ui.renderRoomPage()
}

test('every agent appears exactly once in the order list, and nowhere else as a rule row', () => {
  const html = render()
  for (const n of ['claude', 'kimi-mini', 'kimi-zorin']) {
    assert.equal((html.match(new RegExp(`data-order="${n}"`, 'g')) ?? []).length, 1, `${n} listed once`)
    assert.equal((html.match(new RegExp(`data-rule-row="${n}"`, 'g')) ?? []).length, 1, `${n} has one settings drawer`)
  }
  // the drawer is inside the row it belongs to, so a drag carries it along
  assert.match(html, /data-order="claude"[\s\S]{0,900}?data-rule-row="claude"[\s\S]*?data-order="kimi-mini"/)
})

test('the badge numbers only the agents that take the open floor', () => {
  const html = render()
  const idx = [...html.matchAll(/<span class="idx([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1].trim(), m[2]])
  assert.deepEqual(idx, [['', '1'], ['', '2'], ['is-mention', '@']])
})

test('drawers, tips and the prompt start closed but are present, so toggling them never repaints', () => {
  const html = render()
  assert.match(html, /<div class="rule-panel"[^>]*data-rule-row="claude" hidden>/)
  assert.match(html, /<textarea class="text-input" id="charterText"[^>]*hidden>/)
  for (const k of ['rounds', 'runfor', 'prompt', 'agents', 'style']) {
    assert.match(html, new RegExp(`class="info" data-tip="${k}"`), `${k} has an info dot`)
    assert.match(html, new RegExp(`class="tip" data-tip-for="${k}" hidden`), `${k}'s tip is present and closed`)
  }
})

test('the controls Guy asked to be gone are gone', () => {
  const html = render()
  assert.doesNotMatch(html, /data-n="10"/, 'no +10')
  assert.doesNotMatch(html, /data-ctl="reset"/, 'no Reset')
  assert.doesNotMatch(html, /backup/i, 'no backup-for control')
  assert.doesNotMatch(html, /waits \d+s|answers first<\/span>/, 'no per-row wake commentary')
  assert.equal((html.match(/data-ctl="(pause|resume)"/g) ?? []).length, 1, 'exactly one pause control, in the header')
})

test('rounds, run-for and the prompt each get one line', () => {
  const html = render()
  assert.match(html, /Rounds<button class="info"[\s\S]*?id="roundsN"[\s\S]*?id="roundsAdd"/)
  assert.match(html, /Run for<button class="info"[\s\S]*?id="runHours"[\s\S]*?id="runFor"/)
  assert.match(html, /Room Prompt<button class="info"[\s\S]*?id="promptEdit"/)
  assert.match(html, /1 \/ 3 used/)
})

test('a budget that has been spent is visible on the row, not only in the drawer', () => {
  const html = render({ overBudget: { claude: { cap: 1_000_000, spent: 1_500_000 } } })
  assert.match(html, /data-order="claude"[\s\S]{0,400}?pill tone-bad">over</)
  assert.match(html, /rule-panel is-over/)
})

test('a paused agent reads as off and keeps its switch', () => {
  const html = render({ budget: { ...roomFixture().budget, agents: { paused: ['kimi-mini'], limits: {}, posts: {} } } })
  assert.match(html, /order-item is-off" data-order="kimi-mini"/)
  assert.match(html, /data-agent-toggle="kimi-mini" ><span/)
})

test('a member who does not own the room gets no editing controls', () => {
  const html = render({ owner: false })
  assert.doesNotMatch(html, /id="charterText"/)
  assert.doesNotMatch(html, /data-rule-cap/)
  assert.doesNotMatch(html, /class="grip"/)
  assert.match(html, /id="charterRead"/)
  assert.match(html, /data-rule-row="claude"/) // still readable
})

// exported so a scratch script can print the markup while working on the panel
export { loadUI, roomFixture, render }
