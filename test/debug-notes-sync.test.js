// The serving side of a debug-notes pull, as the phone's bubble shows it: a note is "local" until a reader asks
// for its files, "fetching" while it asks, "fetched" once the last chunk of every file was asked for; the dot says
// whether anyone is on the notes space. A peer's refusal is kept, so a pull can say why it is not going to work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'rkc-notes-'))
process.env.RKEYCHAT_DATA = data
const { DebugNotes } = await import('../src/debug-notes.js')

const MAC = 'ab'.repeat(32)
const TOPIC = 'cd'.repeat(32)
let peers = 0
const emitter = new EventEmitter()
const app = {
  cfg: { deviceName: 'guy-phone' },
  device: { ref: 'rkey:ab:' + 'ff'.repeat(32) },
  devices: () => [{ ref: 'rkey:ab:' + MAC, name: 'macbook', online: true, here: false }],
  core: {
    emitter,
    space: { list: async () => [{ spaceName: 'rKeyChat Debug Notes (guy-phone)', topicHash: TOPIC, sharelink: 'pearcore://x' }] },
    managers: { sockets: { getConnectedSockets: () => Array.from({ length: peers }, () => ({})) } }
  }
}

function note (id, audioBytes) {
  const d = join(data, 'debug-notes', 'notes', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'note.m4a'), Buffer.alloc(audioBytes))
  writeFileSync(join(d, 'trace.jsonl'), '{"t":0}\n')
  writeFileSync(join(d, 'note.json'), JSON.stringify({ id, audio: 'note.m4a', trace: 'trace.jsonl', seconds: 3, steps: 1 }))
}
const ask = (kind, path, slice) => emitter.emit(kind === 'tree' ? 'SpaceFileTreeRequest' : 'SpaceFileContentRequest', { info: { publicKey: Buffer.from(MAC, 'hex') }, message: { topic: TOPIC, payload: { spaceFilePath: path, slice } } })

test('a note goes local → fetching → fetched as the Mac asks for its files; the dot follows the peers', async (t) => {
  t.after(() => rmSync(data, { recursive: true, force: true }))
  note('2026-11-22T18-09-52', 600 * 1024) // the audio is 3 chunks of 256 KB
  const notes = new DebugNotes(app)
  notes.manifested = true // no manifest to write in this test
  await notes.open()

  let s = notes.status()
  assert.equal(s.connected, false)
  assert.deepEqual(s.notes['2026-11-22T18-09-52'], { files: 3, state: 'local', by: {} })

  peers = 1
  ask('tree', '/notes/2026-11-22T18-09-52/note.m4a')
  s = notes.status()
  assert.equal(s.connected, true)
  assert.equal(s.notes['2026-11-22T18-09-52'].state, 'fetching')
  assert.deepEqual(s.notes['2026-11-22T18-09-52'].by[MAC], { name: 'macbook', got: 0, of: 3 })
  assert.deepEqual(s.readers, [{ key: MAC, name: 'macbook' }])

  // the first two chunks of the audio: not got yet; the last one: got
  ask('content', '/notes/2026-11-22T18-09-52/note.m4a', [0, 1])
  assert.equal(notes.status().notes['2026-11-22T18-09-52'].by[MAC].got, 0)
  ask('content', '/notes/2026-11-22T18-09-52/note.m4a', [2, 2])
  assert.equal(notes.status().notes['2026-11-22T18-09-52'].by[MAC].got, 1)
  assert.equal(notes.status().notes['2026-11-22T18-09-52'].state, 'fetching')

  ask('content', 'notes/2026-11-22T18-09-52/trace.jsonl', [0, 0]) // with or without the leading slash
  ask('content', '/notes/2026-11-22T18-09-52/note.json', [0, 0])
  s = notes.status()
  assert.equal(s.notes['2026-11-22T18-09-52'].state, 'fetched')
  assert.deepEqual(s.notes['2026-11-22T18-09-52'].by[MAC], { name: 'macbook', got: 3, of: 3 })

  // another space's requests, and files outside notes/, are not ours
  emitter.emit('SpaceFileTreeRequest', { info: { publicKey: Buffer.from('ee'.repeat(32), 'hex') }, message: { topic: 'other', payload: { spaceFilePath: '/notes/2026-11-22T18-09-52/note.json' } } })
  emitter.emit('SpaceFileTreeRequest', { info: { publicKey: Buffer.from('ee'.repeat(32), 'hex') }, message: { topic: TOPIC, payload: { spaceFilePath: '/space.json' } } })
  assert.equal(notes.status().readers.length, 1)

  // a refusal is remembered with its reason
  emitter.emit('Reject', { fromPublicKey: MAC, reason: 'Space file not found' })
  assert.equal(notes.lastReject.reason, 'Space file not found')
  assert.equal(notes.lastReject.from, MAC.slice(0, 8))
})
