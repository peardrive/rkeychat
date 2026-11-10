// Local-only HTTP API, live event stream, and the GUI. Binds 127.0.0.1.
// Everything room-scoped takes `room` (topic or name); it defaults to the first room.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadGlossary, saveGlossary, applyGlossary, learn, loadSettings, saveSettings } from './glossary.js'
import { sttAvailable, MODELS } from './stt.js'
import { transcribe, canTranscribe } from './transcribe.js'
import { attachLive } from './live.js'
import { isRemote, authorized, newPairToken, redeem, sessions, revokeSession, tailscaleInfo, enableServe, remoteURL } from './remote.js'
import QRCode from 'qrcode'
import { saveConfig } from './config.js'
import { dataDir } from './config.js'
import { MAX_BLOB } from './room.js'
import { FEED_PAGE } from './feed-window.js'
import { DebugNotes } from './debug-notes.js'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

// A bundled app has no src/ui on disk: it writes the UI out at boot and points here.
const UI = process.env.RKEYCHAT_UI || join(dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html')
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const unb64 = (s) => JSON.parse(Buffer.from(String(s).trim(), 'base64url').toString('utf8'))

import { encodeInvite, decodeInvite } from './invite.js'
export { encodeInvite, decodeInvite }
export const encodeRequest = (req) => 'rkr1.' + b64(req)
export function decodeRequest (code) {
  const s = String(code ?? '').trim()
  if (!s.startsWith('rkr1.')) throw new Error('that isn\'t a join request (they start with rkr1.)')
  return unb64(s.slice(5))
}

async function rawBody (req, limit = MAX_BLOB) {
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > limit) { const e = new Error('too large'); e.status = 413; throw e } chunks.push(c) }
  return Buffer.concat(chunks)
}

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac' }
const extFor = (mime) => EXT[String(mime).split(';')[0].trim()] ?? 'bin'

async function body (req) {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : {}
}

