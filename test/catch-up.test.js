// Guy, 2026-11-27: an agent's reply written while the phone was away never showed on the phone, although the phone
// had stored it. It came in a catch-up batch (hist-res) after iOS restarted the phone's backend; those records are
// stored quietly, and nothing told the open page to load its thread again. The room now says 'caught-up' after a
// batch that added something, and the server pushes 'resync' for it (the page reloads that room's threads).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chain, generate, consent, enroll } from 'rkey'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { SCOPES, envelope } from '../src/proto.js'

async function pair () {
  const root = generate('bip340'); const r = root.ref
  const mac = generate('ed25519'); const phone = generate('ed25519')
  const guy = generate('ed25519'); const pear = generate('ed25519')
  const chain = await Chain.create(root, { label: 'root' })
  const add = async (o) => chain.append(await enroll(root, { root: r, ...o }), root)
  await add({ key: mac.ref, consent: await consent(mac, r), scope: ['bind', SCOPES.host], label: 'device:mac' })
  await add({ key: phone.ref, consent: await consent(phone, r), scope: ['bind', SCOPES.host], label: 'device:phone' })
  await add({ key: guy.ref, consent: await consent(guy, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@phone' })
  await add({ key: pear.ref, consent: await consent(pear, r), scope: ['bind', SCOPES.chat, SCOPES.agent], label: 'pear@mac' })
  const dirs = []
  const make = (device, participants) => {
    const dir = mkdtempSync(join(tmpdir(), 'rkc-catchup-')); dirs.push(dir)
    const store = new RoomStore(dir)
    store.writeJSON('chain.json', chain.toJSON())
    const core = { emitter: new EventEmitter(), space: { list: async () => [] }, messages: { send: async () => {} }, managers: { message: {}, connection: {}, sockets: {} } }
    const room = new Room({ core, store, room: { name: 'memo', topic: 'feedcafe', root: r }, device, participants })
    room.chain = new Chain(chain.toJSON())
    return { room, core }
  }
  const mac$ = make(mac, { pear: { signer: pear, role: 'agent' } })
  const phone$ = make(phone, { guy: { signer: guy, role: 'human' } })
  return { mac: mac$, phone: phone$, phoneKey: phone, done: () => { mac$.room.stop(); phone$.room.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }) } }
}

test('records that come in a catch-up batch are stored and announced once as caught-up, not one by one', async () => {
  const { mac, phone, phoneKey, done } = await pair()
  try {
    await phone.room.start()
    // post() gives the page's view of a record; the signed record is the one in the store
    const asked = phone.room.store.get((await phone.room.post('guy', 'make a one-page app')).id)
    assert.equal(mac.room.receive(asked), 'ok')
    // the phone is away; the agent answers on the Mac
    const reply = mac.room.store.get((await mac.room.post('pear', 'I wrote a v0 spec', { re: [asked.id] })).id)

    const records = []; const caught = []
    phone.room.on('record', (r) => records.push(r))
    phone.room.on('caught-up', (e) => caught.push(e))
    const from = { topic: 'feedcafe', publicKey: phoneKey.ref.slice(8) }
    phone.core.emitter.emit('SpaceMessage', { message: from, content: envelope('hist-res', { records: [asked, reply] }) })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.ok(phone.room.store.has(reply.id), 'the reply is stored on the phone')
    assert.equal(records.length, 0, 'a catch-up batch wakes nobody record by record')
    assert.deepEqual(caught, [{ added: 1 }], 'one caught-up for the one record that was new')

    // the same batch again (the next anti-entropy round) adds nothing and says nothing
    phone.core.emitter.emit('SpaceMessage', { message: from, content: envelope('hist-res', { records: [asked, reply] }) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(caught.length, 1)
  } finally { done() }
})
