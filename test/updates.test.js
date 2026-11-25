// In-app updates (2026-11-25): what the running copy says about itself, release records signed with a device key and
// verified with rkey, a local deliveries folder as the channel, the installer checked against its record before it is
// handed over, and the daemon's part when there is no desktop app to swap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { generate } from 'rkey'
import { APP_ID, buildInfo, runningInfo, versionInfo } from '../src/version.js'
import { Updates, readRecords, checkInstaller, publisherRef, loadKit, DEFAULT_CHANNEL } from '../src/updates.js'

const kit = await loadKit()
const sha = (s) => createHash('sha256').update(s).digest('hex')

test('the running copy: package.json version, a source tree without a ship says build null, the ledger entry is rkeychat-desktop', () => {
  const r = runningInfo()
  assert.equal(r.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(r.source, true)
  assert.equal(APP_ID, 'rkeychat-desktop')
  const dir = mkdtempSync(join(tmpdir(), 'rkc-ver-'))
  mkdirSync(join(dir, 'src'))
  assert.deepEqual(buildInfo(dir), { build: null, commit: null })
  writeFileSync(join(dir, 'src', 'build.json'), JSON.stringify({ build: '2026-11-25.3', commit: 'abc1234' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.3.1' }))
  const info = runningInfo(dir)
  assert.equal(info.build, '2026-11-25.3'); assert.equal(info.commit, 'abc1234'); assert.equal(info.version, '0.3.1'); assert.equal(info.from, dir)
  assert.equal(typeof versionInfo(dir).behind, 'boolean')
  rmSync(dir, { recursive: true, force: true })
})

// a device, as the daemon has one: { ref: 'ed25519:<hex>', sign(bytes) }
const device = () => { const k = generate('ed25519'); return { ref: k.ref, sign: (m) => k.sign(m) } }
const record = (over = {}) => ({ app: 'rkeychat-desktop', channel: 'release', version: '0.3.1', build: '2026-11-25.1', commit: 'abc1234', os: 'mac', arch: 'arm64', ext: 'zip', file: 'rkeychat-desktop-0.3.1-mac-arm64.zip', size: 5, sha256: sha('hello'), notes: 'n', publishedAt: '2026-11-25T20:00:00.000Z', ...over })

function fakeApp (dev = device()) {
  const app = new EventEmitter()
  app.device = dev
  app.core = null
  return app
}

test('a record signed by the device verifies with rkey under the channel publisher, and under nobody else', async () => {
  const dev = device()
  const u = new Updates(fakeApp(dev), { kit })
  const signed = await u.record(record())
  assert.equal(signed.publisher, dev.ref)
  assert.match(signed.sig, /^[0-9a-f]{128}$/)
  process.env.RKEYCHAT_DATA = mkdtempSync(join(tmpdir(), 'rkc-upd-'))
  u.save({ publisher: dev.ref })
  assert.equal(await u.verify(signed), true)
  assert.equal(await u.verify({ ...signed, notes: 'changed' }), false)
  u.save({ publisher: device().ref })
  assert.equal(await u.verify(signed), false, 'another publisher: not ours')
  assert.equal(publisherRef(dev.ref.slice(8).toUpperCase()), dev.ref)
  assert.equal(publisherRef('nope'), null)
  rmSync(process.env.RKEYCHAT_DATA, { recursive: true, force: true })
})

test('a deliveries folder is a channel: records read, the stranger dropped, the installer checked against its record before it is handed over', async () => {
  const data = mkdtempSync(join(tmpdir(), 'rkc-upd-'))
  process.env.RKEYCHAT_DATA = data
  const folder = mkdtempSync(join(tmpdir(), 'rkc-deliv-'))
  const dev = device()
  const app = fakeApp(dev)
  const u = new Updates(app, { kit })
  // what a ship + release leave in the folder: two of ours, one the wrong size, one from a stranger
  writeFileSync(join(folder, 'rkeychat-desktop-0.3.1-mac-arm64.zip'), 'hello')
  writeFileSync(join(folder, 'rkeychat-desktop-0.3.2-mac-arm64.zip'), 'hello2')
  writeFileSync(join(folder, 'rkeychat-desktop-0.3.3-mac-arm64.zip'), 'short!')
  writeFileSync(join(folder, 'rkeychat-desktop-9.9.9-mac-arm64.zip'), 'evil!')
  const put = async (r, who = u) => writeFileSync(join(folder, `${r.file}.release.json`), JSON.stringify(await who.record(r)))
  await put(record())
  await put(record({ version: '0.3.2', build: '2026-11-25.2', file: 'rkeychat-desktop-0.3.2-mac-arm64.zip', size: 6, sha256: sha('hello2') }))
  await put(record({ version: '0.3.3', build: '2026-11-25.3', file: 'rkeychat-desktop-0.3.3-mac-arm64.zip', size: 6, sha256: sha('wrong!') }))
  await put(record({ version: '9.9.9', build: '2026-11-25.9', file: 'rkeychat-desktop-9.9.9-mac-arm64.zip', size: 5, sha256: sha('evil!') }), new Updates(fakeApp(), { kit }))
  assert.equal(readRecords(folder).length, 4)
  await assert.rejects(checkInstaller(join(folder, 'rkeychat-desktop-0.3.3-mac-arm64.zip'), record({ size: 6, sha256: sha('wrong!') })), /does not hash/)

  // the daemon in a terminal, on a Mac, reading that folder
  u.kit = kit
  u.channel = u.makeChannel({ running: { version: '0.3.0', build: '2026-11-24.1' }, platform: { os: 'mac', arch: 'arm64' } })
  u.save({ folder, publisher: dev.ref })
  await u.attach()
  const s = await u.check()
  assert.equal(s.status, 'available')
  assert.deepEqual(s.pending.map((p) => p.version), ['0.3.3', '0.3.2', '0.3.1'])
  assert.equal(s.rejected, 1, "the stranger's 9.9.9 is dropped")
  assert.equal(s.channel.folder, folder)
  assert.equal(s.channel.publisherIsMe, true)
  assert.equal(s.appName, 'rKeyChat')
  // 0.3.3's bytes are not what its record says: never handed over
  await assert.rejects(u.install(), /does not hash/)
  assert.equal(u.state().job.state, 'error')
  // 0.3.2 is sound, but a terminal daemon has no app to swap: it says where the file is
  const second = s.pending.find((p) => p.version === '0.3.2')
  await assert.rejects(u.install(second.id), /needs the desktop app/)
  // with a desktop app listening, the file is handed over
  const handed = []
  app.on('update-install', ({ path, version, resolve }) => { handed.push([path, version]); resolve() })
  await u.install(second.id)
  assert.deepEqual(handed, [[join(folder, 'rkeychat-desktop-0.3.2-mac-arm64.zip'), '0.3.2']])
  // a build that did not start here is remembered and not offered again
  u.noteFailedStart({ version: '0.3.3', reason: 'better-sqlite3 did not load' })
  assert.deepEqual((await u.check()).pending.map((p) => p.version), ['0.3.2', '0.3.1'])
  assert.equal(u.state().refused.version, '0.3.3')
  // back to the default channel: no link baked yet means no channel
  const r = await u.setChannel({ reset: true })
  assert.equal(r.channel.isDefault, true)
  assert.equal(r.status, DEFAULT_CHANNEL.link ? 'connecting' : 'no-channel')
  rmSync(folder, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true })
})
