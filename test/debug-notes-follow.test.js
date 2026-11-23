// Following another device's notes (2026-11-23: "it acts like none of the debug notes are being fetched"): a link
// given once is kept in follow.json and joined again at start; whenever the followed device is heard from on its
// space, the note files this device lacks are fetched right away, into from/<host>/notes/<id>/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeShareLink } from 'pearcore/src/utils/sharelink.utils.js'

const data = mkdtempSync(join(tmpdir(), 'rkc-follow-'))
process.env.RKEYCHAT_DATA = data
const { DebugNotes } = await import('../src/debug-notes.js')

const TOPIC = 'ee'.repeat(32)
const PHONE = 'ab'.repeat(32)
const name = 'rKeyChat Debug Notes (guy-phone)'
let link
try { link = encodeShareLink({ spaceName: name, publicKey: PHONE, nonce: '22'.repeat(12) }) } catch { link = null }

let peers = 0
let joined = 0
const listing = {}
const downloaded = []
const emitter = new EventEmitter()
const space = { spaceName: name, topicHash: TOPIC, sharelink: link }
const app = {
  cfg: { deviceName: 'macbook' },
  device: { ref: 'rkey:ab:' + 'ff'.repeat(32) },
  devices: () => [],
  core: {
    emitter,
    space: { list: async () => (joined ? [space] : []), join: async (l) => { assert.equal(l, link); joined++; return space } },
    managers: {
      sockets: { getConnectedSockets: () => Array.from({ length: peers }, () => ({})) },
      spaceFileList: { get: (t) => (t === TOPIC ? listing : {}) }
    },
    drives: {
      get: (s) => ({
        getFile: async (path) => ({
          download: async (root, dest) => {
            downloaded.push(path)
            writeFileSync(dest, `bytes of ${path} @${root}`)
            return { onComplete: (fn) => setTimeout(fn, 5), onError: () => {} }
          }
        })
      })
    }
  }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

test('a followed link is kept, joined, and its notes fetched when the device is heard from', { skip: !link && 'no sharelink encoder' }, async (t) => {
  t.after(() => rmSync(data, { recursive: true, force: true }))
  const notes = new DebugNotes(app)
  notes.manifested = true

  await assert.rejects(notes.follow('pearcore://nonsense'), /isn't a debug-notes link/)

  const r = await notes.follow(link)
  assert.deepEqual(r, { host: 'guy-phone', topic: TOPIC, peers: 0, notes: 0 })
  assert.equal(joined, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'debug-notes', 'follow.json'), 'utf8')), { 'guy-phone': link })
  assert.deepEqual(notes.following(), { 'guy-phone': link })

  // the phone comes on the screen: it connects and lists a note; the Mac fetches the files it lacks
  listing['/notes/2026-11-23T15-49-33/note.json'] = { r1: { peers: { [PHONE]: { timestamp: 10 } } } }
  listing['/notes/2026-11-23T15-49-33/trace.jsonl'] = { r2: { peers: { [PHONE]: { timestamp: 10 } } } }
  listing['/notes/2026-11-23T15-49-33/note.m4a'] = { r3: { peers: { [PHONE]: { timestamp: 10 } } } }
  peers = 1
  emitter.emit('Connection', { topics: [TOPIC] })
  await tick(1800)
  assert.deepEqual(downloaded.sort(), ['/notes/2026-11-23T15-49-33/note.json', '/notes/2026-11-23T15-49-33/note.m4a', '/notes/2026-11-23T15-49-33/trace.jsonl'])
  const dir = join(data, 'debug-notes', 'from', 'guy-phone', 'notes', '2026-11-23T15-49-33')
  assert.ok(existsSync(join(dir, 'note.m4a')))
  assert.equal(readFileSync(join(dir, 'note.json'), 'utf8'), 'bytes of /notes/2026-11-23T15-49-33/note.json @r1')
  assert.ok(notes.list().some((n) => n.id === '2026-11-23T15-49-33' && n.from === 'guy-phone'), 'the pulled note is listed, with where it came from')

  // a new note announced while connected: fetched too, and nothing fetched twice
  downloaded.length = 0
  listing['/notes/2026-11-23T16-00-00/note.json'] = { r4: { peers: { [PHONE]: { timestamp: 11 } } } }
  emitter.emit('SpaceFileEvent', { message: { topic: Buffer.from(TOPIC, 'hex') } })
  await tick(1800)
  assert.deepEqual(downloaded, ['/notes/2026-11-23T16-00-00/note.json'])

  // not connected: nothing is tried (a download would wait 90 s for a phone that is not there)
  downloaded.length = 0
  peers = 0
  listing['/notes/2026-11-23T17-00-00/note.json'] = { r5: { peers: { [PHONE]: { timestamp: 12 } } } }
  emitter.emit('SpaceHashList', { message: { topic: TOPIC }, topics: [TOPIC] })
  await tick(1800)
  assert.deepEqual(downloaded, [])

  // a second daemon start follows again from the file
  const again = new DebugNotes(app)
  again.manifested = true
  const all = await again.followAll()
  assert.deepEqual(all.map((x) => x.host), ['guy-phone'])
  assert.equal(joined, 1, 'already joined: not joined twice')
  assert.deepEqual((await again.unfollow('guy-phone')).following, [])
  assert.deepEqual(again.following(), {})
})
