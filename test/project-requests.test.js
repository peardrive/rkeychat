// A project asked of another device (docs/projects-home-and-sync.md §1), after the "Leaf Note" failure of
// 2026-11-19: the name comes from the signed record (never the viewed copy, whose `name` is the author); the
// answering room's app note carries the request id; a request stays pending until a room answers it; the owner
// closes a room with a signed control that only the owner's keys may write, and every holder drops it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chain, generate, consent, enroll } from 'rkey'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { SCOPES, makeControl } from '../src/proto.js'
import { requestOf, requestsFor, pendingProjectsOf, slug, REQUEST_TTL } from '../src/project-requests.js'

const core = { space: { list: async () => [] }, messages: { send: async () => {} } }

// A room owned here: root, this device (host), the owner "guy" (admin) on it, the owner's phone key under the
// root too, and "jeff", a member with his own account root (delegate) and a session key under it.
async function ownedRoom () {
  const root = generate('bip340'); const r = root.ref
  const device = generate('ed25519'); const phoneDev = generate('ed25519')
  const guy = generate('ed25519'); const phone = generate('ed25519')
  const jeffAccount = generate('bip340'); const jeff = generate('ed25519')
  const chain = await Chain.create(root, { label: 'root' })
  const add = async (by, o) => chain.append(await enroll(by, { root: r, ...o }), root)
  await add(root, { key: device.ref, consent: await consent(device, r), scope: ['bind', SCOPES.host], label: 'device:macbook' })
  await add(root, { key: phoneDev.ref, consent: await consent(phoneDev, r), scope: ['bind', SCOPES.host], label: 'device:phone' })
  await add(root, { key: guy.ref, consent: await consent(guy, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@macbook' })
  await add(root, { key: phone.ref, consent: await consent(phone, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@phone' })
  await add(root, { key: jeffAccount.ref, consent: await consent(jeffAccount, r), scope: ['bind', SCOPES.chat, SCOPES.admin, 'delegate'], label: 'jeff' })
  await add(jeffAccount, { key: jeff.ref, consent: await consent(jeff, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'jeff@laptop' })
  const dir = mkdtempSync(join(tmpdir(), 'rkc-preq-'))
  const store = new RoomStore(dir)
  store.writeJSON('chain.json', chain.toJSON())
  const room = new Room({ core, store, room: { name: 'carrier', topic: 'feedcafe', root: r }, device, root, participants: { guy: { signer: guy, role: 'human' }, jeff: { signer: jeff, role: 'human', account: jeffAccount } } })
  room.chain = new Chain(chain.toJSON())
  return { room, root: r, guy, phone, phoneDev, jeff, device, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('the request is read from the signed record: its name is the project, not the author', async () => {
  const { room, phone, device, done } = await ownedRoom()
  try {
    // the phone's request arrives as a record (signed there, carried here)
    const rec = await makeControl(phone, { room: room.topic, action: 'project', name: 'Leaf Note by Anjou', home: { device: device.ref, name: 'macbook' }, text: 'a notes app' })
    const seen = []
    room.on('record', (v) => seen.push(v))
    assert.equal(room.receive(rec), 'ok')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].name, 'guy', 'the viewed copy names the author')
    assert.equal(seen[0].device, 'phone')
    const req = requestOf(room.store.get(seen[0].id))
    assert.equal(req.name, 'Leaf Note by Anjou')
    assert.equal(req.text, 'a notes app')
    assert.equal(req.home.device, device.ref)
    assert.equal(requestOf(seen[0]).name, 'guy', 'which is exactly why the daemon must not read the viewed one')
    assert.deepEqual(room.projectRequests().map((r) => r.id), [rec.id])
    // what this device must act on: the ones naming it, not done, not in flight
    assert.deepEqual(requestsFor(room.projectRequests(), device.ref).map((r) => r.id), [rec.id])
    assert.deepEqual(requestsFor(room.projectRequests(), device.ref, { done: [rec.id] }), [])
    assert.deepEqual(requestsFor(room.projectRequests(), device.ref, { inflight: new Set([rec.id]) }), [])
    assert.deepEqual(requestsFor(room.projectRequests(), 'ed25519:someone-else'), [])
    assert.equal(slug('Leaf Note by Anjou'), 'leaf-note-by-anjou')
  } finally { done() }
})

test('the app note answers the request by id, and the wait ends on it', async () => {
  const { room, phone, device, done } = await ownedRoom()
  try {
    const rec = await makeControl(phone, { room: room.topic, action: 'project', name: 'Leaf Note', home: { device: device.ref, name: 'macbook' } })
    assert.equal(room.receive(rec), 'ok')
    const asked = (answered = []) => pendingProjectsOf([{ name: 'carrier', requests: room.projectRequests(), answered, devices: [{ ref: device.ref, name: 'macbook', online: true }] }], [phone.ref])
    assert.deepEqual(asked().map((p) => [p.name, p.asked, p.online, p.via]), [['Leaf Note', 'macbook', true, 'carrier']])
    assert.deepEqual(asked([rec.id]), [], 'a room whose note names the request answers it')
    // the macbook's own view: it wrote no request, so it waits on nothing
    assert.deepEqual(pendingProjectsOf([{ name: 'carrier', requests: room.projectRequests(), answered: [] }], ['ed25519:macbook-guy']), [])
    // a month-old request nobody answered is stale
    assert.deepEqual(pendingProjectsOf([{ name: 'carrier', requests: room.projectRequests(), answered: [] }], [phone.ref], rec.ts + REQUEST_TTL + 1), [])
    // the note carries `request`, and keeps it when a later note (an org move) leaves it out
    await room.setApp('guy', { role: 'project', title: 'Leaf Note', home: { device: device.ref, name: 'macbook' }, request: rec.id })
    assert.equal(room.appInfo().request, rec.id)
    await room.setApp('guy', { org: 'Anjou' })
    assert.equal(room.appInfo().request, rec.id); assert.equal(room.appInfo().org, 'Anjou')
  } finally { done() }
})

test('close: only the owner\'s keys end a room; every holder hears it', async () => {
  const { room, phone, jeff, done } = await ownedRoom()
  try {
    assert.equal(room.closed(), false)
    const byJeff = await makeControl(jeff, { room: room.topic, action: 'close' })
    assert.equal(room.receive(byJeff), 'scope', 'an admin member cannot close a room he does not own')
    assert.equal(room.closed(), false)
    const closed = []
    room.on('closed', (v) => closed.push(v))
    const byPhone = await makeControl(phone, { room: room.topic, action: 'close' })
    assert.equal(room.receive(byPhone), 'ok', 'the owner, from another of their devices')
    assert.equal(room.closed(), true)
    assert.equal(closed.length, 1); assert.equal(closed[0].name, 'guy'); assert.equal(closed[0].device, 'phone')
    // and from here, through the room's own method
    const { room: other, done: done2 } = await ownedRoom()
    try { const rec = await other.close('guy'); assert.equal(rec.action, 'close'); assert.equal(other.closed(), true) } finally { done2() }
  } finally { done() }
})
