// An agent asks a person for a permission (docs/project-agents.md "Asking a person", Guy's memo of 2026-11-22):
// the ask is a signed record in the conversation; the answer is an account-gated control, so only the owner's
// own devices can give it (a team member who is admin cannot); the first answer wins; the runner waits on it; an
// ask lapses. And verdict(): what the tool list settles itself and what it asks about.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chain, generate, consent, enroll } from 'rkey'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { SCOPES, makeControl, ASK_CHOICES } from '../src/proto.js'
import { verdict } from '../src/acp.js'
import { resolveTools } from '../src/tools.js'

const core = { space: { list: async () => [] }, messages: { send: async () => {} } }

// A room owned here with its project seat: root, this device, guy (owner's human, admin), the seat @pear (agent),
// and jeff: a team member with his own account root (delegate) and a session key under it, admin in the room.
async function ownedRoom () {
  const root = generate('bip340'); const r = root.ref
  const device = generate('ed25519')
  const guy = generate('ed25519')
  const pear = generate('ed25519')
  const jeffAccount = generate('bip340'); const jeff = generate('ed25519')
  const chain = await Chain.create(root, { label: 'root' })
  const add = async (by, o) => chain.append(await enroll(by, { root: r, ...o }), root)
  await add(root, { key: device.ref, consent: await consent(device, r), scope: ['bind', SCOPES.host], label: 'device:macbook' })
  await add(root, { key: guy.ref, consent: await consent(guy, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@macbook' })
  await add(root, { key: pear.ref, consent: await consent(pear, r), scope: ['bind', SCOPES.chat, SCOPES.agent], label: 'pear@macbook' })
  await add(root, { key: jeffAccount.ref, consent: await consent(jeffAccount, r), scope: ['bind', SCOPES.chat, SCOPES.admin, 'delegate'], label: 'jeff' })
  await add(jeffAccount, { key: jeff.ref, consent: await consent(jeff, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'jeff@laptop' })
  const dir = mkdtempSync(join(tmpdir(), 'rkc-asks-'))
  const store = new RoomStore(dir)
  store.writeJSON('chain.json', chain.toJSON())
  const room = new Room({ core, store, room: { name: 'test', topic: 'feedcafe', root: r }, device, root, participants: { guy: { signer: guy, role: 'human' }, pear: { signer: pear, role: 'agent' }, jeff: { signer: jeff, role: 'human', account: jeffAccount } } })
  room.chain = new Chain(chain.toJSON())
  return { room, root: r, guy, jeff, pear, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('an ask is a signed record in the conversation; only the owner\'s own keys answer it; the first answer wins', async () => {
  const { room, jeff, done } = await ownedRoom()
  try {
    const ask = await room.ask('pear', { conv: 'main', tool: 'Bash', what: 'npm run release', input: 'npm run release', options: [{ id: 'o1', kind: 'allow_once' }, { id: 'o2', kind: 'allow_always' }, { id: 'o3', kind: 'reject_once' }] })
    assert.equal(ask.kind, 'ask')
    assert.equal(room.view(ask).name, 'pear')
    assert.equal(room.openAsks().length, 1)
    assert.equal(room.openAsks('main')[0].id, ask.id)
    assert.equal(room.openAsks('other').length, 0)
    assert.ok(ask.expires > Date.now() + 9 * 60_000, 'lapses in ten minutes by default')
    // no answer yet; a person is still waiting
    assert.equal(room.answerOf(ask.id), null)

    // jeff is admin in the room but not the owner: refused here, and his signed control is refused on arrival
    await assert.rejects(() => room.answer('jeff', ask.id, 'allow_once'), /owner's own devices/)
    const forged = await makeControl(jeff, { room: room.topic, action: 'answer', ask: ask.id, choice: 'allow_once' })
    assert.equal(room.receive(forged), 'scope')
    assert.equal(room.answerOf(ask.id), null)

    // a bad choice, a made-up ask
    await assert.rejects(() => room.answer('guy', ask.id, 'yes'), /choice must be/)
    await assert.rejects(() => room.answer('guy', 'nope', 'allow_once'), /no such ask/)

    // the owner answers; the runner, waiting, hears it
    const waited = room.awaitAnswer(ask.id, 5000)
    const a = await room.answer('guy', ask.id, 'allow_always')
    assert.equal(a.action, 'answer'); assert.equal(a.ask, ask.id); assert.equal(a.choice, 'allow_always')
    const heard = await waited
    assert.equal(heard.choice, 'allow_always'); assert.equal(heard.name, 'guy'); assert.equal(heard.device, 'macbook')
    assert.equal(room.openAsks().length, 0, 'answered: no longer open')
    assert.deepEqual(room.answerOf(ask.id).choice, 'allow_always')
    // a second answer is refused locally; one arriving from a peer does not change the first
    await assert.rejects(() => room.answer('guy', ask.id, 'reject_once'), /already answered/)
    assert.equal(room.answerOf(ask.id).choice, 'allow_always')
    // and the answer is already there for anyone who asks later
    assert.equal((await room.awaitAnswer(ask.id, 10)).choice, 'allow_always')
  } finally { done() }
})

test('an ask that nobody answers lapses; the wait ends with null', async () => {
  const { room, done } = await ownedRoom()
  try {
    const ask = await room.ask('pear', { conv: 'main', tool: 'WebFetch', what: 'https://example.com', expires: Date.now() + 50 })
    assert.equal(room.openAsks().length, 1)
    assert.equal(await room.awaitAnswer(ask.id, 30), null)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(room.openAsks().length, 0, 'lapsed')
    // a human cannot ask; an answer must name a real ask and a known choice (also on arrival)
    assert.equal(await room.ask('guy', { tool: 'Bash', what: 'x' }), null)
    assert.deepEqual(ASK_CHOICES, ['allow_once', 'allow_always', 'reject_once', 'reject_always'])
  } finally { done() }
})

test('verdict: the tool list allows, denies, or leaves it to a person', () => {
  const DIR = '/Users/me/Anjou/rKeyChat'
  const lab = resolveTools('lab', DIR)
  assert.equal(verdict(lab, 'Bash', { command: 'git status' }, DIR), 'allow')
  assert.equal(verdict(lab, 'Bash', { command: 'brew install jq' }, DIR), 'ask', 'not in the list: a person decides')
  assert.equal(verdict(lab, 'Bash', { command: 'git status && brew install jq' }, DIR), 'ask', 'one part unsettled: ask')
  assert.equal(verdict(lab, 'Bash', { command: '' }, DIR), 'deny')
  assert.equal(verdict(lab, 'Read', { file_path: '/Users/me/Anjou/_keys/apple.p8' }, DIR), 'deny', 'a deny rule is final; nobody is asked')
  assert.equal(verdict(lab, 'WebFetch', { url: 'https://example.com' }, DIR), 'ask')
  assert.equal(verdict(lab, '', {}, DIR), 'deny')
  const few = resolveTools(['Bash(git:*)', 'Read'], '/Users/me/Anjou/x')
  assert.equal(verdict(few, 'Edit', { file_path: '/Users/me/Anjou/x/a.js' }), 'ask')
})
