// The chat holds a window of the history, not all of it, and asks the daemon for more at either edge or
// around a message it jumps to. These are the slices those requests get.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowOf, PAGE_MAX } from '../src/feed-window.js'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'

const room = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))
const ids = (list, w) => list.slice(w.start, w.end).map((r) => r.id)

test('opening a room gets the newest page, and knows there is older', () => {
  const list = room(500)
  const w = windowOf(list, { limit: 50 })
  assert.deepEqual([w.start, w.end, w.hasOlder, w.hasNewer], [450, 500, true, false])
})

test('a room smaller than a page comes whole, with nothing either side', () => {
  const w = windowOf(room(12), { limit: 50 })
  assert.deepEqual([w.start, w.end, w.hasOlder, w.hasNewer], [0, 12, false, false])
})

test('scrolling up asks for the page just before the oldest one held', () => {
  const list = room(500)
  const w = windowOf(list, { before: 'm450', limit: 50 })
  assert.equal(ids(list, w)[0], 'm400'); assert.equal(ids(list, w).at(-1), 'm449')
  assert.equal(w.hasOlder, true); assert.equal(w.hasNewer, true)
})

test('the first page of the room says there is nothing older', () => {
  const list = room(500)
  const w = windowOf(list, { before: 'm30', limit: 50 })
  assert.deepEqual([w.start, w.end, w.hasOlder], [0, 30, false])
})

test('scrolling down asks for the page just after the newest one held', () => {
  const list = room(500)
  const w = windowOf(list, { after: 'm99', limit: 50 })
  assert.deepEqual(ids(list, w).slice(0, 1).concat(ids(list, w).slice(-1)), ['m100', 'm149'])
  const end = windowOf(list, { after: 'm480', limit: 50 })
  assert.deepEqual([end.start, end.end, end.hasNewer], [481, 500, false])
})

test('jumping to a message puts it in the middle of its window', () => {
  const list = room(500)
  const w = windowOf(list, { around: 'm200', limit: 50 })
  assert.deepEqual([w.start, w.end], [175, 225])
  assert.ok(ids(list, w).includes('m200'))
})

test('jumping near either end keeps the window full rather than centred', () => {
  const list = room(500)
  assert.deepEqual(Object.values(windowOf(list, { around: 'm3', limit: 50 })).slice(0, 2), [0, 50])
  assert.deepEqual(Object.values(windowOf(list, { around: 'm498', limit: 50 })).slice(0, 2), [450, 500])
})

test('a message that is not in the room is null, not an empty page', () => {
  assert.equal(windowOf(room(10), { around: 'nope' }), null)
  assert.equal(windowOf(room(10), { before: 'nope' }), null)
  assert.equal(windowOf(room(10), { after: 'nope' }), null)
})

test('the page size is clamped: nonsense gets the default, and no request takes the whole history', () => {
  const list = room(1000)
  assert.equal(windowOf(list, { limit: 0 }).end - windowOf(list, { limit: 0 }).start, 50)
  assert.equal(windowOf(list, { limit: -5 }).end - windowOf(list, { limit: -5 }).start, 50)
  assert.equal(windowOf(list, { limit: 'abc' }).end - windowOf(list, { limit: 'abc' }).start, 50)
  assert.equal(windowOf(list, { limit: 100000 }).end - windowOf(list, { limit: 100000 }).start, PAGE_MAX)
})

// The same, through a real room on disk (no network): what GET /api/log hands the page.
test('room.page() leaves out reactions, shows removals in place, and decorates only its window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rkc-page-'))
  try {
    const store = new RoomStore(dir)
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 120; i++) {
      store.add({ id: `m${i}`, kind: 'msg', ts: t0 + i * 1000, author: 'a'.repeat(64), text: `hello ${i}` })
      if (i % 10 === 0) store.add({ id: `r${i}`, kind: 'react', ts: t0 + i * 1000 + 1, author: 'a'.repeat(64), target: `m${i}`, emoji: '👍', on: true })
    }
    store.add({ id: 'x1', kind: 'redact', ts: t0 + 200_000, author: 'a'.repeat(64), target: 'm115' })
    const room = new Room({ store, room: { name: 'test', topic: 'feedcafe' }, device: null })

    const newest = room.page({ limit: 50 })
    assert.equal(newest.log.length, 50)
    assert.ok(newest.log.every((r) => r.kind === 'msg'), 'reactions and removals are not lines of their own')
    assert.deepEqual([newest.log[0].id, newest.log.at(-1).id, newest.hasOlder, newest.hasNewer], ['m70', 'm119', true, false])
    const removed = newest.log.find((r) => r.id === 'm115')
    assert.equal(removed.text, ''); assert.ok(removed.redacted, 'a removed message keeps its place, emptied')

    const older = room.page({ before: 'm70', limit: 50 })
    assert.deepEqual([older.log[0].id, older.log.at(-1).id], ['m20', 'm69'])
    const around = room.page({ around: 'm5', limit: 50 })
    assert.deepEqual([around.log[0].id, around.hasOlder, around.hasNewer], ['m0', false, true])
    assert.equal(room.page({ around: 'r10' }), null, 'a reaction is not a feed line to jump to')
    assert.equal(room.page({ around: 'nope' }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
