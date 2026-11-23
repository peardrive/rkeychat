// Debug notes: a voice note, and the steps taken in the app while it ran.
//
// The point (pearcast's docs/NOTES-MODE.md, where this started): a quirk you find while using the app currently
// has to be dictated from memory, with words doing the work of pointing — "the agent row, the one with the gear
// open". The app already knows what you were looking at. It should write that down for you.
//
// Press the mic: a recording starts and the UI keeps a timed list of what you did. Press it again and
// note.<webm|ogg>, trace.jsonl and note.json land together in a **space of their own** — not a room, not a
// project — which is shared read-only by link. Whoever is helping joins that space and pulls the notes.
//
// One such space per app, one shared module: the recorder itself (`createTrace` in the web UI) is pearcast's
// src/trace.js, unchanged in shape. Only the save path differs — there it is IPC to Electron's main process,
// here it is an HTTP POST to this daemon. When a third app wants it, that is the seam to lift into a package.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { decodeShareLink } from 'pearcore/src/utils/sharelink.utils.js'
import { DEFAULT_CHUNK_SIZE } from 'pearcore/src/constants/global.constants.js'
import { dataDir } from './config.js'
import { writeManifest, APP_ID } from './app-space.js'

const EXT = (type) => /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : 'webm'
const hexOf = (k) => (typeof k === 'string' ? k : Buffer.from(k ?? []).toString('hex'))
// a note's id and file from a path in the space ("/notes/<id>/<file>"); null for anything else
const noteFile = (p) => { const m = String(p ?? '').match(/^\/?notes\/([^/]+)\/([^/]+)$/); return m ? { id: m[1], file: m[2] } : null }
// how long a pull waits for one file before giving up: the other device has to be awake and answering
const FILE_WAIT = 90_000
// add a file to a space's registry; one that is already there is fine (a second open, a re-save)
export async function addFileOnce (drive, spacePath, localPath) {
  try {
    const entry = await drive.addFile(spacePath, localPath)
    await new Promise((resolve, reject) => { entry.onError(reject); entry.onComplete(resolve) })
  } catch (err) { if (!/already exists/i.test(String(err?.message ?? err))) throw err }
}

const SPACE = 'rkeychat-debug' // the old name of the space ("rkeychat-debug:<device>"); links to it still pull
const NAME = (device) => `rKeyChat Debug Notes (${device})` // the standard name: PearDrive files it under rKeyChat

export class DebugNotes {
  constructor (app) {
    this.app = app
    this.dir = join(dataDir(), 'debug-notes')
    this.space = null
    // who has asked this device for which note files (the serving side of a pull): key → { at, asked: Set<path>,
    // got: Set<path> }. A file counts as got once its last chunk was asked for. Only this session: a reader that
    // fetched a note before a restart is forgotten, and the note shows as waiting again; that is honest enough.
    this.readers = new Map()
    this.lastReject = null // { at, from, reason }: the last refusal a peer sent us (a pull that is not going to work says why)
    // the other devices' notes spaces this device follows (see follow()): topic → host, and the fetch in flight per topic
    this.followed = new Map()
    this.fetching = new Map()
    this.timers = new Map()
  }

  // The space, made on first use. Readable by anyone holding the link and writable by nobody else:
  // a helper joins to read notes, never to change them.
  async open () {
    if (this.space) return this.space
    const me = this.app.device.ref.slice(8)
    const name = NAME(this.app.cfg.deviceName)
    const spaces = await this.app.core.space.list()
    const existing = spaces.find((s) => s.spaceName === name) ?? spaces.find((s) => s.spaceName === `${SPACE}:${me.slice(0, 16)}`)
    this.space = existing ?? await this.app.core.space.create({
      spaceName: name,
      permissionRead: true,
      permissionBroadcast: false,
      broadcastWhitelist: [me]
    })
    mkdirSync(join(this.dir, 'notes'), { recursive: true })
    this.#listen()
    // what the space is, for readers (space.json, as PearDrive and pearcast write it) and for PearDrive's filing
    // (the manifest and icon of app-spaces-standard.md); announced once, re-announced with the notes
    if (!this.manifested) {
      this.manifested = true
      try {
        const sj = join(this.dir, 'space.json')
        if (!existsSync(sj)) writeFileSync(sj, JSON.stringify({ app: APP_ID, kind: 'debug-notes', version: 1, name, readme: 'Debug notes recorded in rKeyChat: notes/<id>/note.<audio>, trace.jsonl, note.json. Pull them with: rkeychat notes pull <link>', layout: { notes: 'notes/<id>/{note.*,trace.jsonl,note.json}' }, written: new Date().toISOString() }, null, 2))
        await addFileOnce(this.app.core.drives.get(this.space), 'space.json', sj)
        await writeManifest(this.app.core, this.space, { kind: 'debug-notes', name })
      } catch (err) { console.error('[debug] manifest:', err.message) }
      this.announce()
    }
    return this.space
  }

