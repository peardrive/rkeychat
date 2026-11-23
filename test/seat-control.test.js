// A seat's settings travel as a 'seat' control (docs/project-agents.md "The bot's settings"): any of the owner's
// devices asks (account-gated, like 'answer'), the host applies and writes back how the seat now runs
// (`applied: true`), and a device that hosts nothing (a phone) reads the seats from those echoes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chain, generate, consent, enroll } from 'rkey'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { SCOPES, makeControl } from '../src/proto.js'

const core = { space: { list: async () => [] }, messages: { send: async () => {} } }

// root, the Mac (device + guy@macbook + the seat @pear), the phone (guy@phone, directly under root), and jeff, a
// team member who is admin through his own account
async function ownedRoom () {
  const root = generate('bip340'); const r = root.ref
  const device = generate('ed25519')
  const guy = generate('ed25519')
  const phone = generate('ed25519')
  const pear = generate('ed25519')
  const jeffAccount = generate('bip340'); const jeff = generate('ed25519')
  const chain = await Chain.create(root, { label: 'root' })
  const add = async (by, o) => chain.append(await enroll(by, { root: r, ...o }), root)
  await add(root, { key: device.ref, consent: await consent(device, r), scope: ['bind', SCOPES.host], label: 'device:macbook' })
  await add(root, { key: guy.ref, consent: await consent(guy, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@macbook' })
  await add(root, { key: phone.ref, consent: await consent(phone, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@phone' })
  await add(root, { key: pear.ref, consent: await consent(pear, r), scope: ['bind', SCOPES.chat, SCOPES.agent], label: 'pear@macbook' })
  await add(root, { key: jeffAccount.ref, consent: await consent(jeffAccount, r), scope: ['bind', SCOPES.chat, SCOPES.admin, 'delegate'], label: 'jeff' })
  await add(jeffAccount, { key: jeff.ref, consent: await consent(jeff, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'jeff@laptop' })
  const dir = mkdtempSync(join(tmpdir(), 'rkc-seat-'))
  const store = new RoomStore(dir)
  store.writeJSON('chain.json', chain.toJSON())
  const room = new Room({ core, store, room: { name: 'test', topic: 'feedcafe', root: r }, device, root, participants: { guy: { signer: guy, role: 'human' }, pear: { signer: pear, role: 'agent' } } })
  room.chain = new Chain(chain.toJSON())
  return { room, phone, jeff, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('the phone asks, the host hears it; jeff\'s signed request is refused; the host\'s echo is what the room reads', async () => {
  const { room, phone, jeff, done } = await ownedRoom()
  try {
    const heard = []
    room.on('seat', (rec) => heard.push(rec))
    assert.deepEqual(room.seatsFromLog(), [], 'nothing said yet')

    // the phone (one of the owner's devices) asks for Ask mode and Opus on PPQ
    const req = await makeControl(phone, { room: room.topic, action: 'seat', agent: 'pear', seat: { permissionMode: 'default', model: 'claude-opus-5-5', provider: 'ppq', applied: false } })
    assert.equal(room.receive(req), 'ok')
    assert.equal(heard.length, 1)
    assert.equal(heard[0].agent, 'pear')
    assert.deepEqual(heard[0].seat, { permissionMode: 'default', model: 'claude-opus-5-5', provider: 'ppq' }, 'the request as signed; `applied: false` is dropped, not kept')
    assert.deepEqual(room.seatsFromLog(), [], 'a request is not how the seat runs')

    // jeff is admin but not the owner: his request is refused on every device
    const forged = await makeControl(jeff, { room: room.topic, action: 'seat', agent: 'pear', seat: { permissionMode: 'auto' } })
    assert.equal(room.receive(forged), 'scope')
    assert.equal(heard.length, 1)

    // the host (guy@macbook, local) writes back how the seat now runs
    const echo = await room.control('guy', 'seat', { agent: 'pear', seat: { applied: true, permissionMode: 'default', model: 'claude-opus-5-5', provider: 'ppq', askMinutes: null, via: 'acp', dir: '/Users/guy/Anjou/peardrive', providers: [{ name: 'ppq', hasToken: true, token: 'never' }] } })
    assert.equal(echo.seat.applied, true)
    assert.ok(!JSON.stringify(echo).includes('never'), 'a provider row carries its name and whether a token is held, nothing else')
    const [seat] = room.seatsFromLog()
    assert.deepEqual({ ...seat, ts: undefined }, { name: 'pear', bridge: 'claude', via: 'acp', dir: '/Users/guy/Anjou/peardrive', permissionMode: 'default', auto: null, model: 'claude-opus-5-5', provider: 'ppq', askMinutes: null, providers: [{ name: 'ppq', hasToken: true }], remote: true, ts: undefined })

    // a newer echo wins; an older one arriving late does not
    const later = await room.control('guy', 'seat', { agent: 'pear', seat: { applied: true, permissionMode: 'plan', model: null, provider: null, via: 'acp', dir: '/Users/guy/Anjou/peardrive', providers: [] } })
    assert.equal(room.seatsFromLog()[0].permissionMode, 'plan')
    assert.equal(room.seatsFromLog()[0].model, null)
    const old = await makeControl(room.local.guy.signer, { room: room.topic, action: 'seat', agent: 'pear', seat: { applied: true, permissionMode: 'acceptEdits' }, ts: later.ts - 60_000 })
    assert.equal(room.receive(old), 'ok')
    assert.equal(room.seatsFromLog()[0].permissionMode, 'plan')

    // a seat control for an agent not in the room says nothing
    const ghost = await room.control('guy', 'seat', { agent: 'nobody', seat: { applied: true, permissionMode: 'auto' } })
    assert.ok(ghost)
    assert.equal(room.seatsFromLog().length, 1)
  } finally { done() }
})

test('Auto with a grant: the phone asks for 30 minutes and 5 turns; the room\'s cap (owner\'s keys only) is what the host clamps to; the echo carries the grant', async () => {
  const { room, phone, jeff, done } = await ownedRoom()
  try {
    const heard = []
    room.on('seat', (rec) => heard.push(rec))
    const req = await makeControl(phone, { room: room.topic, action: 'seat', agent: 'pear', seat: { permissionMode: 'auto', auto: { minutes: 30, turns: 5 } } })
    assert.equal(room.receive(req), 'ok')
    assert.deepEqual(heard[0].seat, { permissionMode: 'auto', auto: { minutes: 30, turns: 5 } })

    // the room's cap: jeff may not set one; the phone may; both empty lifts it
    assert.equal(room.autoCap(), null)
    const forged = await makeControl(jeff, { room: room.topic, action: 'auto', auto: { minutes: 1, turns: 1 } })
    assert.equal(room.receive(forged), 'scope')
    const cap = await makeControl(phone, { room: room.topic, action: 'auto', auto: { minutes: 20, turns: '' } })
    assert.equal(room.receive(cap), 'ok')
    assert.deepEqual(room.autoCap(), { minutes: 20, turns: null })
    const lift = await makeControl(phone, { room: room.topic, action: 'auto', auto: {} })
    assert.equal(room.receive(lift), 'ok')
    assert.equal(room.autoCap(), null)

    // the host's echo says since when, how many turns are used and where it goes back to
    await room.control('guy', 'seat', { agent: 'pear', seat: { applied: true, permissionMode: 'auto', auto: { since: 1000, minutes: 30, turns: 5, used: 2, back: 'acceptEdits' }, model: null, provider: null, via: 'acp', dir: '/x', providers: [] } })
    assert.deepEqual(room.seatsFromLog()[0].auto, { since: 1000, minutes: 30, turns: 5, used: 2, back: 'acceptEdits' })
    // out of Auto, the grant is gone
    await room.control('guy', 'seat', { agent: 'pear', seat: { applied: true, permissionMode: 'acceptEdits', auto: null, via: 'acp', dir: '/x', providers: [] } })
    assert.equal(room.seatsFromLog()[0].auto, null)
  } finally { done() }
})
