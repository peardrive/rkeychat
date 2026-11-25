// Updates — a newer rKeyChat reaches this computer through a Space, and one press puts it in place (Guy, 2026-11-25:
// "one main .dmg app in my Applications folder which we can continue to sign and update, one location, one main
// way to launch it"). The logic is pearkit's (`pearkit/updates`: the release record of ~/Anjou/_deliveries/AGENTS.md
// and the UpdateChannel), the same module PearDrive's updater grew into; this file is what rKeyChat adds:
//
//   the CHANNEL   a pearcore Space that mirrors ~/Anjou/_deliveries/rkeychat-desktop/ (its link and the publisher's
//                 device key are baked in below, DEFAULT_CHANNEL; Settings can point at another, or at a local folder
//                 such as the PearDrive-synced deliveries folder itself). The Space holds the installers and, beside
//                 each, its `.release.json`, signed by the publisher's device key. A record from any other key is
//                 dropped, however it is worded.
//   READING       every `*.release.json` the Space lists is fetched (they are tiny), verified with rkey's ed25519 over
//                 the record's canonical JSON, and handed to the channel; the installer is fetched only when asked,
//                 then checked against the record's sha256 before anything else happens to it.
//   INSTALLING    the desktop app listens for 'update-install' on the App (electron/main.js) and runs pearkit's
//                 installUpdate: the new build is asked to load its native modules, the running bundle is kept under
//                 ~/.rkeychat/updates/previous.noindex/ (out of Spotlight's sight), the new one takes its place and
//                 opens. From a terminal daemon there is no app to swap: install() says where the file is.
//   PUBLISHING    on the publisher's Mac, `scripts/release.mjs` asks this daemon to sign each record
//                 (POST /api/updates/record, with this device's key) and to register the folder's files in the Space
//                 (POST /api/updates/publish). At start, a publisher registers the folder again, so a Mac that was off
//                 serves what it holds.
//
// A phone runs no desktop build: on Bare this module is a stub that says so.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { verifySig } from 'rkey'
import { dataDir } from './config.js'
import { loadSettings, saveSettings } from './glossary.js'
import { runningInfo, APP_ID, APP_NAME } from './version.js'
import { writeManifest } from './app-space.js'
import { addFileOnce } from './debug-notes.js'

/** The channel every build starts on: rKeyChat's own deliveries folder as a Space, published by Guy's Mac. Filled in
 *  when the Space was made (scripts/release.mjs → POST /api/updates/publish prints both); a copy on another channel
 *  changes them in Settings › Updates › Advanced. */
export const DEFAULT_CHANNEL = Object.freeze({
  name: APP_NAME,
  // the Space made on 2026-11-25 by `POST /api/updates/publish` on Guy's MacBook for ~/Anjou/_deliveries/rkeychat-desktop
  link: 'pearcore://GPBeywxrVHxmpDAsgdjui5Tt8KoU44jccnTAkvNoA8sWj7RTaGauspenCvtVR1QGsM9YekTGwWJ9ZVjfknr9AaRZkjgzsXK4rMAnNnYNhrcCg6tbDVadNMCEV1tMgUGgB2t3YHpz9jo1pXCPXKWaEA',
  // the MacBook's device key: the only key whose records count (the offline release key replaces it here one day)
  publisher: 'ed25519:8b3d42af0e97e9d7f054af4ab04e1f5981f10d9c7fa7d632f499b957b6c1cd7e'
})

export const SPACE_NAME = APP_ID // the Space is named after the folder it mirrors
const onPhone = typeof Bare !== 'undefined'
const FILE_WAIT = 20 * 60_000 // an installer is 400 MB
const RECORD_WAIT = 60_000 // a record is 1 KB: a minute means nobody is serving it
const KIT = 'pearkit/updates' // a computed specifier: the phone bundle never resolves it (desktop only)
export const loadKit = () => import(KIT)

const HEX64 = /^[0-9a-f]{64}$/
export const publisherRef = (p) => { const h = String(p || '').replace(/^ed25519:/, '').toLowerCase(); return HEX64.test(h) ? `ed25519:${h}` : null }

