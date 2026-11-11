// Search over a real room on disk, with the SQLite index and with the in-memory scan it falls back to. Both
// must give the same answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { RoomSearch, queryOf } from '../src/search.js'

const A = 'a'.repeat(64)
const t0 = 1_700_000_000_000
function makeRoom () {
  const dir = mkdtempSync(join(tmpdir(), 'rkc-search-'))
  const store = new RoomStore(dir)
  const msg = (id, i, text, extra = {}) => store.add({ id, kind: 'msg', ts: t0 + i * 1000, author: A, text, ...extra })
  msg('m1', 1, 'we should deploy the Zürich build tomorrow')
  msg('m2', 2, 'deployment went fine')
  msg('m3', 3, 'lunch?')
  msg('m4', 4, '', { att: [{ kind: 'file', name: 'budget-2027.xlsx', hash: 'h', mime: 'x', size: 1 }] })
  msg('m5', 5, 'the secret plan')
  store.add({ id: 'x', kind: 'redact', ts: t0 + 6000, author: A, target: 'm5' })
  for (let i = 0; i < 50; i++) msg(`f${i}`, 10 + i, `filler ${i}`)
  const room = new Room({ store, room: { name: 'test', topic: 'feedcafe' }, device: null })
  return { dir, store, room, msg, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

for (const engine of ['sqlite', 'scan']) {
  const searcher = (room) => { if (engine === 'scan') room._search = new RoomSearch(room, { scanOnly: true }); return room }

  test(`${engine}: every word must be in the message, anywhere and in any order; a word or its start, any case, any accent`, () => {
    const { room, done } = makeRoom(); searcher(room)
    try {
      assert.equal(room.search.engine, engine)
      assert.deepEqual(room.find('deplo').map((r) => r.id), ['m2', 'm1'], 'prefix, newest first')
      assert.deepEqual(room.find('DEPLOY zurich').map((r) => r.id), ['m1'], 'both words; case and accents fold; m2 has only one')
      assert.deepEqual(room.find('tomorrow deploy').map((r) => r.id), ['m1'], 'any order, not next to each other')
      assert.deepEqual(room.find('zurich lunch'), [], 'no message has both')
      assert.deepEqual(room.find('ploy').map((r) => r.id), [], 'the middle of a word is not a match')
      const hit = room.find('zurich')[0]
      assert.ok(hit.snippet.includes('\u0002Zürich\u0003'), 'the match is marked in the snippet, as written')
      assert.equal(hit.name, A.slice(0, 16)); assert.equal(hit.ts, t0 + 1000)
    } finally { done() }
  })

  test(`${engine}: shared file names are found, removed messages never are`, () => {
    const { room, done } = makeRoom(); searcher(room)
    try {
      assert.deepEqual(room.find('budget').map((r) => r.id), ['m4'])
      assert.deepEqual(room.find('secret'), [])
    } finally { done() }
  })

  test(`${engine}: what arrives after the first search is found, and a later removal disappears`, () => {
    const { room, msg, store, done } = makeRoom(); searcher(room)
    try {
      assert.deepEqual(room.find('pancakes'), [])
      msg('late', 0.5, 'pancakes from history sync', {}) // older than everything, arriving now
      assert.deepEqual(room.find('pancakes').map((r) => r.id), ['late'])
      store.add({ id: 'x2', kind: 'redact', ts: t0 + 99_000, author: A, target: 'late' })
      assert.deepEqual(room.find('pancakes'), [])
    } finally { done() }
  })

  test(`${engine}: nonsense and syntax are just words`, () => {
    const { room, done } = makeRoom(); searcher(room)
    try {
      for (const q of ['', '   ', '"', '*', 'NEAR(', 'a OR', '") OR 1=1 --', '^lunch']) assert.doesNotThrow(() => room.find(q), q)
      assert.deepEqual(room.find('^lunch?').map((r) => r.id), ['m3'])
      assert.equal(room.find('filler', { limit: 5 }).length, 5)
    } finally { done() }
  })
}

test('the index lives beside the log, and is rebuilt from it when deleted', () => {
  const { dir, room, done } = makeRoom()
  try {
    assert.equal(room.find('lunch').length, 1)
    assert.ok(existsSync(join(dir, 'search.db')))
    room.stop(); rmSync(join(dir, 'search.db')); rmSync(join(dir, 'search.db-wal'), { force: true }); rmSync(join(dir, 'search.db-shm'), { force: true })
    room._search = undefined
    assert.deepEqual(room.find('lunch').map((r) => r.id), ['m3'])
  } finally { done() }
})

test('queryOf turns typing into quoted prefix words, all required, never FTS syntax', () => {
  assert.equal(queryOf('Deploy  zürich!'), '"deploy"* "zurich"*')
  assert.equal(queryOf('") OR 1=1 --'), '"or"* "1"*')
  assert.equal(queryOf('***'), '')
})

test('the one old message with both words is found under many newer ones with only one', () => {
  const { room, msg, done } = makeRoom()
  try {
    msg('both', 0.2, 'the rare fox note') // the oldest message in the room
    for (let i = 0; i < 300; i++) msg(`n${i}`, 100 + i, `the note ${i}`) // many newer ones with only "note"
    assert.deepEqual(room.find('fox note', { limit: 10 }).map((r) => r.id), ['both'])
  } finally { done() }
})
