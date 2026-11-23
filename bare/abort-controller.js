// AbortController and AbortSignal for Bare, which has neither (2026-11-23). pearcore's file delivery makes one per
// content request (delivery.manager.js createTask), so without this the phone answered every request for one of
// its files with "internal error" and no device ever got a note, a photo or a file from it. The WHATWG shape, the
// parts pearcore and the usual libraries use: aborted, reason, onabort, addEventListener/removeEventListener('abort',
// fn, { once }), throwIfAborted, AbortSignal.abort() and AbortSignal.timeout().
export function installAbortController (g = globalThis) {
  if (typeof g.AbortController === 'function' && typeof g.AbortSignal === 'function') return false

  class AbortSignal {
    constructor () {
      this.aborted = false
      this.reason = undefined
      this.onabort = null
      this._listeners = new Map()
    }

    addEventListener (type, fn, opts) {
      if (type !== 'abort' || typeof fn !== 'function') return
      const once = typeof opts === 'object' && opts !== null && !!opts.once
      this._listeners.set(fn, once)
      if (opts && typeof opts === 'object' && opts.signal) opts.signal.addEventListener('abort', () => this.removeEventListener(type, fn))
    }

    removeEventListener (type, fn) {
      if (type === 'abort') this._listeners.delete(fn)
    }

    dispatchEvent (event) {
      if (event?.type !== 'abort') return true
      if (typeof this.onabort === 'function') { try { this.onabort(event) } catch (err) { queueMicrotask(() => { throw err }) } }
      for (const [fn, once] of [...this._listeners]) {
        if (once) this._listeners.delete(fn)
        try { fn(event) } catch (err) { queueMicrotask(() => { throw err }) }
      }
      return true
    }

    throwIfAborted () {
      if (this.aborted) throw this.reason
    }

    _abort (reason) {
      if (this.aborted) return
      this.aborted = true
      this.reason = reason === undefined ? abortError() : reason
      this.dispatchEvent({ type: 'abort', target: this, currentTarget: this })
    }

    static abort (reason) {
      const s = new AbortSignal()
      s._abort(reason)
      return s
    }

    static timeout (ms) {
      const s = new AbortSignal()
      const t = setTimeout(() => s._abort(timeoutError()), ms)
      if (typeof t?.unref === 'function') t.unref()
      return s
    }

    static any (signals) {
      const s = new AbortSignal()
      for (const x of signals) {
        if (x.aborted) { s._abort(x.reason); break }
        x.addEventListener('abort', () => s._abort(x.reason), { once: true })
      }
      return s
    }

    get [Symbol.toStringTag] () { return 'AbortSignal' }
  }

  class AbortController {
    constructor () { this.signal = new AbortSignal() }
    abort (reason) { this.signal._abort(reason) }
    get [Symbol.toStringTag] () { return 'AbortController' }
  }

  const abortError = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; e.code = 20; return e }
  const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; e.code = 23; return e }

  g.AbortSignal = AbortSignal
  g.AbortController = AbortController
  return true
}
