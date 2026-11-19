// Who may become whom, and who may say what: approve() after the 2026-11-15 audit (H1: a room invite may not
// take the owner's name; a device rolls only the names it holds), and the account gate on project controls
// (docs/projects-home-and-sync.md §4). A real rKey chain, a fake core that sends nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chain, generate, consent, enroll } from 'rkey'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { SCOPES } from '../src/proto.js'

const core = { space: { list: async () => [] }, messages: { send: async () => {} } }

// A room owned here: root (bip340), this device (ed25519, host), the owner "guy" (admin), and "jeff", a member
// with his own account root (delegate) and a session key under it, as approve() enrols other people.
async function ownedRoom () {
  const root = generate('bip340'); const r = root.ref
  const device = generate('ed25519')
  const guy = generate('ed25519')
  const jeffAccount = generate('bip340'); const jeff = generate('ed25519')
  const chain = await Chain.create(root, { label: 'root' })
  const add = async (by, o) => chain.append(await enroll(by, { root: r, ...o }), root)
  await add(root, { key: device.ref, consent: await consent(device, r), scope: ['bind', SCOPES.host], label: 'device:macbook' })
  await add(root, { key: guy.ref, consent: await consent(guy, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@macbook' })
  await add(root, { key: jeffAccount.ref, consent: await consent(jeffAccount, r), scope: ['bind', SCOPES.chat, SCOPES.admin, 'delegate'], label: 'jeff' })
  await add(jeffAccount, { key: jeff.ref, consent: await consent(jeff, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'jeff@laptop' })
  const dir = mkdtempSync(join(tmpdir(), 'rkc-approve-'))
  const store = new RoomStore(dir)
  store.writeJSON('chain.json', chain.toJSON())
  const room = new Room({ core, store, room: { name: 'test', topic: 'feedcafe', root: r }, device, root, participants: { guy: { signer: guy, role: 'human' }, jeff: { signer: jeff, role: 'human', account: jeffAccount } } })
  room.chain = new Chain(chain.toJSON())
  return { room, root: r, guy, jeff, jeffAccount, device, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

// what a stranger's daemon would send: a new device and a human named like the owner
async function strangerAsking (r, name = 'guy') {
  const dev = generate('ed25519'); const key = generate('ed25519')
  return { device: { ref: dev.ref, name: 'stranger-laptop', consent: await consent(dev, r) }, participants: [{ ref: key.ref, name, role: 'human', consent: await consent(key, r) }], key }
}

test('H1: a room invite cannot take the owner\'s name; the login code can', async () => {
  const { room, root, done } = await ownedRoom()
  try {
    const req = await strangerAsking(root)
    await assert.rejects(() => room.approve(req), /name already in use: guy/)
    assert.equal(room.state.get(req.key.ref), undefined, 'nothing was enrolled')
    // the owner's own phone, through the login handover, is the owner
    const phone = await strangerAsking(root)
    const n = await room.approve(phone, { asOwner: true })
    assert.ok(n >= 2)
    const m = room.members().find((x) => x.ref === phone.key.ref)
    assert.equal(m.name, 'guy'); assert.equal(m.device, 'stranger-laptop'); assert.ok(m.scope.includes(SCOPES.admin))
  } finally { done() }
})

test('H1: an enrolled device rolls only the names it already holds', async () => {
  const { room, root, done } = await ownedRoom()
  try {
    const bob = generate('ed25519'); const dev = generate('ed25519')
    const first = { device: { ref: dev.ref, name: 'bobs-pc', consent: await consent(dev, root) }, participants: [{ ref: bob.ref, name: 'bob', role: 'human', consent: await consent(bob, root) }] }
    await room.approve(first)
    assert.equal(room.members().find((x) => x.ref === bob.ref)?.name, 'bob')
    // bob's device asks again with a fresh key as bob: fine (rolling); as guy: refused
    const bob2 = generate('ed25519')
    await room.approve({ device: first.device, participants: [{ ref: bob2.ref, name: 'bob', role: 'human', consent: await consent(bob2, root) }] })
    const asGuy = generate('ed25519'); const guyConsent = await consent(asGuy, root)
    await assert.rejects(() => room.approve({ device: first.device, participants: [{ ref: asGuy.ref, name: 'guy', role: 'human', consent: guyConsent }] }), /name already in use: guy/)
    const asJeff = generate('ed25519'); const jeffConsent = await consent(asJeff, root)
    await assert.rejects(() => room.approve({ device: first.device, participants: [{ ref: asJeff.ref, name: 'jeff', role: 'human', consent: jeffConsent }] }), /name already in use: jeff/)
  } finally { done() }
})

test('account gate: only the owner\'s own keys write project controls; admins keep the rest', async () => {
  const { room, root, guy, jeff, jeffAccount, device, done } = await ownedRoom()
  try {
    assert.equal(room.isOwnerKey(root), true)
    assert.equal(room.isOwnerKey(guy.ref), true, 'the owner\'s device key, enrolled directly under the root')
    assert.equal(room.isOwnerKey(jeffAccount.ref), false, 'another account\'s root, even though it hangs under ours with delegate')
    assert.equal(room.isOwnerKey(jeff.ref), false)
    assert.equal(room.isOwnerKey(device.ref), false, 'a device key is not a person')
    // jeff is an admin: he may set the charter, but not ask a device to make a project
    await room.control('jeff', 'charter', { text: 'hello' })
    assert.equal(room.charter().text, 'hello')
    await assert.rejects(() => room.control('jeff', 'project', { name: 'Evil', home: { device: device.ref, name: 'macbook' } }), /rejected/)
    const rec = await room.requestProject('guy', { title: 'Mine', home: { device: device.ref, name: 'macbook' } })
    assert.equal(rec.action, 'project'); assert.equal(rec.home.device, device.ref); assert.equal(rec.name, 'Mine')
    // the app note carries the home; this device is it
    await room.setApp('guy', { role: 'project', title: 'Mine', home: { device: device.ref, name: 'macbook' } })
    assert.deepEqual(room.home(), { device: device.ref, name: 'macbook' })
    assert.equal(room.isHome, true)
    assert.deepEqual(room.ownDevices().map((d) => [d.name, d.here]), [['macbook', true]])
  } finally { done() }
})
