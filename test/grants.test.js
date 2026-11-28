// Grants (Guy, 2026-11-27: permissions "approved by me safely but within the chat session"): places no agent reads
// whatever the rules say, read-only shell commands judged as the reads they are, the rule an ask offers as "Allow
// for this project", and grants as signed, owner-only records of the project's room.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chain, generate, consent, enroll } from 'rkey'
import { RoomStore } from '../src/store.js'
import { Room } from '../src/room.js'
import { SCOPES, makeControl } from '../src/proto.js'
import { judge, verdict } from '../src/acp.js'
import { resolveTools } from '../src/tools.js'
import { cleanGrantRule, describeRule, folderFor, grantFor, isForbidden, readOnlyCommand } from '../src/grants.js'

const H = homedir()
// a project in a folder beside others, one of them a business folder
const ROOT = mkdtempSync(join(tmpdir(), 'rkc-grants-'))
const DIR = join(ROOT, 'proj')
for (const d of ['proj/src', 'other', '_keys']) mkdirSync(join(ROOT, d), { recursive: true })
writeFileSync(join(ROOT, 'other', 'README.md'), 'hi')
writeFileSync(join(ROOT, '_keys', 'secret.txt'), 'no')
const lab = resolveTools('lab', DIR)
const none = { allow: [], deny: [] }
const bash = (command, rules = lab) => judge(rules, 'Bash', { command }, DIR)
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

test('keys, rKeyChat\'s config and business folders are never read, whatever the command', () => {
  assert.ok(isForbidden(join(H, '.ssh/id_ed25519')))
  assert.ok(isForbidden(join(H, '.rkeychat/config.json')))
  assert.ok(isForbidden(join(H, 'Anjou/_keys/x')))
  assert.ok(isForbidden(join(ROOT, '_keys/secret.txt'), DIR), 'a _ folder beside the project')
  assert.ok(!isForbidden(join(H, 'Anjou/pearkit/README.md')))
  // the lab preset allowed `cat` of anything: no longer of these
  assert.equal(verdict(lab, 'Bash', { command: 'cat ~/.ssh/id_ed25519' }, DIR), 'deny')
  assert.equal(verdict(lab, 'Bash', { command: 'head -5 $HOME/.rkeychat/config.json' }, DIR), 'deny')
  assert.equal(verdict(lab, 'Bash', { command: 'cat ../_keys/secret.txt' }, DIR), 'deny')
  assert.equal(verdict(lab, 'Bash', { command: 'git -C ~/.ssh log' }, DIR), 'deny', 'not a plain read, still never there')
  assert.equal(verdict(lab, 'Read', { file_path: join(H, '.ssh/config') }, DIR), 'deny')
  // a granted Read rule over home cannot open them either
  assert.equal(verdict({ allow: [`Read(/${H}/**)`], deny: [] }, 'Read', { file_path: join(H, '.ssh/config') }, DIR), 'deny')
})

test('a read-only command is the reads it makes: allowed inside the project and beside it, asked elsewhere', () => {
  assert.equal(bash('sed -n 1,20p src/x.js').verdict, 'allow')
  assert.equal(bash("grep -n 'a|b' src/x.js | head -3").verdict, 'allow', 'a | inside quotes is not a pipe')
  assert.equal(bash('head -3 ../other/README.md').verdict, 'allow', 'the folders beside the project')
  assert.equal(bash('for f in ../other/*.md; do head -3 $f; done').verdict, 'allow')
  const far = bash('sed -n 1,5p /usr/share/dict/words')
  assert.equal(far.verdict, 'ask')
  assert.deepEqual(far.unreadable, ['/usr/share/dict/words'])
  // the same commands, judged as reads even with no rule naming the program
  assert.equal(bash('wc -l src/x.js', none).verdict, 'allow')
  // what is not a read is not judged as one
  for (const c of ['sed -i s/a/b/ src/x.js', "sed 's/a/b/w out' src/x.js", 'find . -delete', 'sort -o out src/x', 'cat src/x > y', 'echo $(cat ~/.ssh/id)', 'cat src/x &']) {
    assert.equal(readOnlyCommand(c, DIR), null, c)
  }
  assert.equal(bash('echo $(cat ~/.ssh/id)').verdict, 'deny', 'not a read, and it names a key folder')
  assert.equal(bash('cat src/x 2>/dev/null').verdict, 'allow', 'throwing errors away is still a read')
})

test('a walk through a folder that holds a forbidden one asks, and offers no standing rule', () => {
  const j = bash('for f in ../*; do ls $f; done')
  assert.equal(j.verdict, 'ask')
  assert.ok(j.noAlways)
  assert.equal(bash('grep -rn token ~').noAlways, true)
  assert.equal(judge(lab, 'Grep', { pattern: 'x', path: H }, DIR).noAlways, true)
})

