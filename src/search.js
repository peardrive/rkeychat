// Search for one room's messages.
//
// The room's log (log.jsonl, the RoomStore) stays the only source of truth. Beside it sits search.db, a SQLite
// full-text index (FTS5) of message text and shared file names, which can be deleted at any time and is rebuilt
// from the log. Before each search the index catches up with whatever the store holds that it hasn't seen, so
// nothing is missed however a record arrived (live, from history sync, from this device). Removed messages are
// taken out of the index, and never returned either way.
//
// SQLite comes through pearcore (its own database uses better-sqlite3; rkeychat doesn't depend on it directly).
// Where it can't be loaded, or has no FTS5, search scans the log in memory instead: slower in a huge room,
// same results.

import { createRequire } from 'node:module'
import { join } from 'node:path'

let Sqlite // undefined: not tried yet; null: not available here
function sqlite () {
  if (Sqlite !== undefined) return Sqlite
  Sqlite = null
  const from = []
  try { from.push(import.meta.resolve('pearcore')) } catch {} // pearcore's copy, wherever npm put it
  from.push(import.meta.url)
  for (const base of from) {
    try { Sqlite = createRequire(base)('better-sqlite3'); break } catch {}
  }
  return Sqlite
}

// what a message is found by: its words and the names of the files it shares
const bodyOf = (rec) => [rec.text ?? '', ...(rec.att ?? []).filter((a) => a.kind === 'file' && a.name).map((a) => a.name)].join('\n').trim()

// The words someone typed: letters and digits only, everything else separates them; at most 12, no repeats.
export const wordsOf = (q) => [...new Set((String(q ?? '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => fold(w)))].slice(0, 12)

// Those words as an FTS5 query that can't be misread as syntax: a message matches when it has every one of them,
// anywhere and in any order, each as a word or the start of one ("deplo" finds "deploy").
export function queryOf (q) {
  return wordsOf(q).map((w) => `"${w}"*`).join(' ')
}

// For the in-memory scan: case- and accent-insensitive, like the index's tokenizer
function fold (s) { return String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() }
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// each word as a word or the start of one
const startsOf = (words) => words.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escRe(w)}`, 'u'))
const MARK_ON = '\u0002'; const MARK_OFF = '\u0003' // around each match in a snippet; the page turns them into <mark>

export class RoomSearch {
  constructor (room, { scanOnly = false } = {}) {
    this.room = room
    this.db = scanOnly ? null : undefined // opened on first use; null: scan the log instead
    this.seen = null // ids already in the index
    this.synced = -1 // store size at the last catch-up
  }

  get engine () { return this.#open() ? 'sqlite' : 'scan' }

  #open () {
    if (this.db !== undefined) return this.db
    this.db = null
    const Database = sqlite(); if (!Database) return null
    try {
      const db = new Database(join(this.room.store.dir, 'search.db'))
      db.pragma('journal_mode = WAL')
      db.exec(`
        create virtual table if not exists msgs using fts5(id unindexed, ts unindexed, body, tokenize = 'unicode61 remove_diacritics 2');
        create table if not exists seen (id text primary key);
      `)
      this.seen = new Set(db.prepare('select id from seen').pluck().all())
      this.db = db
    } catch (err) {
      console.error('[search] no index, scanning instead:', err?.message ?? err)
    }
    return this.db
  }

  // Bring the index up to what the store holds: add new messages, drop removed ones.
  #catchUp () {
    const db = this.db; const all = this.room.store.ordered
    if (this.synced === all.length) return
    const add = db.prepare('insert into msgs (id, ts, body) values (?, ?, ?)')
    const mark = db.prepare('insert or ignore into seen (id) values (?)')
    const drop = db.prepare('delete from msgs where id = ?')
    db.transaction(() => {
      for (const r of all) {
        if (this.seen.has(r.id)) continue
        if (r.kind === 'msg') { const body = bodyOf(r); if (body) add.run(r.id, String(r.ts), body) }
        if (r.kind === 'redact' && r.target) drop.run(r.target)
        mark.run(r.id); this.seen.add(r.id)
      }
    })()
    this.synced = all.length
  }

  // Messages that have every one of the words, anywhere and in any order; newest first. [{ id, ts, snippet }]:
  // snippet has MARK_ON/MARK_OFF around matches. Never a removed message.
  find (q, { limit = 50 } = {}) {
    const words = wordsOf(q); if (!words.length) return []
    limit = Math.max(1, Math.min(200, Number(limit) || 50))
    const { ids: removed } = this.room.blocked()
    if (this.#open()) {
      try {
        this.#catchUp()
        // rowid is the order messages were indexed (the store's time order), and walking it backwards is cheap for
        // FTS5 even when a word is in every message; the real time sorts the page. A few extra rows, since a
        // removal not caught up yet is filtered out here.
        const rows = this.db.prepare(`select id, ts, snippet(msgs, 2, '${MARK_ON}', '${MARK_OFF}', '…', 14) as snippet
          from msgs where msgs match ? order by rowid desc limit ?`).all(queryOf(q), limit + 20)
        return rows.filter((r) => !removed.has(r.id)).map((r) => ({ id: r.id, ts: Number(r.ts), snippet: r.snippet }))
          .sort((a, b) => b.ts - a.ts).slice(0, limit)
      } catch (err) {
        console.error('[search] index failed, scanning instead:', err?.message ?? err)
      }
    }
    return this.#scan(words, limit, removed)
  }

  #scan (words, limit, removed) {
    const res = startsOf(words)
    const out = []; const all = this.room.store.ordered
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) { // newest first
      const r = all[i]
      if (r.kind !== 'msg' || removed.has(r.id)) continue
      const body = bodyOf(r); const folded = fold(body)
      if (!res.every((re) => re.test(folded))) continue
      out.push({ id: r.id, ts: r.ts, snippet: scanSnippet(body)(words) })
    }
    return out
  }

  close () { try { this.db?.close() } catch {} this.db = undefined }
}

// A stretch of the text around the first match, each matching word marked as written (the scan fallback's
// snippet). Folding drops accents, which changes lengths, so matches are found in a folded copy built one
// character at a time with a map back to where each folded character came from.
function scanSnippet (body) {
  return (words) => {
    let folded = ''; const from = [] // folded index -> body index
    for (let i = 0; i < body.length;) {
      const ch = String.fromCodePoint(body.codePointAt(i)); const f = fold(ch)
      for (let k = 0; k < f.length; k++) from.push(i)
      folded += f; i += ch.length
    }
    from.push(body.length)
    const spans = [] // [start, end) in body
    for (const w of words) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\p{L}\\p{N}]*`, 'gu')
      for (const m of folded.matchAll(re)) spans.push([from[m.index], from[m.index + m[0].length]])
    }
    spans.sort((a, b) => a[0] - b[0])
    const first = spans[0]?.[0] ?? 0
    const start = Math.max(0, first - 40); const end = Math.min(body.length, first + 100)
    let out = ''; let at = start
    for (const [s, e] of spans) {
      if (s < at || s >= end) continue
      out += body.slice(at, s) + MARK_ON + body.slice(s, Math.min(e, end)) + MARK_OFF; at = Math.min(e, end)
    }
    out += body.slice(at, end)
    return (start ? '…' : '') + out.replace(/\s+/g, ' ') + (end < body.length ? '…' : '')
  }
}
