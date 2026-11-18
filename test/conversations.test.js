// Conversations inside a room: which records belong where, the conversation list, scoped pages,
// budgets and turns. Raw records go straight into a RoomStore (no chain, no pearcore), as the
// feed-window and search tests do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { MAIN, isConvId, newConvId } from '../src/proto.js'
import { renderTurn } from '../src/agents.js'
import { sessionKeyOf } from '../src/config.js'

const A = 'a'.repeat(64); const B = 'b'.repeat(64) // two authors (no chain: names are the first 16 chars)
const T0 = 1_700_000_000_000
let n = 0
const msg = (text, { conv, ts = T0 + (++n) * 1000, author = A, re = [], mentions = [], human = false, depth = 0 } = {}) =>
  ({ id: `m${n}`, kind: 'msg', ts, author, text, mentions, re, depth, ...(conv ? { conv } : {}) })
const ctl = (action, fields, ts = T0 + (++n) * 1000) => ({ id: `c${n}`, kind: 'control', ts, author: A, action, ...fields })

function setup (records) {
  n = 0
  const dir = mkdtempSync(join(tmpdir(), 'rkc-conv-'))
  const store = new RoomStore(dir)
  for (const r of (typeof records === 'function' ? records() : records)) store.add(r)
  const room = new Room({ store, room: { name: 'test', topic: 'feedcafe' }, device: null })
  return { room, store, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('conversation ids: main, or 8-32 hex characters', () => {
  assert.equal(isConvId(MAIN), true)
  assert.equal(isConvId(newConvId()), true)
  assert.equal(isConvId('xyz'), false)
  assert.equal(isConvId(''), false)
  assert.equal(sessionKeyOf('topic1', MAIN), 'topic1', 'the default conversation keeps the old key, so saved sessions survive')
  assert.equal(sessionKeyOf('topic1', 'abcdef12'), 'topic1/abcdef12')
})

test('records without a conv belong to main; reactions and removals follow their target', () => {
  const c1 = 'c0ffee0000000001'
  const { store, done } = setup(() => [
    msg('hello'), msg('in the thread', { conv: c1 }),
    { id: 'r1', kind: 'react', ts: T0 + 50_000, author: B, target: 'm2', emoji: '👍', on: true },
    { id: 'x1', kind: 'redact', ts: T0 + 60_000, author: A, target: 'm1' },
    ctl('extend', { n: 2 }), ctl('conv', { conv: c1, text: 'Thread' })
  ])
  try {
    assert.equal(store.convOf(store.get('m1')), MAIN)
    assert.equal(store.convOf(store.get('m2')), c1)
    assert.equal(store.convOf(store.get('r1')), c1, 'a reaction is in the conversation of the message it reacts to')
    assert.equal(store.convOf(store.get('x1')), MAIN)
    const main = store.inConv(MAIN).map((r) => r.id); const thread = store.inConv(c1).map((r) => r.id)
    assert.ok(main.includes('m1') && !main.includes('m2'))
    assert.ok(thread.includes('m2') && thread.includes('r1') && !thread.includes('m1'))
    assert.ok(main.includes(store.ordered.find((r) => r.action === 'extend').id) && thread.includes(store.ordered.find((r) => r.action === 'extend').id), 'a room-wide control is in every conversation')
    const note = store.ordered.find((r) => r.action === 'conv').id
    assert.ok(main.includes(note) && !thread.includes(note), 'the notes describing conversations live in main')
  } finally { done() }
})

test('the conversation list: main first, titles and flags from the latest note, last message and count', () => {
  const c1 = 'c0ffee0000000001'; const c2 = 'c0ffee0000000002'
  const { room, done } = setup(() => [
    msg('first'),
    ctl('conv', { conv: c1, text: 'Plan the launch' }),
    msg('step one', { conv: c1 }), msg('step two', { conv: c1, author: B }),
    ctl('conv', { conv: c2, text: 'Scratch' }), ctl('conv', { conv: c2, archived: true }),
    ctl('conv', { conv: c1, runtime: 'acp' }),
    ctl('conv', { conv: MAIN, text: 'Lobby' }),
    { id: 'x9', kind: 'redact', ts: T0 + 900_000, author: A, target: 'm3' }
  ])
  try {
    const convs = room.conversations()
    assert.deepEqual(convs.map((c) => c.conv), [MAIN, c1, c2])
    const [main, plan, scratch] = convs
    assert.equal(main.title, 'Lobby', 'the default conversation can be renamed')
    assert.equal(main.count, 1); assert.equal(main.last.text, 'first')
    assert.equal(plan.title, 'Plan the launch'); assert.equal(plan.runtime, 'acp'); assert.equal(plan.archived, false)
    assert.equal(plan.count, 1, 'a removed message is not counted'); assert.equal(plan.last.text, 'step two')
    assert.equal(scratch.archived, true); assert.equal(scratch.count, 0); assert.equal(scratch.last, null)
    assert.equal(room.conversation(c2).title, 'Scratch')
    assert.equal(room.conversation('nope'), null)
    assert.equal(room.lastMessage(c1).text, 'step two'); assert.equal(room.lastMessage().text, 'step two')
  } finally { done() }
})

test('pages and logs are scoped to one conversation; conversation notes are never feed lines', () => {
  const c1 = 'c0ffee0000000001'
  const { room, done } = setup(() => [
    msg('a'), msg('b', { conv: c1 }), ctl('conv', { conv: c1, text: 'T' }), ctl('rename', { name: 'Renamed' }), msg('c'), msg('d', { conv: c1 })
  ])
  try {
    const all = room.page().log.map((r) => r.id)
    assert.deepEqual(all, ['m1', 'm2', 'c4', 'm5', 'm6'], 'without a conversation, everything but the notes, as before')
    assert.deepEqual(room.page({ conv: MAIN }).log.map((r) => r.id), ['m1', 'c4', 'm5'])
    assert.deepEqual(room.page({ conv: c1 }).log.map((r) => r.id), ['m2', 'c4', 'm6'], 'a room-wide control shows in every conversation')
    assert.ok(room.page({ conv: c1 }).log.every((r) => r.conv === (r.kind === 'control' ? MAIN : c1)), 'every record says which conversation it is in')
    assert.deepEqual(room.log(c1).filter((r) => r.kind === 'msg').map((r) => r.id), ['m2', 'm6'])
    assert.equal(room.page({ conv: c1, around: 'm1' }), null, 'a message from another conversation is not in this page')
  } finally { done() }
})

test('the round budget resets per conversation: a person speaking in one thread does not free another', () => {
  const c1 = 'c0ffee0000000001'
  // no chain: nobody is "human", so mark depth by hand through controls instead: extend applies everywhere
  const { room, done } = setup(() => [msg('a'), ctl('extend', { n: 2 }), msg('b', { conv: c1 })])
  try {
    assert.equal(room.budget().limit, 5)
    assert.equal(room.budget(c1).limit, 5, 'room-wide controls count in every conversation')
    assert.equal(room.budget(MAIN).limit, 5)
  } finally { done() }
})

test('search can be narrowed to one conversation', () => {
  const c1 = 'c0ffee0000000001'
  const { room, done } = setup(() => [msg('deploy the thing'), msg('deploy again', { conv: c1 }), msg('nothing here', { conv: c1 })])
  try {
    room._search = new (room.search.constructor)(room, { scanOnly: true })
    assert.deepEqual(room.find('deploy').map((r) => r.id).sort(), ['m1', 'm2'])
    assert.deepEqual(room.find('deploy', { conv: c1 }).map((r) => r.id), ['m2'])
    assert.deepEqual(room.find('deploy', { conv: MAIN }).map((r) => r.id), ['m1'])
  } finally { done() }
})

test('a turn is rendered from one conversation only, and names it', () => {
  const c1 = 'c0ffee0000000001'
  const { room, done } = setup(() => [
    ctl('conv', { conv: c1, text: 'Side quest' }),
    msg('main talk'), msg('thread talk', { conv: c1 }), msg('more thread', { conv: c1, author: B })
  ])
  try {
    const t = renderTurn(room, 'bot', { conv: c1 })
    assert.ok(t.text.includes('thread talk') && t.text.includes('more thread'))
    assert.ok(!t.text.includes('main talk'), 'the other conversation is not in the turn')
    assert.ok(t.text.includes('conversation: Side quest'))
    const m = renderTurn(room, 'bot', { conv: MAIN })
    assert.ok(m.text.includes('main talk') && !m.text.includes('thread talk'))
    assert.ok(!m.text.includes('conversation:'), 'the main conversation is unnamed in the header')
  } finally { done() }
})
