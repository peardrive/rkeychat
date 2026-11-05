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

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { decodeShareLink } from 'pearcore/src/utils/sharelink.utils.js'
import { dataDir } from './config.js'

const EXT = (type) => /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : 'webm'
const SPACE = 'rkeychat-debug'

export class DebugNotes {
  constructor (app) {
    this.app = app
    this.dir = join(dataDir(), 'debug-notes')
    this.space = null
  }

  // The space, made on first use. Readable by anyone holding the link and writable by nobody else:
  // a helper joins to read notes, never to change them.
  async open () {
    if (this.space) return this.space
    const me = this.app.device.ref.slice(8)
    const name = `${SPACE}:${me.slice(0, 16)}`
    const existing = (await this.app.core.space.list()).find((s) => s.spaceName === name)
    this.space = existing ?? await this.app.core.space.create({
      spaceName: name,
      permissionRead: true,
      permissionBroadcast: false,
      broadcastWhitelist: [me]
    })
    mkdirSync(join(this.dir, 'notes'), { recursive: true })
    return this.space
  }

  async info () {
    try {
      const s = await this.open()
      return { dir: this.dir, sharelink: s.sharelink, topic: s.topicHash, count: this.list().length }
    } catch (err) {
      return { dir: this.dir, sharelink: null, topic: null, count: this.list().length, error: err.message }
    }
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

  // Read another device's notes by the link it shows under Settings → Debug: join that space (we can read, not
  // write), wait for its file list, and fetch what we do not have yet into from/<host>/notes/<id>/. The other
  // device has to be awake with rKeyChat open: it is the only one holding the files.
  async pull (link, { waitMs = 45_000 } = {}) {
    link = String(link ?? '').trim()
    let d = null
    try { d = decodeShareLink(link) } catch {}
    const [kind, host] = String(d?.spaceName ?? '').split(':')
    if (!d || kind !== SPACE || !host) throw new Error(`that isn't a debug-notes link${d?.spaceName ? ` (it names "${d.spaceName}")` : ''}`)
    const core = this.app.core
    let space = (await core.space.list()).find((s) => s.sharelink === link || s.spaceName === d.spaceName)
    if (!space) space = await core.space.join(link)
    const topic = space.topicHash
    const peers = () => { try { return core.managers.sockets.getConnectedSockets({ topics: [topic] }).length } catch { return 0 } }
    const listing = () => Object.entries(core.managers.spaceFileList.get(topic) ?? {}).filter(([p]) => /^\/?notes\//.test(p))
    const t0 = Date.now()
    while (!listing().length && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 1000))
    const files = listing()
    if (!files.length) throw new Error(`no notes seen from ${host} after ${Math.round(waitMs / 1000)}s (${peers()} of its peers connected). Is their rKeyChat open, and have they saved a note?`)
    const browser = core.drives.get(space)
    const base = join(this.dir, 'from', host)
    const ids = new Set(); let pulled = 0
    for (const [path, variants] of files) {
      const [id, ...rest] = path.replace(/^\/?notes\//, '').split('/'); const file = rest.join('/')
      if (!id || !file || id.startsWith('.') || file.includes('..')) continue
      ids.add(id)
      const dest = join(base, 'notes', id, file)
      if (existsSync(dest)) continue
      // the newest variant of the path, by its providers' timestamps
      const newest = (v) => Math.max(0, ...Object.values(v.peers ?? {}).map((p) => Number(p.timestamp) || 0))
      const root = Object.entries(variants).sort((a, b) => newest(b[1]) - newest(a[1]))[0]?.[0]
      if (!root) continue
      mkdirSync(dirname(dest), { recursive: true })
      const entry = await browser.getFile(path)
      const task = await entry.download(root, dest)
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out fetching ${id}/${file}`)), 10 * 60_000); t.unref?.()
        task.onComplete(() => { clearTimeout(t); resolve() }); task.onError?.((e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))) })
      })
      pulled++
    }
    return { host, topic, peers: peers(), notes: [...ids].sort().reverse(), files: files.length, pulled, dir: base }
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
    for (const f of files) {
      const entry = await drive.addFile(`notes/${id}/${f}`, join(this.dir, 'notes', id, f))
      await new Promise((resolve, reject) => { entry.onError(reject); entry.onComplete(resolve) })
    }
  }
}