  async info () {
    try {
      const s = await this.open()
      return { dir: this.dir, sharelink: s.sharelink, topic: s.topicHash, count: this.list().length, following: Object.keys(this.following()) }
    } catch (err) {
      return { dir: this.dir, sharelink: null, topic: null, count: this.list().length, following: Object.keys(this.following()), error: err.message }
    }
  }

  // How many peers are on the notes space right now (a reader shows up here while it is pulling, or just open).
  peers () {
    try { const t = this.space?.topicHash; return t ? this.app.core.managers.sockets.getConnectedSockets({ topics: [t] }).length : 0 } catch { return 0 }
  }

  // The name of one of the owner's devices by its pearcore key, when it is one.
  #deviceName (key) {
    try { return this.app.devices().find((d) => d.ref.slice(8) === key)?.name ?? null } catch { return null }
  }

  // Where each of this device's notes stands with the readers: which device has fetched it, which is fetching,
  // and whether anyone is connected to the space at all. This is what the phone's bubble and dot show.
  //   { connected, peers, readers: [{ key, name }], notes: { <id>: { files, state: local|fetching|fetched, by: { <key>: { name, got, of } } } } }
  status () {
    const notes = {}
    for (const n of this.list()) {
      if (n.from) continue
      const files = [n.audio, 'trace.jsonl', 'note.json'].filter(Boolean)
      const by = {}
      let state = 'local'
      for (const [key, r] of this.readers) {
        const asked = files.filter((f) => r.asked.has(`notes/${n.id}/${f}`)).length
        if (!asked) continue
        const got = files.filter((f) => r.got.has(`notes/${n.id}/${f}`)).length
        by[key] = { name: this.#deviceName(key), got, of: files.length }
        if (got >= files.length) state = 'fetched'
        else if (state !== 'fetched') state = 'fetching'
      }
      notes[n.id] = { files: files.length, state, by }
    }
    const peers = this.peers()
    return { connected: peers > 0, peers, readers: [...this.readers.keys()].map((key) => ({ key, name: this.#deviceName(key) })), notes }
  }

  // The serving side of a pull, as pearcore tells it: a reader asked for a file's tree (it is fetching), then for
  // its chunks; the request that reaches the file's last chunk means the reader has (as good as) got it.
  #asked (kind, info, message) {
    try {
      if (!this.space || message?.topic !== this.space.topicHash) return
      const nf = noteFile(message.payload?.spaceFilePath); if (!nf) return
      const path = `notes/${nf.id}/${nf.file}`
      const key = hexOf(info?.publicKey)
      let r = this.readers.get(key)
      if (!r) { r = { at: Date.now(), asked: new Set(), got: new Set() }; this.readers.set(key, r) }
      r.at = Date.now()
      r.asked.add(path)
      if (kind === 'content') {
        const [, end] = message.payload.slice ?? []
        let leaves = 1
        try { leaves = Math.max(1, Math.ceil(statSync(join(this.dir, path)).size / DEFAULT_CHUNK_SIZE)) } catch {}
        if (Number(end) >= leaves - 1) r.got.add(path)
      }
      if (process.env.RKEYCHAT_DEBUG) console.error(`[debug] ${key.slice(0, 8)} asked for the ${kind} of ${path}`)
    } catch (err) { console.error('[debug] asked:', err.message) }
  }

  // Our own notes, then the ones pulled from other devices (under from/<host>/), newest first. Each carries
  // `dir`, where its files are; a pulled one also says which device (`from`) it came from.
  list () {
    const read = (base, extra = {}) => {
      try {
        return readdirSync(join(base, 'notes')).filter((n) => !n.startsWith('.')).map((id) => {
          const d = join(base, 'notes', id)
          try { return { id, ...JSON.parse(readFileSync(join(d, 'note.json'), 'utf8')), dir: d, ...extra } } catch { return { id, dir: d, ...extra } }
        })
      } catch { return [] }
    }
    let all = read(this.dir)
    try { for (const host of readdirSync(join(this.dir, 'from')).filter((n) => !n.startsWith('.'))) all = all.concat(read(join(this.dir, 'from', host), { from: host })) } catch {}
    return all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  }

  // The link another device shows under Settings → Debug: which device's notes it names.
  #parseLink (link) {
    link = String(link ?? '').trim()
    let d = null
    try { d = decodeShareLink(link) } catch {}
    // either spelling of the name: the standard "rKeyChat Debug Notes (<device>)" or the old "rkeychat-debug:<device>"
    const sn = String(d?.spaceName ?? '')
    const std = sn.match(/^rKeyChat Debug Notes \((.+)\)$/i)
    const [kind, old] = sn.split(':')
    const host = std ? std[1] : (kind === SPACE ? old : null)
    if (!d || !host) throw new Error(`that isn't a debug-notes link${sn ? ` (it names "${sn}")` : ''}`)
    return { link, d, host }
  }

  async #joinSpace (link, d) {
    const core = this.app.core
    let space = (await core.space.list()).find((s) => s.sharelink === link || s.spaceName === d.spaceName)
    if (!space) space = await core.space.join(link)
    return space
  }

  #peersOn (topic) { try { return this.app.core.managers.sockets.getConnectedSockets({ topics: [topic] }).length } catch { return 0 } }
  #listing (topic) { return Object.entries(this.app.core.managers.spaceFileList.get(topic) ?? {}).filter(([p]) => /^\/?notes\//.test(p)) }

  // Fetch what we do not have yet of another device's note files into from/<host>/notes/<id>/. `give`: a file
  // that cannot be fetched (its device went away, it refused) is logged and the rest tried, instead of thrown.
  async #fetchFiles (space, host, files, { give = false } = {}) {
    const topic = space.topicHash
    const browser = this.app.core.drives.get(space)
    const base = join(this.dir, 'from', host)
    const ids = new Set(); const newNotes = []; let pulled = 0
    for (const [path, variants] of files) {
      const [id, ...rest] = path.replace(/^\/?notes\//, '').split('/'); const file = rest.join('/')
      if (!id || !file || id.startsWith('.') || file.includes('..')) continue
      ids.add(id)
      const dest = join(base, 'notes', id, file)
      if (existsSync(dest)) continue
      if (give && !this.#peersOn(topic)) { console.error(`[debug] ${host} is not connected: ${id}/${file} waits for next time`); break }
      // the newest variant of the path, by its providers' timestamps
      const newest = (v) => Math.max(0, ...Object.values(v.peers ?? {}).map((p) => Number(p.timestamp) || 0))
      const root = Object.entries(variants).sort((a, b) => newest(b[1]) - newest(a[1]))[0]?.[0]
      if (!root) continue
      mkdirSync(dirname(dest), { recursive: true })
      const entry = await browser.getFile(path)
      const task = await entry.download(root, dest)
      const started = Date.now()
      // pearcore (this version) drops a peer's refusal on the floor and the download waits for ever; we watch for
      // the refusal ourselves and say what it was, and give up on a file after FILE_WAIT either way
      try {
        await new Promise((resolve, reject) => {
          let done = false
          const finish = (fn) => { if (done) return; done = true; clearInterval(tick); clearTimeout(t); fn() }
          const t = setTimeout(() => finish(() => reject(new Error(`timed out fetching ${id}/${file} after ${Math.round(FILE_WAIT / 1000)}s (${this.#peersOn(topic)} of its peers connected). Is their rKeyChat open?`))), FILE_WAIT); t.unref?.()
          const tick = setInterval(() => {
            const r = this.lastReject
            if (r && r.at >= started) finish(() => reject(new Error(`${host} refused ${id}/${file}: ${r.reason}`)))
          }, 500); tick.unref?.()
          task.onComplete(() => finish(resolve)); task.onError?.((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
        })
      } catch (err) {
        // drop the task: a download that failed keeps its listeners and an open file handle until it is stopped
        try { await task.stop?.() } catch {}
        try { const m = this.app.core.managers.spaceFiles?.downloadTasks; if (m) for (const [k, v] of m) if (v === task) m.delete(k) } catch {}
        if (!give) throw err
        console.error(`[debug] ${err.message}`)
        continue
      }
      pulled++
      if (file === 'note.json') newNotes.push(id)
    }
    return { ids: [...ids].sort().reverse(), pulled, newNotes, dir: base }
  }

  // Read another device's notes by the link it shows under Settings → Debug: join that space (we can read, not
  // write), wait for its file list, and fetch what we do not have yet. The other device has to be awake with
  // rKeyChat open: it is the only one holding the files. A pulled device is followed from then on (see follow()).
  async pull (link, { waitMs = 45_000 } = {}) {
    const parsed = this.#parseLink(link); link = parsed.link
    const { d, host } = parsed
    const space = await this.#joinSpace(link, d)
    const topic = space.topicHash
    this.#remember(host, link); this.#watch(topic, host)
    const t0 = Date.now()
    while (!this.#listing(topic).length && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 1000))
    const files = this.#listing(topic)
    if (!files.length) throw new Error(`no notes seen from ${host} after ${Math.round(waitMs / 1000)}s (${this.#peersOn(topic)} of its peers connected). Is their rKeyChat open, and have they saved a note?`)
    const r = await this.#fetchFiles(space, host, files)
    return { host, topic, peers: this.#peersOn(topic), notes: r.ids, files: files.length, pulled: r.pulled, dir: r.dir }
  }

  // ── following another device's notes ────────────────────────────────────────────────────────────────────
  // A phone serves its files only while its app is on the screen, and it is on the screen right after a note is
  // saved: that is the moment to fetch, not whenever someone remembers to pull. So the links this device was given
  // are kept (follow.json: { "<host>": "<link>" }), their spaces joined at start, and whenever a followed device is
  // heard from (it connects, it announces a note) what is missing is fetched at once.
  #followFile () { return join(this.dir, 'follow.json') }
  following () {
    try { return JSON.parse(readFileSync(this.#followFile(), 'utf8')) } catch { return {} }
  }

  #remember (host, link) {
    const all = this.following()
    if (all[host] === link) return
    all[host] = link
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.#followFile(), JSON.stringify(all, null, 2))
  }

  async follow (link) {
    const parsed = this.#parseLink(link); link = parsed.link
    const { d, host } = parsed
    const space = await this.#joinSpace(link, d)
    this.#remember(host, link)
    this.#watch(space.topicHash, host)
    this.#fetchSoon(space.topicHash, 0)
    return { host, topic: space.topicHash, peers: this.#peersOn(space.topicHash), notes: this.#listing(space.topicHash).length }
  }

  async unfollow (host) {
    const all = this.following()
    if (!all[host]) throw new Error(`not following ${host} (following: ${Object.keys(all).join(', ') || 'nobody'})`)
    delete all[host]
    writeFileSync(this.#followFile(), JSON.stringify(all, null, 2))
    for (const [topic, h] of this.followed) if (h === host) this.followed.delete(topic)
    return { host, following: Object.keys(all) }
  }

  // At start: join every followed space again and fetch what arrived while this device was off.
  async followAll () {
    const out = []
    for (const [host, link] of Object.entries(this.following())) {
      try { out.push(await this.follow(link)) } catch (err) { console.error(`[debug] following ${host}:`, err.message) }
    }
    return out
  }

  #watch (topic, host) {
    this.#listen()
    this.followed.set(topic, host)
  }

  #fetchSoon (topic, delay = 1500) {
    clearTimeout(this.timers.get(topic))
    const t = setTimeout(() => { this.timers.delete(topic); this.#fetchMissing(topic).catch((err) => console.error('[debug] fetch:', err.message)) }, delay)
    t.unref?.()
    this.timers.set(topic, t)
  }

  async #fetchMissing (topic) {
    if (this.fetching.has(topic)) return this.fetching.get(topic)
    const host = this.followed.get(topic)
    if (!host) return
    const p = (async () => {
      const space = (await this.app.core.space.list()).find((s) => s.topicHash === topic)
      if (!space) return
      const files = this.#listing(topic)
      if (!files.length) return
      const r = await this.#fetchFiles(space, host, files, { give: true })
      if (r.pulled) console.error(`[debug] fetched ${r.pulled} note file${r.pulled === 1 ? '' : 's'} from ${host}${r.newNotes.length ? ` · new note${r.newNotes.length === 1 ? '' : 's'}: ${r.newNotes.join(', ')}` : ''}`)
    })()
    this.fetching.set(topic, p)
    try { await p } finally { this.fetching.delete(topic) }
  }

  // This device's own downloads in flight (a pull that is taking long): what each one waits for.
  downloads () {
    const out = []
    try {
      for (const [key, t] of this.app.core.managers.spaceFiles.downloadTasks ?? []) {
        let percent = null; try { percent = t.getProgress?.()?.percent ?? null } catch {}
        out.push({ key: key.slice(0, 8), topic: t.topic, path: t.spaceFilePath, percent, providers: [...(t.providerList?.peers?.() ?? [])].map((k) => k.slice(0, 8)), treeKnown: !!t.tree, pendingTreeRequests: t.puller?.pendingRequests?.size ?? null, complete: !!t.downloadComplete })
      }
    } catch (err) { return { error: err.message, tasks: out } }
    return { tasks: out, lastReject: this.lastReject }
  }

  // Save one note and announce its files to the space. The write happens whether or not the space is up:
  // a note taken with the network off is still a note, and `open()` announces what is already on disk.
  async save ({ id, audio, audioType, trace = [], meta = {} }) {
    id = String(id ?? '').replace(/[^0-9A-Za-z._-]/g, '') || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const noteDir = join(this.dir, 'notes', id)
    mkdirSync(noteDir, { recursive: true })
    const files = []
    if (audio?.length) { const f = `note.${EXT(audioType)}`; writeFileSync(join(noteDir, f), audio); files.push(f) }
    writeFileSync(join(noteDir, 'trace.jsonl'), trace.map((l) => JSON.stringify(l)).join('\n') + '\n'); files.push('trace.jsonl')
    writeFileSync(join(noteDir, 'note.json'), JSON.stringify({ ...meta, id, audio: files[0] === 'trace.jsonl' ? null : files[0], trace: 'trace.jsonl' }, null, 2)); files.push('note.json')
    let shared = false
    try { await this.#announce(id, files); shared = true } catch (err) { console.error('[debug] announce:', err.message) }
    return { id, dir: noteDir, files, shared }
  }

  async #announce (id, files) {
    const space = await this.open()
    const drive = this.app.core.drives.get(space)
    for (const f of files) await addFileOnce(drive, `notes/${id}/${f}`, join(this.dir, 'notes', id, f))
  }

  // Re-broadcast every file this device holds in the notes space, so a reader that joined after a note was
  // saved hears of it (pearcore only lists files during a space sync). Runs on every connection to the space.
  announce () {
    try {
      const topic = this.space?.topicHash; if (!topic) return
      const me = this.app.device.ref.slice(8)
      const files = this.app.core.managers.spaceFileList.get(topic) ?? {}
      const b = this.app.core.managers.spaceFiles.fileEventBroadcaster
      let n = 0
      for (const [path, variants] of Object.entries(files)) {
        for (const [rootHash, v] of Object.entries(variants)) {
          const mine = v.peers?.[me]; if (!mine) continue
          b.add('add', { topic, path, publicKey: me, timestamp: mine.timestamp, rootHash, signature: mine.signature }); n++
        }
      }
      if (n && process.env.RKEYCHAT_DEBUG) console.error('[debug] re-announced', n, 'note files')
    } catch (err) { console.error('[debug] announce:', err.message) }
  }

  #listen () {
    if (this.listening) return
    this.listening = true
    const em = this.app.core.emitter
    const onTopic = ({ topics }) => { if (this.space && topics?.includes(this.space.topicHash)) this.announce() }
    em.on('Connection', onTopic)
    em.on('SpaceHashList', onTopic)
    // a followed device is heard from (it connected, listed its files, announced a note): fetch what is missing
    const heard = (ctx) => {
      const topics = ctx?.topics ?? (ctx?.message?.topic ? [ctx.message.topic] : [])
      for (const t of topics) { const h = hexOf(t); if (this.followed.has(h)) this.#fetchSoon(h) }
    }
    em.on('Connection', heard)
    em.on('SpaceHashList', heard)
    em.on('SpaceFileEvent', heard)
    // the serving side: who is fetching which note (status())
    em.on('SpaceFileTreeRequest', ({ info, message }) => this.#asked('tree', info, message))
    em.on('SpaceFileContentRequest', ({ info, message }) => this.#asked('content', info, message))
    // a refusal from a peer: pearcore's download does not act on it, so a pull would wait in silence; we read it
    em.on('Reject', (ctx) => {
      this.lastReject = { at: Date.now(), from: hexOf(ctx?.fromPublicKey).slice(0, 8), reason: String(ctx?.reason ?? 'refused') }
      console.error(`[debug] ${this.lastReject.from} refused a request: ${this.lastReject.reason}`)
    })
  }
}
