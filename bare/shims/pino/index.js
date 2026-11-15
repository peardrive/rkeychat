// Minimal pino stand-in for Bare: same call shapes, console output, level filter.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

function make (opts = {}, bindings = {}) {
  const min = LEVELS[opts.level] ?? 30
  const on = opts.enabled !== false
  const log = {}
  for (const [name, n] of Object.entries(LEVELS)) {
    log[name] = (a, b, ...rest) => {
      if (!on || n < min) return
      const [obj, msg] = typeof a === 'string' ? [b, a] : [a, b]
      const tag = bindings?.name ? ` ${bindings.name}` : bindings && Object.keys(bindings).length ? ' ' + JSON.stringify(bindings) : ''
      const extra = obj instanceof Error ? ' ' + obj.stack : obj && typeof obj === 'object' ? ' ' + safe(obj) : ''
      ;(n >= 50 ? console.error : console.log)(`[${name}]${tag} ${msg ?? ''}${extra}`, ...rest)
    }
  }
  log.level = opts.level ?? 'info'
  // pearcore's createChild(name) passes a STRING; spreading it gave {"0":"M","1":"e"…}
  log.child = (b) => make(opts, { ...bindings, ...(typeof b === 'string' ? { name: b } : b || {}) })
  log.flush = () => {}
  return log
}

function safe (o) { try { return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)) } catch { return String(o) } }

export default function pino (opts) { return make(opts) }
pino.transport = () => undefined
pino.destination = () => undefined
pino.stdSerializers = { err: (e) => e }