test('"Allow for this project" offers a folder for a read, a program for a command, never a shell or a delete', () => {
  const memo = join(H, 'rKeyChat/memo-by-anjou')
  const j = judge(resolveTools('lab', memo), 'Bash', { command: `sed -n 1,5p ${H}/Anjou/pearkit/src/a/b.ts` }, memo)
  assert.equal(j.verdict, 'ask')
  const g = grantFor('Bash', {}, memo, j)
  assert.equal(g.rule, `Read(/${H}/Anjou/pearkit/**)`, 'two levels under home, not the file\'s own folder')
  assert.equal(g.label, 'read anything in ~/Anjou/pearkit')
  assert.equal(grantFor('Read', { file_path: `${H}/Anjou/ORGANIZATION.md` }, memo).rule, `Read(/${H}/Anjou/**)`)
  assert.equal(grantFor('Bash', {}, DIR, bash('jq . a.json > b.json')).rule, 'Bash(jq:*)')
  assert.equal(grantFor('Bash', {}, DIR, bash('rm -rf dist')), null)
  assert.equal(grantFor('Bash', {}, DIR, bash('bash -c "ls"')), null)
  assert.equal(grantFor('WebFetch', { url: 'https://x' }, DIR).rule, 'WebFetch')
  assert.equal(folderFor(H), null, 'never home itself')
  assert.equal(folderFor(join(H, 'Anjou/_keys')), null)
  assert.equal(cleanGrantRule(`Read(/${H}/**)`), null)
  assert.equal(cleanGrantRule('Bash(rm:*)'), null)
  assert.equal(cleanGrantRule('Bash'), null)
  assert.equal(describeRule('Bash(jq:*)'), 'run jq commands')
})

async function ownedRoom () {
  const root = generate('bip340'); const r = root.ref
  const device = generate('ed25519'); const guy = generate('ed25519'); const pear = generate('ed25519')
  const jeffAccount = generate('bip340'); const jeff = generate('ed25519')
  const chain = await Chain.create(root, { label: 'root' })
  const add = async (by, o) => chain.append(await enroll(by, { root: r, ...o }), root)
  await add(root, { key: device.ref, consent: await consent(device, r), scope: ['bind', SCOPES.host], label: 'device:macbook' })
  await add(root, { key: guy.ref, consent: await consent(guy, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'guy@macbook' })
  await add(root, { key: pear.ref, consent: await consent(pear, r), scope: ['bind', SCOPES.chat, SCOPES.agent], label: 'pear@macbook' })
  await add(root, { key: jeffAccount.ref, consent: await consent(jeffAccount, r), scope: ['bind', SCOPES.chat, SCOPES.admin, 'delegate'], label: 'jeff' })
  await add(jeffAccount, { key: jeff.ref, consent: await consent(jeff, r), scope: ['bind', SCOPES.chat, SCOPES.admin], label: 'jeff@laptop' })
  const dir = mkdtempSync(join(tmpdir(), 'rkc-grants-room-'))
  const store = new RoomStore(dir)
  store.writeJSON('chain.json', chain.toJSON())
  const room = new Room({ core: { space: { list: async () => [] }, messages: { send: async () => {} } }, store, room: { name: 'test', topic: 'feedcafe', root: r }, device, root, participants: { guy: { signer: guy, role: 'human' }, pear: { signer: pear, role: 'agent' }, jeff: { signer: jeff, role: 'human', account: jeffAccount } } })
  room.chain = new Chain(chain.toJSON())
  return { room, jeff, done: () => { room.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('grants are signed records of the room: an ask answered "for this project", a folder added, a withdrawal; owner only', async () => {
  const { room, jeff, done } = await ownedRoom()
  try {
    const folder = join(H, 'Anjou/pearkit')
    const ask = await room.ask('pear', { conv: 'main', tool: 'Bash', what: 'sed', input: 'sed', rule: `Read(/${folder}/**)`, ruleLabel: 'read anything in ~/Anjou/pearkit', options: [] })
    assert.equal(ask.rule, `Read(/${folder}/**)`)
    await room.answer('guy', ask.id, 'allow_always')
    assert.deepEqual(room.grants().map((g) => [g.rule, g.from, g.by]), [[`Read(/${folder}/**)`, 'ask', 'guy']])
    // the grant now settles the same read without asking
    const rules = { allow: room.grants().map((g) => g.rule), deny: [] }
    assert.equal(verdict(rules, 'Bash', { command: `head ${folder}/README.md` }, DIR), 'allow')

    await room.grant('guy', 'Bash(jq:*)')
    assert.equal(room.grants().length, 2)
    await room.grant('guy', `Read(/${folder}/**)`, { revoke: true })
    assert.deepEqual(room.grants().map((g) => g.rule), ['Bash(jq:*)'])

    await assert.rejects(() => room.grant('guy', `Read(/${H}/.ssh/**)`), /cannot be granted/)
    await assert.rejects(() => room.grant('jeff', 'Bash(jq:*)'), /owner's own devices/)
    const forged = await makeControl(jeff, { room: room.topic, action: 'grant', rule: 'WebFetch' })
    assert.equal(room.receive(forged), 'scope', 'a member\'s grant is refused on arrival')
    // an ask answered only once grants nothing
    const once = await room.ask('pear', { conv: 'main', tool: 'WebFetch', what: 'x', rule: 'WebFetch', ruleLabel: 'use WebFetch' })
    await room.answer('guy', once.id, 'allow_once')
    assert.ok(!room.grants().some((g) => g.rule === 'WebFetch'))
  } finally { done() }
})
