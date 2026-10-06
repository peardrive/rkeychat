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

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  list () {
    try {
      return readdirSync(join(this.dir, 'notes')).filter((n) => !n.startsWith('.')).sort().reverse().map((id) => {
        const p = join(this.dir, 'notes', id, 'note.json')
        try { return { id, ...JSON.parse(readFileSync(p, 'utf8')) } } catch { return { id } }
      })
    } catch { return [] }
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