/** Every record in a folder (the deliveries folder, or a Space's copy of it), parsed; files that are not JSON are skipped. */
export function readRecords (dir) {
  if (!dir || !existsSync(dir)) return []
  const out = []
  for (const n of readdirSync(dir)) {
    if (!n.endsWith('.release.json')) continue
    try { out.push(JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch {}
  }
  return out
}

/** sha256 of a file, streamed (an installer is hundreds of MB). */
export function sha256File (file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/** Throws unless `file` has the bytes `record` names (size first, then the hash). */
export async function checkInstaller (file, record) {
  if (!existsSync(file)) throw new Error(`${basename(file)} is not here`)
  const size = statSync(file).size
  if (size !== record.size) throw new Error(`${basename(file)} is ${size} bytes, the release record says ${record.size}`)
  const sum = await sha256File(file)
  if (sum !== record.sha256) throw new Error(`${basename(file)} does not hash to what its release record says: not installed`)
  return true
}

export class Updates extends EventEmitter {
  constructor (app, { kit = null } = {}) {
    super()
    this.app = app
    this.kit = kit
    this.channel = null
    this.space = null
    this.dir = join(dataDir(), 'updates')
    this.timer = null
    this.attaching = null
  }

  /** The channel this copy reads, from settings.json over the baked-in default. */
  get cfg () {
    const s = loadSettings().updates ?? {}
    return { link: DEFAULT_CHANNEL.link, publisher: DEFAULT_CHANNEL.publisher, name: DEFAULT_CHANNEL.name, folder: null, publishFolder: null, publishTopic: null, ...s }
  }

  save (patch) { saveSettings({ updates: { ...this.cfg, ...patch } }) }

  /** rkey verifies the publisher's ed25519 signature over the record's canonical bytes. */
  verify = (record) => this.kit.verifyRelease(record, (bytes, sigHex, keyHex) => verifySig(`ed25519:${keyHex}`, sigHex, bytes), this.cfg.publisher || undefined)

  async start () {
    if (onPhone) return
    this.kit ??= await loadKit()
    mkdirSync(this.dir, { recursive: true })
    this.channel = this.makeChannel()
    await this.attach().catch((err) => console.error('[updates] channel:', err.message))
    if (this.cfg.publishFolder) this.registerFolder().catch((err) => console.error('[updates] registering the deliveries folder:', err.message))
    this.timer = setInterval(() => this.check().catch(() => {}), 10 * 60_000)
    this.timer.unref?.()
    this.check().catch(() => {})
  }

  /** The pearkit channel for this copy (tests pass another running version or platform). */
  makeChannel ({ running = runningInfo(), platform = this.kit.hostPlatform() } = {}) {
    return new this.kit.UpdateChannel({
      app: APP_ID,
      running,
      platform,
      source: null,
      install: (file, record) => this.installHook(file, record),
      onChange: (s) => this.emit('change', s),
      refused: () => this.#failedStart(),
      refuse: (version, reason) => this.noteFailedStart({ version, reason, refused: true })
    })
  }

  stop () { clearInterval(this.timer); this.timer = null }

  /** Point the channel at what the settings say: a local folder first (a machine with the deliveries folder synced), else the Space. */
  async attach () {
    if (this.attaching) return this.attaching
    this.attaching = (async () => {
      const cfg = this.cfg
      let source = null
      if (cfg.folder) source = this.#folderSource(cfg.folder)
      // the publisher reads the folder it publishes: its own Space lists its own files, and fetching them from
      // itself waits for ever (2026-11-25, the first check on the publishing Mac hung on its own record)
      else if (cfg.publishFolder && existsSync(cfg.publishFolder) && publisherRef(cfg.publisher) === this.app.device.ref) source = this.#folderSource(cfg.publishFolder)
      else if (cfg.link && cfg.publisher) source = await this.#spaceSource(cfg.link)
      this.channel.setSource(source)
      return source
    })().finally(() => { this.attaching = null })
    return this.attaching
  }

  // ── sources ───────────────────────────────────────────────────────────────────────────────────────────────────
  #describe (where) { const c = this.cfg; return { name: c.name || DEFAULT_CHANNEL.name, publisher: c.publisher || '', link: where } }

  // a folder on this disk (the PearDrive-synced ~/Anjou/_deliveries/rkeychat-desktop on an agent box)
  #folderSource (dir) {
    return {
      records: async () => readRecords(dir),
      verify: this.verify,
      fetch: async (record) => { const f = join(dir, record.file); await checkInstaller(f, record); return f },
      describe: () => this.#describe(dir)
    }
  }

  // the channel Space: joined once, listed on every sync, records fetched as they appear
  async #spaceSource (link) {
    const core = this.app.core
    const spaces = await core.space.list()
    let space = spaces.find((s) => s.sharelink === link)
    if (!space) {
      console.log('[updates] joining the update channel')
      space = await core.space.join(link)
    }
    this.space = space
    return {
      records: () => this.#spaceRecords(space),
      verify: this.verify,
      fetch: (record, onProgress) => this.#spaceFetch(space, record, onProgress),
      describe: () => this.#describe(link)
    }
  }

  #listing (topic) { return Object.entries(this.app.core.managers.spaceFileList.get(topic) ?? {}) }
  #peersOn (topic) { try { return this.app.core.managers.sockets.getConnectedSockets({ topics: [topic] }).length } catch { return 0 } }
  // the newest variant of a path, by its providers' timestamps
  static newestRoot (variants) {
    const newest = (v) => Math.max(0, ...Object.values(v?.peers ?? {}).map((p) => Number(p.timestamp) || 0))
    return Object.entries(variants ?? {}).sort((a, b) => newest(b[1]) - newest(a[1]))[0]?.[0] ?? null
  }

  async #spaceRecords (space) {
    const dir = join(this.dir, 'records'); mkdirSync(dir, { recursive: true })
    const out = []
    for (const [path, variants] of this.#listing(space.topicHash)) {
      const name = path.replace(/^\//, '')
      if (name.includes('/') || !name.endsWith('.release.json')) continue
      const root = Updates.newestRoot(variants)
      if (!root) continue
      const dest = join(dir, `${root}.json`) // one copy per content hash: a record never changes under its name
      if (!existsSync(dest)) {
        if (!this.#peersOn(space.topicHash)) continue // nobody to fetch it from right now: next check
        try { await this.#download(space, path, root, dest, null, RECORD_WAIT) } catch (err) { console.error(`[updates] ${name}: ${err.message}`); continue }
      }
      try { out.push(JSON.parse(readFileSync(dest, 'utf8'))) } catch {}
    }
    return out
  }

  async #spaceFetch (space, record, onProgress) {
    const dir = join(this.dir, 'downloads'); mkdirSync(dir, { recursive: true })
    const dest = join(dir, record.file)
    if (existsSync(dest)) { try { await checkInstaller(dest, record); return dest } catch {} }
    const path = `/${record.file}`
    const variants = this.#listing(space.topicHash).find(([p]) => p === path)?.[1]
    const root = Updates.newestRoot(variants)
    if (!root) throw new Error(`${record.file} is not in the channel Space yet (${this.#peersOn(space.topicHash)} of its peers connected)`)
    await this.#download(space, path, root, dest, onProgress)
    await checkInstaller(dest, record)
    return dest
  }

  // one file out of the Space, with pearcore's refusal and silence handled the way debug-notes.js handles them
  async #download (space, path, root, dest, onProgress = null, wait = FILE_WAIT) {
    const topic = space.topicHash
    const entry = await this.app.core.drives.get(space).getFile(path)
    const task = await entry.download(root, dest)
    try {
      await new Promise((resolve, reject) => {
        let done = false
        const finish = (fn) => { if (done) return; done = true; clearInterval(tick); clearTimeout(t); fn() }
        const t = setTimeout(() => finish(() => reject(new Error(`timed out fetching ${basename(path)} after ${Math.round(wait / 1000)}s (${this.#peersOn(topic)} of its peers connected). Is the publisher's rKeyChat open?`))), wait); t.unref?.()
        const tick = setInterval(() => {
          if (!onProgress) return
          try { const p = task.getProgress?.(); if (p && typeof p.percent === 'number') onProgress(p.percent, 100) } catch {}
        }, 500); tick.unref?.()
        task.onComplete(() => finish(resolve)); task.onError?.((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
      })
    } catch (err) {
      try { await task.stop?.() } catch {}
      try { const m = this.app.core.managers.spaceFiles?.downloadTasks; if (m) for (const [k, v] of m) if (v === task) m.delete(k) } catch {}
      throw err
    }
    onProgress?.(100, 100)
    return dest
  }

  // ── installing ────────────────────────────────────────────────────────────────────────────────────────────────
  // The desktop app (electron/main.js) listens on the App for 'update-install' and does the swap; it resolves once
  // the helper runs (and quits), rejects with what went wrong (an `unfit` build among them).
  async installHook (file, record) {
    if (!this.app.listenerCount('update-install')) throw new Error(`the new version is at ${file}; installing it needs the desktop app (this daemon runs in a terminal)`)
    await new Promise((resolve, reject) => this.app.emit('update-install', { path: file, version: record.version, id: record.sha256, resolve, reject }))
  }

  // A build that was installed here and whose daemon did not start (electron/main.js writes it before going back),
  // or one that was fetched and did not load (`refused`): the channel does not offer that version again.
  #failedFile () { return join(this.dir, 'failed-start.json') }
  #failedStart () { try { const f = JSON.parse(readFileSync(this.#failedFile(), 'utf8')); return f?.version ? f : null } catch { return null } }
  noteFailedStart ({ version, reason, refused = false }) {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.#failedFile(), JSON.stringify({ version: String(version || ''), reason: String(reason || '').slice(0, 400), refused: !!refused, at: Date.now() }))
      return true
    } catch { return false }
  }

  // ── what the page and the CLI ask ─────────────────────────────────────────────────────────────────────────────
  state () {
    const running = runningInfo()
    if (!this.channel) {
      return { app: APP_ID, appName: APP_NAME, running, platform: null, status: 'no-channel', latest: null, available: false, behind: 0, progress: null, error: null, canInstall: false, versions: [], pending: [], job: { state: 'idle' }, channel: { name: DEFAULT_CHANNEL.name, publisher: '', link: '', connected: false, isDefault: true, publisherIsMe: false }, rejected: 0, checkedAt: null, refused: null, phone: onPhone }
    }
    const s = this.channel.state()
    const cfg = this.cfg
    return {
      ...s,
      appName: APP_NAME,
      running,
      channel: {
        ...s.channel,
        link: cfg.folder || cfg.link || '',
        folder: cfg.folder || null,
        publisher: cfg.publisher || '',
        isDefault: !cfg.folder && cfg.link === DEFAULT_CHANNEL.link && cfg.publisher === DEFAULT_CHANNEL.publisher,
        publisherIsMe: !!cfg.publisher && publisherRef(cfg.publisher) === this.app.device.ref,
        peers: this.space ? this.#peersOn(this.space.topicHash) : null
      },
      phone: false
    }
  }

  async check () { if (!this.channel) return this.state(); await this.channel.check(); return this.state() }
  async download (id) { if (!this.channel) throw new Error('no update channel on a phone'); await this.channel.download(id || undefined); return this.state() }
  async install (id) { if (!this.channel) throw new Error('no update channel on a phone'); await this.channel.install(id || undefined); return this.state() }
  release (id) { const r = this.channel?.release(String(id || '')); return r ? { ...r, verified: true, signedBy: r.publisher } : null }
  failInstall (err) { this.channel?.failInstall(err) }

  /** The person changes where updates come from: a Space link + publisher, a local folder, or back to the default. */
  async setChannel ({ link, publisher, folder, reset = false } = {}) {
    if (reset) this.save({ link: DEFAULT_CHANNEL.link, publisher: DEFAULT_CHANNEL.publisher, folder: null, name: DEFAULT_CHANNEL.name })
    else {
      const patch = {}
      if (folder !== undefined) { if (folder && !existsSync(String(folder))) throw new Error(`no folder at ${folder}`); patch.folder = folder ? String(folder) : null }
      if (link !== undefined) { if (link && !/^pearcore:\/\//.test(String(link))) throw new Error('that is not a Space link (pearcore://…)'); patch.link = link ? String(link).trim() : null }
      if (publisher !== undefined) { const ref = publisherRef(publisher); if (publisher && !ref) throw new Error('the publisher key is ed25519:<64 hex>'); patch.publisher = ref }
      this.save(patch)
    }
    if (this.channel) { await this.attach(); await this.channel.check() }
    return this.state()
  }

  // ── publishing (the publisher's Mac) ──────────────────────────────────────────────────────────────────────────
  /** Sign a release record with this device's key: the record comes back with `publisher` and `sig`. */
  async record (record) {
    this.kit ??= await loadKit()
    const { sig, publisher, ...rest } = record ?? {}
    return this.kit.signRelease(rest, (bytes) => this.app.device.sign(bytes), this.app.device.ref)
  }

  /** The channel Space this device publishes: found by name, made once (readable by anyone with the link, written by this device). */
  async #publishSpace () {
    const core = this.app.core
    const cfg = this.cfg
    const spaces = await core.space.list()
    let space = (cfg.publishTopic && spaces.find((s) => s.topicHash === cfg.publishTopic)) || spaces.find((s) => s.spaceName === SPACE_NAME)
    if (!space) {
      const me = this.app.device.ref.slice(8)
      space = await core.space.create({ spaceName: SPACE_NAME, permissionRead: true, permissionBroadcast: false, broadcastWhitelist: [me] })
      try { await writeManifest(core, space, { kind: 'updates', name: `${APP_NAME} updates` }) } catch (err) { console.error('[updates] manifest:', err.message) }
    }
    return space
  }

  /** Register every installer and record of a deliveries folder in the channel Space (a file already there is left). */
  async registerFolder (folder = this.cfg.publishFolder) {
    if (!folder || !existsSync(folder)) throw new Error(`no deliveries folder at ${folder}`)
    this.kit ??= await loadKit()
    const space = await this.#publishSpace()
    const drive = this.app.core.drives.get(space)
    const names = readdirSync(folder).filter((n) => this.kit.parseInstallerName(n) || (n.endsWith('.release.json') && this.kit.parseInstallerName(n.slice(0, -'.release.json'.length))))
    const registered = []
    for (const n of names) {
      try { await addFileOnce(drive, n, join(folder, n)); registered.push(n) } catch (err) { console.error(`[updates] ${n}: ${err.message}`) }
    }
    return { topic: space.topicHash, link: space.sharelink, registered }
  }

  /**
   * Make this device the channel's publisher of `folder`: the Space exists, the settings remember it, CHANNEL.json
   * sits in the folder for people and check.mjs, and every installer and record in the folder is in the Space.
   */
  async publish ({ folder } = {}) {
    folder = folder || this.cfg.publishFolder || join(process.env.HOME || '', 'Anjou', '_deliveries', APP_ID)
    if (!existsSync(folder)) throw new Error(`no deliveries folder at ${folder}`)
    const space = await this.#publishSpace()
    const publisher = this.app.device.ref
    this.save({ publishFolder: folder, publishTopic: space.topicHash, link: space.sharelink, publisher })
    const channelFile = join(folder, 'CHANNEL.json')
    if (!existsSync(channelFile)) writeFileSync(channelFile, JSON.stringify({ app: APP_ID, channel: 'release', name: APP_NAME, space: space.sharelink, publisher }, null, 2) + '\n')
    const r = await this.registerFolder(folder)
    if (this.channel && !this.channel.source) await this.attach()
    this.channel?.check().catch(() => {})
    return { app: APP_ID, folder, link: space.sharelink, publisher, topic: space.topicHash, registered: r.registered, peers: this.#peersOn(space.topicHash) }
  }
}
