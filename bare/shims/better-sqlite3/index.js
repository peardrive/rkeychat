// better-sqlite3's API, the subset drizzle-orm and pearcore use, on bare-sqlite
// (Holepunch's binding, shaped like node:sqlite). Lets pearcore run unmodified on Bare.
import sqlite from 'bare-sqlite'
const { DatabaseSync } = sqlite

const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v))

class Statement {
  constructor (stmt) { this.stmt = stmt; this.isRaw = false }
  raw (on = true) { this.isRaw = on; return this }
  run (...p) {
    const r = this.stmt.run(...norm(p))
    return { changes: Number(r?.changes ?? 0), lastInsertRowid: r?.lastInsertRowid ?? 0 }
  }
  all (...p) { return this.isRaw ? this.stmt.values(...norm(p)) : this.stmt.all(...norm(p)) }
  get (...p) { return this.isRaw ? this.stmt.values(...norm(p))[0] : this.stmt.get(...norm(p)) }
  * iterate (...p) { yield * (this.isRaw ? this.stmt.values(...norm(p)) : this.stmt.iterate(...norm(p))) }
}

export default class Database {
  constructor (location, opts = {}) {
    this.name = location
    this.db = new DatabaseSync(location, { readOnly: !!opts.readonly, timeout: opts.timeout ?? 5000 })
    this.inTransaction = false
  }

  get open () { return this.db.isOpen }
  prepare (sql) { return new Statement(this.db.prepare(sql)) }
  exec (sql) { this.db.exec(sql); return this }

  pragma (src, opts = {}) {
    const rows = this.db.prepare(`PRAGMA ${src}`).all()
    return opts.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows
  }

  transaction (fn) {
    const run = (mode) => (...args) => {
      if (this.inTransaction) return fn(...args)
      this.db.exec(`BEGIN ${mode}`)
      this.inTransaction = true
      try {
        const r = fn(...args)
        this.db.exec('COMMIT')
        return r
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      } finally { this.inTransaction = false }
    }
    const tx = run('DEFERRED')
    tx.deferred = tx
    tx.immediate = run('IMMEDIATE')
    tx.exclusive = run('EXCLUSIVE')
    return tx
  }

  close () { if (this.db.isOpen) this.db.close(); return this }
}
