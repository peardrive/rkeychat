// Local persistence for one room: the rKey chain, pending ops, and the
// append-only log of signed records (messages + controls).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ACTIVITY_KEEP = 2000

export class RoomStore {
  constructor (dir) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    this.logPath = join(dir, 'log.jsonl')
    this.records = new Map()
    this.ordered = []
    if (existsSync(this.logPath)) {
      for (const line of readFileSync(this.logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { this.#index(JSON.parse(line)) } catch {}
      }
      this.#sort()
    }
  }

  #index (rec) {
    if (this.records.has(rec.id)) return false
    this.records.set(rec.id, rec)
    this.ordered.push(rec)
    return true
  }

  #sort () { this.ordered.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)) }

  has (id) { return this.records.has(id) }
  get (id) { return this.records.get(id) }

  // Returns true if the record was new.
  add (rec) {
    if (!this.#index(rec)) return false
    appendFileSync(this.logPath, JSON.stringify(rec) + '\n')
    const n = this.ordered.length
    if (n > 1 && this.ordered[n - 2].ts > rec.ts) this.#sort()
    return true
  }

  since (ts, limit = 500) {
    return this.ordered.filter((r) => r.ts > ts).slice(0, limit)
  }

  get lastTs () { return this.ordered.at(-1)?.ts ?? 0 }

  // Agent activity lives beside the log, never in it: capped, local-first.
  get activity () {
    if (!this._activity) {
      this._activity = []
      const p = join(this.dir, 'activity.jsonl')
      if (existsSync(p)) {
        for (const line of readFileSync(p, 'utf8').split('\n').slice(-ACTIVITY_KEEP)) {
          try { if (line.trim()) this._activity.push(JSON.parse(line)) } catch {}
        }
      }
    }
    return this._activity
  }
  addActivity (rec) {
    const a = this.activity
    if (a.some((x) => x.id === rec.id)) return false
    a.push(rec)
    if (a.length > ACTIVITY_KEEP * 1.5) {
      this._activity = a.slice(-ACTIVITY_KEEP)
      writeFileSync(join(this.dir, 'activity.jsonl'), this._activity.map((x) => JSON.stringify(x)).join('\n') + '\n')
    } else appendFileSync(join(this.dir, 'activity.jsonl'), JSON.stringify(rec) + '\n')
    return true
  }

  // Content-addressed attachments (voice memos, later any file): blobs/<sha256>.
  blobPath (hash) { return join(this.dir, 'blobs', hash) }
  // files shared by hash (pearcore roots) land in files/<root>/<name>
  filePath (root) { return join(this.dir, 'files', String(root).replace(/[^0-9a-f]/g, '')) }
  // root -> local path, for files we shared from elsewhere on disk or fetched
  fileIndex () {
    if (!this._files) { try { this._files = JSON.parse(readFileSync(join(this.dir, 'files', 'index.json'), 'utf8')) } catch { this._files = {} } }
    return this._files
  }
  rememberFile (root, path) {
    const idx = this.fileIndex(); idx[root] = path
    mkdirSync(join(this.dir, 'files'), { recursive: true })
    writeFileSync(join(this.dir, 'files', 'index.json'), JSON.stringify(idx, null, 2))
  }
  hasBlob (hash) { return /^[0-9a-f]{64}$/.test(hash) && existsSync(this.blobPath(hash)) }
  putBlob (bytes, expected) {
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (expected && hash !== expected) throw new Error('blob does not match its hash')
    mkdirSync(join(this.dir, 'blobs'), { recursive: true })
    if (!existsSync(this.blobPath(hash))) writeFileSync(this.blobPath(hash), bytes)
    return hash
  }
  getBlob (hash) { return this.hasBlob(hash) ? readFileSync(this.blobPath(hash)) : null }

  readJSON (name, fallback) {
    const p = join(this.dir, name)
    if (!existsSync(p)) return fallback
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
  }

  writeJSON (name, value) {
    const p = join(this.dir, name)
    writeFileSync(p + '.tmp', JSON.stringify(value, null, 1))
    renameSync(p + '.tmp', p)
  }
}