const PAIR_PAGE = (msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>rkeychat</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#ececf1;font:15px -apple-system,sans-serif;padding:24px;text-align:center">
<div><div style="font-weight:650;margin-bottom:10px">rkeychat</div><div style="color:#a3a5b0;max-width:320px;line-height:1.5">${msg}</div></div>`

const serializeBudget = (b) => ({
  paused: b.paused, unlimited: b.unlimited, until: b.until, limit: b.limit, used: b.used,
  remaining: b.remaining === Infinity ? null : b.remaining, agents: b.agents
})

export function roomSnapshot (room) {
  const participants = room.participantsList()
  const newest = room.page({ limit: FEED_PAGE })
  return {
    name: room.cfg.name,
    topic: room.topic,
    owner: room.isOwner,
    root: room.cfg.root,
    admitted: !!room.chain,
    participants,
    members: room.members(),
    budget: serializeBudget(room.budget()),
    reactions: room.reactions(),
    style: room.style(),
    charter: room.charter(),
    spend: room.spend(),
    overBudget: Object.fromEntries(participants.filter((p) => p.role === 'agent').map((p) => [p.name, room.overBudget(p.name)]).filter(([, v]) => v)),
    connections: room.connections(),
    // the newest page of the feed; the page asks GET /api/log for the rest as the reader scrolls
    log: newest.log,
    hasOlder: newest.hasOlder
  }
}

export function serve ({ app }) {
  const { cfg, device } = app
  const sse = new Set()
  // Long-lived responses (event stream, agent wait): a write after the client has
  // gone must never throw. On Bare's HTTP server it surfaces as an 'error' event
  // that, unhandled, aborts the whole process; Node just drops it.
  const streamer = (res, cleanup) => {
    let gone = false
    const done = () => { if (gone) return; gone = true; try { cleanup() } catch {} }
    res.on('close', done); res.on('error', done); res.on('finish', done)
    return (data) => { if (gone) return false; try { return res.write(data) } catch { done(); return false } }
  }
  // `data` may be a function: it is only called when a page is listening, so the daemon builds no
  // snapshots while nobody has the UI open (the usual case for an agent machine).
  const push = (event, data) => {
    if (!sse.size) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(typeof data === 'function' ? data() : data)}\n\n`
    for (const w of sse) w(frame)
  }
  // The heavy, whole-state events come in bursts (an agent at work emits a step every few hundred ms, and each
  // one marks the room changed). Send the latest state once per burst instead of once per step: the page only
  // ever shows the newest one anyway.
  const COALESCE_MS = 250
  const pending = new Map() // key -> timer
  const pushSoon = (key, event, data) => {
    if (!sse.size || pending.has(key)) return
    pending.set(key, setTimeout(() => { pending.delete(key); push(event, data) }, COALESCE_MS))
  }
  const pushRooms = () => pushSoon('rooms', 'rooms', () => app.list())

  const wire = ({ room }) => {
    const t = room.topic
    const pushRoom = () => pushSoon(`room:${t}`, 'room', () => roomSnapshot(room))
    room.on('record', (rec) => {
      if (rec.kind === 'react') return push('reactions', () => ({ topic: t, reactions: room.reactions() }))
      // a removal: the page empties that message wherever it is in the window it holds, which the newest page
      // in a room snapshot would not reach
      if (rec.kind === 'redact' && rec.target) push('redact', { topic: t, id: rec.target, by: rec.name, ts: rec.ts })
      if (rec.kind === 'redact' || rec.kind === 'invite') return pushRoom()
      push('record', () => ({ topic: t, rec: room.withQuote(rec), budget: serializeBudget(room.budget()) }))
      pushRooms()
    })
    room.on('changed', pushRoom)
    room.on('chain', () => { pushRoom(); pushRooms() })
    room.on('presence', () => { pushSoon(`participants:${t}`, 'participants', () => ({ topic: t, participants: room.participantsList() })); pushRooms() })
    room.on('agent-error', (e) => push('agent-error', { topic: t, ...e }))
    room.on('activity', (rec) => push('activity', { topic: t, rec }))
    room.on('fork', (f) => push('fork', { topic: t, seq: f.seq }))
    room.on('file-progress', (p) => push('file-progress', { topic: t, ...p }))
    room.on('file', (f) => push('file-progress', { topic: t, hash: f.hash, percent: 100, done: true }))
  }
  // pearcore-level counters for the debug route (what arrives, what gets rejected)
  const pcEvents = { rejections: {} }
  {
    // count everything pearcore emits, and tally the reasons peers reject our messages with
    const em = app.core.emitter; const emit = em.emit.bind(em)
    em.emit = (ev, e, ...rest) => {
      pcEvents[ev] = (pcEvents[ev] ?? 0) + 1
      if (ev === 'Reject') { const k = `${e?.reason ?? "?"} (${e?.message?.payload?.linkedMessageType ?? e?.message?.payload?.type ?? "?"})`; pcEvents.rejections[k] = (pcEvents.rejections[k] ?? 0) + 1 }
      return emit(ev, e, ...rest)
    }
  }
  for (const r of app.rooms.values()) wire(r)
  app.on('room-added', (r) => { wire(r); pushRooms() })
  app.on('room-renamed', ({ room }) => { push('room', () => roomSnapshot(room)); pushRooms() })
  app.on('login-ask', (ask) => push('login-ask', ask))
  app.on('login-progress', (p) => push('login-progress', p))
  app.on('login', (p) => push('login', p))

  const need = (cond, msg, status = 400) => { if (!cond) { const e = new Error(msg); e.status = status; throw e } }
  const pick = (key) => { const r = app.find(key); need(r, key ? `no room "${key}"` : 'no rooms yet. Create one first', 404); return r }
  // the default `as`: the local human; on a device with none, the only local participant; else say what's available
  const localHuman = () => {
    const names = Object.keys(cfg.participants)
    return Object.entries(cfg.participants).find(([, p]) => p.role === 'human')?.[0] ?? (names.length === 1 ? names[0] : undefined)
  }
  const nameOrDie = (as) => { need(as, `say who's posting: --as NAME (on this device: ${Object.keys(cfg.participants).join(', ') || 'nobody yet'})`); return as }
  // an agent replying without naming a room answers wherever it was given a turn
  const roomForAgent = (as, key) => key ? pick(key) : ([...app.rooms.values()].find((r) => r.runners.get(as)?.busy) ?? pick())
  const notes = new DebugNotes(app)

  const routes = {
    // no-store: the page is read from disk every request, so a reload should always be the UI that is on disk now.
    // Without it a phone can sit on a cached copy and "the fix isn't there" is really "the browser kept yesterday's".
    'GET /': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(readFileSync(UI)) },
    'GET /jsQR.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=86400' }); res.end(readFileSync(join(dirname(UI), 'jsQR.js'))) },

    'GET /api/state': (req, res, url) => {
      const r = app.find(url.searchParams.get('room'))
      return {
        device: { name: cfg.deviceName, ref: device.ref, root: cfg.root ? app.root().ref : null, participants: Object.entries(cfg.participants).map(([name, p]) => ({ name, role: p.role, ref: p.ref, bridge: p.bridge?.kind })) },
        rooms: app.list(),
        canTranscribe: canTranscribe(cfg),
        current: r ? roomSnapshot(r.room) : null
      }
    },
    'GET /api/events': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const w = streamer(res, () => { clearInterval(ka); sse.delete(w) })
      w(': hi\n\n')
      sse.add(w)
      const ka = setInterval(() => w(': ka\n\n'), 15000)
    },

    'GET /api/rooms': () => app.list(),
    'POST /api/rooms': async (req) => {
      const { name, members = [] } = await body(req)
      const room = await app.createRoom(name, { members })
      return roomSnapshot(room)
    },
    'GET /api/people': () => ({
      local: Object.entries(cfg.participants).filter(([, p]) => p.role === 'agent').map(([name]) => ({ name, role: 'agent', local: true })),
      known: app.knownPeople()
    }),
    // bring every device of yours (known from your other rooms) into this room
    'POST /api/rooms/devices': async (req) => {
      const { room: key } = await body(req)
      const { room } = pick(key)
      need(room.isOwner, 'only the room\'s owner can do that')
      return { added: await app.enrollOwnDevices(room) }
    },
    // Project agents (src/agents.js, claude bridge): a Claude Code conversation per room,
    // keyed from a project folder. Adding one is live; no restart.
    'GET /api/agents': async () => app.agents(),
    'POST /api/agents': async (req) => {
      const { name, dir, permissionMode, tools, model } = await body(req)
      need(name, 'an agent needs a name'); need(dir, 'an agent needs a project folder (dir)')
      return app.addAgent({ name, dir, permissionMode, tools: Array.isArray(tools) ? tools : String(tools ?? '').split(',').map((s) => s.trim()).filter(Boolean), model })
    },
    'POST /api/rooms/add': async (req) => {
      const { room: key, name } = await body(req)
      const { room } = pick(key)
      if (cfg.participants[name]) {
        // a local agent: sign it in directly with its own consent
        const p = app.participants[name]
        const { consent } = await import('rkey')
        return { enrolled: await room.approve({ participants: [{ ref: p.signer.ref, name, role: p.role, consent: await consent(p.signer, room.cfg.root) }] }) }
      }
      return app.addMember(room.topic, name)
    },
    'POST /api/rooms/join': async (req) => {
      const { invite } = await body(req)
      const { room, request } = await app.joinRoom(invite)
      return { room: roomSnapshot(room), request: encodeRequest(request) }
    },

    'POST /api/send': async (req) => {
      const { room: key, as = localHuman(), text, re = [], pass = false, via, att } = await body(req)
      nameOrDie(as)
      const { room, runners } = runners0(as, key)
      // a mirrored terminal exchange is just recorded: no turns, no rounds, no glossary
      if (via === 'mirror') return { ...(await room.post(as, text, { via })), roomName: room.cfg.name }
      const runner = runners.get(as)
      if (pass) { runner?.answered({ passed: true }); return { ok: true, passed: true, room: room.cfg.name } }
      const reIds = re.length ? re : (runner?.offered ?? [])
      // dictated messages get the transcription fixes before they're signed
      const fixed = via === 'voice' ? applyGlossary(text) : { text, fixes: [] }
      const rec = await room.post(as, fixed.text, { re: reIds, via, att })
      runner?.answered()
      return { ...rec, roomName: room.cfg.name, fixes: fixed.fixes }
    },
    'POST /api/control': async (req) => {
      const { room: key, action, n, until, hours, agent, style, text, order, agents, name } = await body(req)
      const { room } = pick(key)
      const ok = agent ? ['pause', 'resume', 'limit'] : ['extend', 'unlimited', 'until', 'pause', 'resume', 'reset', 'style', 'charter', 'rename']
      if (action === 'rename') need(String(name ?? '').trim(), 'a room needs a name')
      if (action === 'charter' && order !== undefined) need(Array.isArray(order) && order.every((o) => room.participantsList().some((p) => p.name === o && p.role === 'agent')), 'order must list agents in this room')
      if (action === 'charter' && agents !== undefined) {
        const isAgent = (x) => room.participantsList().some((p) => p.name === x && p.role === 'agent')
        need(agents && typeof agents === 'object' && Object.keys(agents).every(isAgent), 'agent rules must name agents in this room')
        for (const [x, r] of Object.entries(agents)) if (r?.wake === 'backup') need(r.backupFor && r.backupFor !== x && isAgent(r.backupFor), `${x}: backup for whom?`)
      }
      need(ok.includes(action), `unknown action "${action}"`)
      const u = until ?? (hours ? Date.now() + Number(hours) * 3600_000 : undefined)
      return room.control(localHuman(), action, { n: n === undefined || n === null ? undefined : Number(n), until: u, agent, style: style === 'verbose' ? 'verbose' : style ? 'concise' : undefined, text, order, agents, name })
    },

    // what each agent in this room has spent in the last day, measured
    'GET /api/spend': (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const hours = Number(url.searchParams.get('hours')) || 24
      return { spend: room.spend(Date.now() - hours * 3600_000), caps: Object.fromEntries(room.participantsList().filter((p) => p.role === 'agent').map((p) => [p.name, room.ruleFor(p.name).tokensPerDay])) }
    },
    // a CLI agent's runtime reports what a wake cost (Claude Code does this from its
    // own transcript, where the tokens are recorded per turn)
    'POST /api/usage': async (req) => {
      const { room: key, as, usage, text } = await body(req)
      const { room } = pick(key)
      need(as, 'say which agent spent it: as')
      need(usage && typeof usage === 'object', 'usage required')
      const rec = await room.activity(as, String(text || 'answered').slice(0, 200), { usage })
      need(rec, `${as} isn't an active agent on this device`)
      return { ok: true, spend: room.spend()[as] ?? null, overBudget: room.overBudget(as) }
    },

    // Debug notes (src/debug-notes.js): the mic button in the UI saves one here.
    'GET /api/debug/space': async () => notes.info(),
    'GET /api/debug/notes': async () => ({ ...(await notes.info()), notes: notes.list() }),
    'POST /api/debug/note': async (req) => {
      const n = JSON.parse(await rawBody(req, MAX_BLOB) || '{}')
      const audio = n.audio ? Buffer.from(String(n.audio), 'base64') : null
      need(Array.isArray(n.trace), 'a note needs its trace')
      const saved = await notes.save({ id: n.id, audio, audioType: n.audioType, trace: n.trace, meta: n.meta })
      return { ...saved, sharelink: (await notes.info()).sharelink }
    },
    // Share a saved note into a room: its files by hash (like any shared file) and one message that opens no
    // turn (via 'note'). This is how a note taken on the phone reaches the machine where someone can read it;
    // desktops fetch the files as soon as the message lands, so the phone need not stay awake.
    'POST /api/debug/share': async (req) => {
      const { id, room: key } = await body(req)
      const { room } = pick(key)
      const n = notes.list().find((x) => x.id === id || (id && x.id.startsWith(id)))
      need(n, 'no such note', 404)
      const dir = join(notes.dir, 'notes', n.id)
      const att = []
      for (const f of [n.audio, n.trace ?? 'trace.jsonl', 'note.json'].filter(Boolean)) att.push(await room.shareFile(join(dir, f), { name: `${n.id}-${f}` }))
      const secs = Math.round(Number(n.seconds) || 0)
      const text = `Debug note ${n.id} · ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s · ${n.steps ?? '?'} steps${n.room ? ` · in ${n.room}` : ''}${n.audio ? '' : ' · no audio'}${n.window ? ` · ${n.window}` : ''}`
      const rec = await room.post(localHuman(), text, { via: 'note', att })
      return { ...rec, roomName: room.cfg.name, files: att.length }
    },

    'GET /api/invite': (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      need(room.isOwner, 'only the room\'s owner can invite')
      return { invite: encodeInvite(room.cfg), room: room.cfg.name }
    },
    'GET /api/request': async (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      return { request: encodeRequest(await app.request(room)), room: room.cfg.name }
    },
    'POST /api/approve': async (req) => {
      const { room: key, code } = await body(req)
      const { room } = pick(key)
      need(room.isOwner, 'only the room\'s owner can approve')
      return { enrolled: await room.approve(decodeRequest(code)), room: room.cfg.name }
    },
    'POST /api/unban': async (req) => {
      const { room: key, ref } = await body(req)
      const { room } = pick(key)
      need(room.isOwner, 'only the room owner can lift a ban')
      const m = room.members().find((x) => x.reason === 'banned' && (x.ref === ref || x.ref.slice(8).startsWith(ref) || x.ref.includes(ref)))
      need(m, `no banned key matching ${ref}`)
      await room.unban(m.ref)
      return { ok: true, unbanned: m.ref }
    },
    'POST /api/readopt': async (req) => {
      const { room: key, ref } = await body(req)
      const { room } = pick(key)
      need(room.isOwner, 'only the room owner can re-adopt')
      const m = room.members().find((x) => x.status === 'revoked' && (x.ref === ref || x.ref.slice(8).startsWith(ref) || x.ref.includes(ref)))
      need(m, `no revoked key matching ${ref}`)
      return { ok: true, appended: await room.readopt(m.ref) }
    },
    'POST /api/revoke': async (req) => {
      // by name: the whole account (every top-level key with that name, children cascade);
      // with `key` (a ref or prefix): just that key, e.g. the old one after a key roll
      const { room: key, name, ref, reason = 'removed' } = await body(req)
      need(['removed', 'banned', 'compromised'].includes(reason), 'reason is removed, banned or compromised')
      const { room } = pick(key)
      const active = room.members().filter((x) => x.status === 'active')
      if (ref) {
        const m = active.find((x) => x.ref === ref || x.ref.includes(ref) || x.ref.slice(8).startsWith(ref))
        need(m, `no active key matching ${ref}`)
        await room.revoke(m.ref, reason)
        const devices = await room.pruneDevices(reason)
        return { ok: true, revoked: [m.ref], devices }
      }
      let tops = active.filter((x) => x.name === name && x.depth === 1 && !x.label?.startsWith('device:'))
      need(tops.length, `nobody called ${name} in this room`)
      // after a key roll the name has an account root (delegate) and old flat keys: by name means the old keys
      // ...unless it's a ban: that must take the account root, or the root could just enroll a new session
      if (reason !== 'banned' && tops.some((x) => x.scope.includes('delegate')) && tops.some((x) => !x.scope.includes('delegate'))) tops = tops.filter((x) => !x.scope.includes('delegate'))
      if (cfg.participants[name] && !room.isOwner) { await room.leave(name); return { ok: true } }
      for (const m of tops) await room.revoke(m.ref, reason)
      const devices = await room.pruneDevices(reason)
      return { ok: true, revoked: tops.map((m) => m.ref), devices }
    },

    // NDJSON stream of turns for a stream-bridged agent, across all rooms
    // (or one, with ?room=). This is what `rkeychat wait` reads.
    'GET /api/wait': (req, res, url) => {
      const as = url.searchParams.get('as')
      const only = url.searchParams.get('room')
      need(cfg.participants[as]?.role === 'agent' && (cfg.participants[as].bridge?.kind ?? 'stream') === 'stream', `${as} is not a stream agent on this device`)
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
      const offs = []
      let ka = null
      const w = streamer(res, () => { clearInterval(ka); app.off('room-added', attach); offs.forEach((off) => off()) })
      w(JSON.stringify({ type: 'ready', name: as }) + '\n')
      const attach = ({ room, runners }) => {
        if (only && room.topic !== only && room.cfg.name !== only) return
        const runner = runners.get(as)
        if (runner) offs.push(runner.listen((turn) => w(JSON.stringify({ type: 'turn', room: room.cfg.name, topic: room.topic, ...turn }) + '\n')))
      }
      for (const r of app.rooms.values()) attach(r)
      app.on('room-added', attach)
      ka = setInterval(() => w(JSON.stringify({ type: 'ka' }) + '\n'), 30000)
    },

    // Dictation: audio in, text out. Transcribed on this machine; fixes applied.
    'POST /api/dictate': async (req) => {
      need(canTranscribe(cfg), 'no local transcriber on this device')
      const bytes = await rawBody(req)
      const dir = join(dataDir(), 'tmp'); mkdirSync(dir, { recursive: true })
      const file = join(dir, `${randomBytes(6).toString('hex')}.${extFor(req.headers['content-type'])}`)
      writeFileSync(file, bytes)
      try {
        const raw = await transcribe(cfg, file)
        const { text, fixes } = applyGlossary(raw)
        return { text, raw, fixes }
      } finally { rmSync(file, { force: true }) }
    },
    // Attachments: store by content hash in the room; voice gets a local transcript.
    // ---- files by hash (pearcore drive) ----
    // Upload from the GUI: streamed to disk (any size), then shared into the space.
    'POST /api/upload': async (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const name = String(url.searchParams.get('name') ?? 'file').replace(/[\/\\]/g, '_').trim() || 'file'
      const dir = join(room.store.dir, 'files', 'incoming', randomBytes(6).toString('hex')); mkdirSync(dir, { recursive: true })
      const file = join(dir, name)
      const { createWriteStream } = await import('node:fs')
      await new Promise((resolve, reject) => { const w = createWriteStream(file); req.pipe(w); w.on('finish', resolve); w.on('error', reject); req.on('error', reject) })
      return room.shareFile(file)
    },
    // Share a file already on this device (CLI, agents): no copy, the original is the source.
    'POST /api/share': async (req) => {
      const { room: key, path, name } = await body(req)
      const { room } = pick(key)
      need(path, 'path is required')
      return room.shareFile(path, { name })
    },
    // Fetch a shared file from the room; answers when it's on this device.
    'POST /api/fetch': async (req) => {
      const { room: key, hash, root } = await body(req)
      const { room } = pick(key)
      const att = fileAtt(room, String(root ?? hash ?? ''))
      need(att, 'no such file in this room', 404)
      return { ...att, path: await room.fetchFile(att) }
    },
    'GET /api/files': (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const seen = new Map()
      for (const r of room.log()) for (const a of r.att ?? []) if (a.kind === 'file' && !seen.has(a.hash)) seen.set(a.hash, { ...a, by: r.name, ts: r.ts, local: !!room.localFile(a.hash), providers: room.providersOf(a).length })
      return [...seen.values()]
    },

    'POST /api/blob': async (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const mime = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim()
      const bytes = await rawBody(req)
      const hash = room.store.putBlob(bytes)
      let transcript
      if (mime.startsWith('audio/') && canTranscribe(cfg)) {
        const dir = join(dataDir(), 'tmp'); mkdirSync(dir, { recursive: true })
        const file = join(dir, `${hash.slice(0, 12)}.${extFor(mime)}`)
        writeFileSync(file, bytes)
        try { transcript = applyGlossary(await transcribe(cfg, file)).text } catch {} finally { rmSync(file, { force: true }) }
      }
      return { hash, mime, size: bytes.length, transcript }
    },
    // Agent activity: a hook or bridge reports what an agent is doing.
    'POST /api/activity': async (req) => {
      const { room: key, as, text } = await body(req)
      need(cfg.participants[as]?.role === 'agent', `${as} is not an agent on this device`)
      need(String(text ?? '').trim(), 'nothing to report')
      const { room } = roomForAgent(as, key)
      const rec = await room.activity(as, String(text).trim())
      return { ok: !!rec }
    },
    // A window of the feed: ?room=&limit= plus one of before=<id> (older), after=<id> (newer) or around=<id>
    // (that message in the middle, for jumping to it); none gives the newest. -> { log, hasOlder, hasNewer }
    'GET /api/log': (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const q = (k) => url.searchParams.get(k) || undefined
      const out = room.page({ before: q('before'), after: q('after'), around: q('around'), limit: q('limit') })
      need(out, 'that message is not in this room', 404)
      return out
    },
    'GET /api/activity': (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const since = Number(url.searchParams.get('since')) || 0
      const until = Number(url.searchParams.get('until')) || Infinity
      return room.activityFor(url.searchParams.get('as'), 5000).filter((r) => r.ts > since && r.ts <= until).slice(-(Number(url.searchParams.get('limit')) || 400))
    },
    'POST /api/redact': async (req) => {
      const { room: key, target, reason, blockFiles } = await body(req)
      const { room } = pick(key)
      return room.redact(localHuman(), target, reason, { blockFiles })
    },
    'POST /api/unblock': async (req) => {
      const { room: key, hash } = await body(req)
      const { room } = pick(key)
      need(hash, 'which file? pass its hash')
      return room.unblockFile(localHuman(), hash)
    },
    'POST /api/react': async (req) => {
      const { room: key, as = localHuman(), target, emoji, on = true } = await body(req)
      need(cfg.participants[as], `${as} is not on this device`)
      need(String(emoji ?? '').trim(), 'which emoji?')
      const { room } = cfg.participants[as].role === 'agent' ? roomForAgent(as, key) : pick(key)
      let id = target
      if (!id || id === 'last') id = [...room.log()].reverse().find((r) => r.kind === 'msg' && r.name !== as)?.id
      need(id, 'nothing to react to')
      return room.react(as, id, String(emoji).trim(), on)
    },
    'POST /api/glossary/learn': async (req) => ({ learned: learn((await body(req)).pairs) }),
    'GET /api/settings': () => ({ ...loadSettings(), fixes: Object.keys(loadGlossary()).length, speech: sttAvailable() ? MODELS[0].credit : (canTranscribe(cfg) ? 'Whisper (Python service)' : null) }),
    'POST /api/settings': async (req) => {
      const { autofix } = await body(req)
      return saveSettings(autofix === undefined ? {} : { autofix: !!autofix })
    },
    'GET /api/glossary': () => loadGlossary(),
    'POST /api/glossary': async (req) => {
      const { from, to, remove } = await body(req)
      const g = loadGlossary()
      const k = String(from ?? '').trim().toLowerCase()
      need(k, 'what does the transcriber write?')
      if (remove) delete g[k]
      else { need(String(to ?? '').trim(), 'what do you mean by it?'); g[k] = String(to).trim() }
      saveGlossary(g)
      return g
    },

    // ---- phone / remote access (managed from this Mac only)
    'GET /api/remote': (req) => {
      need(!isRemote(req), 'manage phone access from the Mac', 403)
      return { tailscale: tailscaleInfo(), remote: remoteURL(cfg), enabled: !!cfg.remote?.enabled, sessions: sessions() }
    },
    'POST /api/remote/enable': async (req) => {
      need(!isRemote(req), 'manage phone access from the Mac', 403)
      const { https } = await body(req)
      cfg.remote = { ...(cfg.remote ?? {}), enabled: true }
      saveConfig(cfg)
      await listenRemote()
      if (https) enableServe(cfg.port)
      return { remote: remoteURL(cfg) }
    },
    'POST /api/remote/pair': async (req) => {
      need(!isRemote(req), 'pair new devices from the Mac', 403)
      const r = remoteURL(cfg)
      need(r, 'turn on phone access first')
      const url = `${r.url}/pair?t=${newPairToken()}`
      return { url, secure: r.secure, qr: await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#ececf1', light: '#00000000' } }) }
    },
    'POST /api/remote/revoke': async (req) => {
      need(!isRemote(req), 'manage phone access from the Mac', 403)
      revokeSession((await body(req)).id)
      return { sessions: sessions() }
    },

    'POST /api/stop': () => { setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); return { ok: true } },

    // ---- logging a new device in (see login.js) ----
    'POST /api/login/offer': async (req) => {
      need(!isRemote(req), 'start this from the device that holds the account', 403)
      // with `room`, the code invites to that room alone; without, it logs a device in
      const { room } = await body(req).catch(() => ({}))
      const o = await app.login.offer({ room })
      return { ...o, qr: await QRCode.toString(o.code, { type: 'svg', margin: 2, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } }) }
    },
    'GET /api/login/pending': () => ({ invitations: app.login.pending(), asking: app.login.asking() }),
    'POST /api/login/grant': async (req) => { const { topic } = await body(req); return app.login.grant(topic) },
    'POST /api/login/deny': async (req) => { const { topic } = await body(req); return app.login.deny(topic) },
    'POST /api/login/cancel': async (req) => { const { topic } = await body(req); return app.login.cancel(topic) },
    'POST /api/login/claim': async (req) => {
      const { code } = await body(req)
      need(code, 'paste or scan a code')
      return app.login.claim(code)
    },
    'GET /api/login': () => ({ pending: app.login.pending() }),
    'GET /api/debug/agent': (req, res, url) => {
      // budget first: an agent over its cap is not woken at all, which looks like silence

      const name = url.searchParams.get('name')
      return [...app.rooms.values()].map(({ room, runners }) => {
        const r = runners.get(name)
        if (!r) return { room: room.cfg.name, hosted: false }
        const w = r.why()
        const over = room.overBudget(name)
        const spent = room.spend()[name]
        return { room: room.cfg.name, hosted: true, bridge: r.bridge.kind, busy: r.busy, listeners: r.listeners?.size ?? 0, state: room.agentState.get(name), overBudget: over, spentToday: spent?.total ?? 0, ...w, triggers: (w.triggers ?? []).map((t) => ({ id: t.id, from: t.name, text: String(t.text).slice(0, 80) })) }
      })
    },
    'GET /api/debug': () => {
      const swarm = app.core.managers.connection.swarmInstance
      return {
        swarmConnections: [...(swarm?.connections ?? [])].map((c) => Buffer.from(c.remotePublicKey).toString('hex').slice(0, 12)),
        peers: [...app.core.managers.sockets.peers.keys()].map((k) => k.slice(0, 12)),
        // which spaces each connected peer says it holds (what we can send them on)
        peerTopics: Object.fromEntries(Object.entries(app.core.managers.sockets.getSnapShot({ sortByPeers: true })).map(([k, v]) => [k.slice(0, 12), v.map((t) => t.slice(0, 8))])),
        spaces: app.cfg.rooms.map((r) => [r.name, r.topic.slice(0, 8)]),
        pcEvents,
        files: Object.fromEntries([...app.rooms.values()].map(({ room }) => [room.cfg.name, app.core.managers.spaceFileList.get(room.topic)]))
      }
    }
  }
  // A file attachment by (prefix of) its root, from the room's messages.
  function fileAtt (room, root) {
    if (root.length < 8) return null
    for (const r of room.log()) for (const a of r.att ?? []) if (a.kind === 'file' && a.hash.startsWith(root) && !r.redacted) return a
    return null
  }
  // Serve a shared file from disk (fetching it first if needed), with range support for media.
  async function serveFile (req, res, url) {
    const root = url.pathname.slice('/api/file/'.length).split('/')[0]
    const r = app.find(url.searchParams.get('room'))
    const att = r && fileAtt(r.room, root)
    if (!att) { res.writeHead(404); return res.end() }
    if (r.room.blocked().hashes.has(att.hash)) { res.writeHead(410); return res.end('removed from this room') }
    let path
    try { path = await r.room.fetchFile(att) } catch (err) { res.writeHead(404); return res.end(err.message) }
    const { statSync, createReadStream } = await import('node:fs')
    const size = statSync(path).size
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    const headers = { 'content-type': att.mime, 'accept-ranges': 'bytes', 'content-disposition': `${url.searchParams.get('dl') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(att.name)}` }
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
      return createReadStream(path, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...headers, 'content-length': size })
    createReadStream(path).pipe(res)
  }
  // Serve an attachment; if this device doesn't have it yet, ask the room and wait briefly.
  async function serveBlob (req, res, url) {
    const hash = url.pathname.slice('/api/blob/'.length)
    const r = app.find(url.searchParams.get('room'))
    if (!r || !/^[0-9a-f]{64}$/.test(hash)) { res.writeHead(404); return res.end() }
    const { room } = r
    if (room.blocked().hashes.has(hash)) { res.writeHead(410); return res.end('removed from this room') }
    if (!room.store.hasBlob(hash)) {
      await room.wantBlobs([hash])
      await new Promise((resolve) => {
        const t = setTimeout(done, 10_000)
        function done () { clearTimeout(t); room.off('blob', on); resolve() }
        function on (h) { if (h === hash) done() }
        room.on('blob', on)
      })
    }
    const bytes = room.store.getBlob(hash)
    if (!bytes) { res.writeHead(404); return res.end('not available yet') }
    const total = bytes.length
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    const headers = { 'content-type': url.searchParams.get('mime') || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable' }
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 })
      return res.end(bytes.subarray(start, end + 1))
    }
    res.writeHead(200, { ...headers, 'content-length': total })
    res.end(bytes)
  }
  const runners0 = (as, key) => (cfg.participants[as]?.role === 'agent' ? roomForAgent(as, key) : pick(key))

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/pair') {
      const setCookie = redeem(url.searchParams.get('t') ?? '', req)
      if (!setCookie) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end(PAIR_PAGE('That pairing link expired or was already used. Make a new one on the Mac (Settings → Phone).')) }
      res.writeHead(302, { 'set-cookie': setCookie, location: '/' }); return res.end()
    }
    if (!authorized(req)) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"this device isn\'t paired"}') }
      res.writeHead(401, { 'content-type': 'text/html' }); return res.end(PAIR_PAGE('This device isn\'t paired yet. On your Mac, open rKeyChat → Settings (gear) → Phone, and scan the code.'))
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/blob/')) return serveBlob(req, res, url)
    if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) return serveFile(req, res, url)
    const route = routes[`${req.method} ${url.pathname}`]
    if (!route) { res.writeHead(404); return res.end('not found') }
    try {
      const out = await route(req, res, url)
      if (out !== undefined && !res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.status ?? 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  }
  const server = createServer(handler)
  attachLive(server, cfg, authorized)

  // Also listen on this Mac's Tailscale address when phone access is on
  // (plain HTTP over WireGuard; `tailscale serve` provides HTTPS instead).
  let remoteServer = null
  async function listenRemote () {
    const ip = tailscaleInfo().ip
    if (!cfg.remote?.enabled || !ip || remoteServer) return
    remoteServer = createServer(handler)
    attachLive(remoteServer, cfg, authorized)
    await new Promise((resolve) => { remoteServer.once('error', (e) => { console.error('[remote]', e.message); remoteServer = null; resolve() }); remoteServer.listen(cfg.port, ip, resolve) })
  }
  listenRemote()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '127.0.0.1', () => resolve({ close: () => { server.close(); remoteServer?.close() } }))
  })
}
