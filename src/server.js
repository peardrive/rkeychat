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
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const UI = join(dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html')
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const unb64 = (s) => JSON.parse(Buffer.from(String(s).trim(), 'base64url').toString('utf8'))

export function encodeInvite (room) { return 'rkc1.' + b64({ n: room.name, s: room.sharelink, r: room.root, t: room.topic }) }
export function decodeInvite (code) {
  const s = String(code ?? '').trim()
  if (!s.startsWith('rkc1.')) throw new Error('that isn\'t an rKeyChat invite (they start with rkc1.)')
  const { n, s: sharelink, r: root, t: topic } = unb64(s.slice(5))
  return { name: n, sharelink, root, topic }
}
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
  return {
    name: room.cfg.name,
    topic: room.topic,
    owner: room.isOwner,
    root: room.cfg.root,
    admitted: !!room.chain,
    participants: room.participantsList(),
    members: room.members(),
    budget: serializeBudget(room.budget()),
    reactions: room.reactions(),
    style: room.style(),
    charter: room.charter(),
    connections: room.connections(),
    log: room.log().filter((r) => r.kind !== 'react' && r.kind !== 'redact' && r.kind !== 'invite').slice(-500)
  }
}

export function serve ({ app }) {
  const { cfg, device } = app
  const sse = new Set()
  const push = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sse) res.write(frame)
  }

  const wire = ({ room }) => {
    const t = room.topic
    room.on('record', (rec) => {
      if (rec.kind === 'react') return push('reactions', { topic: t, reactions: room.reactions() })
      if (rec.kind === 'redact' || rec.kind === 'invite') return push('room', roomSnapshot(room))
      push('record', { topic: t, rec, budget: serializeBudget(room.budget()) })
      push('rooms', app.list())
    })
    room.on('changed', () => push('room', roomSnapshot(room)))
    room.on('chain', () => { push('room', roomSnapshot(room)); push('rooms', app.list()) })
    room.on('presence', () => { push('participants', { topic: t, participants: room.participantsList() }); push('rooms', app.list()) })
    room.on('agent-error', (e) => push('agent-error', { topic: t, ...e }))
    room.on('activity', (rec) => push('activity', { topic: t, rec }))
    room.on('fork', (f) => push('fork', { topic: t, seq: f.seq }))
  }
  // pearcore-level counters for the debug route (what arrives, what gets rejected)
  const pcEvents = {}
  for (const ev of ['SpaceFileEvent', 'SpaceSync', 'Reject', 'SpaceFileTreeResponse', 'Connection']) {
    app.core.emitter.on(ev, (e) => { pcEvents[ev] = (pcEvents[ev] ?? 0) + 1; if (ev === 'Reject') pcEvents.lastRejection = { reason: e?.message?.payload?.reason ?? e?.message?.reason, of: e?.message?.payload?.type ?? e?.message?.payload?.original?.type } })
  }
  for (const r of app.rooms.values()) wire(r)
  app.on('room-added', (r) => { wire(r); push('rooms', app.list()) })
  app.on('room-renamed', ({ room }) => { push('room', roomSnapshot(room)); push('rooms', app.list()) })

  const need = (cond, msg, status = 400) => { if (!cond) { const e = new Error(msg); e.status = status; throw e } }
  const pick = (key) => { const r = app.find(key); need(r, key ? `no room "${key}"` : 'no rooms yet. Create one first', 404); return r }
  const localHuman = () => Object.entries(cfg.participants).find(([, p]) => p.role === 'human')?.[0]
  // an agent replying without naming a room answers wherever it was given a turn
  const roomForAgent = (as, key) => key ? pick(key) : ([...app.rooms.values()].find((r) => r.runners.get(as)?.busy) ?? pick())

  const routes = {
    'GET /': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readFileSync(UI)) },

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
      res.write(': hi\n\n')
      sse.add(res)
      const ka = setInterval(() => res.write(': ka\n\n'), 15000)
      req.on('close', () => { clearInterval(ka); sse.delete(res) })
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
      const { room: key, action, n, until, hours, agent, style, text, order, name } = await body(req)
      const { room } = pick(key)
      const ok = agent ? ['pause', 'resume', 'limit'] : ['extend', 'unlimited', 'until', 'pause', 'resume', 'reset', 'style', 'charter', 'rename']
      if (action === 'rename') need(String(name ?? '').trim(), 'a room needs a name')
      if (action === 'charter' && order !== undefined) need(Array.isArray(order) && order.every((o) => room.participantsList().some((p) => p.name === o && p.role === 'agent')), 'order must list agents in this room')
      need(ok.includes(action), `unknown action "${action}"`)
      const u = until ?? (hours ? Date.now() + Number(hours) * 3600_000 : undefined)
      return room.control(localHuman(), action, { n: n === undefined || n === null ? undefined : Number(n), until: u, agent, style: style === 'verbose' ? 'verbose' : style ? 'concise' : undefined, text, order, name })
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
        return { ok: true, revoked: [m.ref] }
      }
      let tops = active.filter((x) => x.name === name && x.depth === 1 && !x.label?.startsWith('device:'))
      need(tops.length, `nobody called ${name} in this room`)
      // after a key roll the name has an account root (delegate) and old flat keys: by name means the old keys
      // ...unless it's a ban: that must take the account root, or the root could just enroll a new session
      if (reason !== 'banned' && tops.some((x) => x.scope.includes('delegate')) && tops.some((x) => !x.scope.includes('delegate'))) tops = tops.filter((x) => !x.scope.includes('delegate'))
      if (cfg.participants[name] && !room.isOwner) { await room.leave(name); return { ok: true } }
      for (const m of tops) await room.revoke(m.ref, reason)
      return { ok: true, revoked: tops.map((m) => m.ref) }
    },

    // NDJSON stream of turns for a stream-bridged agent, across all rooms
    // (or one, with ?room=). This is what `rkeychat wait` reads.
    'GET /api/wait': (req, res, url) => {
      const as = url.searchParams.get('as')
      const only = url.searchParams.get('room')
      need(cfg.participants[as]?.role === 'agent' && (cfg.participants[as].bridge?.kind ?? 'stream') === 'stream', `${as} is not a stream agent on this device`)
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
      res.write(JSON.stringify({ type: 'ready', name: as }) + '\n')
      const offs = []
      const attach = ({ room, runners }) => {
        if (only && room.topic !== only && room.cfg.name !== only) return
        const runner = runners.get(as)
        if (runner) offs.push(runner.listen((turn) => res.write(JSON.stringify({ type: 'turn', room: room.cfg.name, topic: room.topic, ...turn }) + '\n')))
      }
      for (const r of app.rooms.values()) attach(r)
      app.on('room-added', attach)
      const ka = setInterval(() => res.write(JSON.stringify({ type: 'ka' }) + '\n'), 30000)
      req.on('close', () => { clearInterval(ka); app.off('room-added', attach); offs.forEach((off) => off()) })
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
    'GET /api/activity': (req, res, url) => {
      const { room } = pick(url.searchParams.get('room'))
      const since = Number(url.searchParams.get('since')) || 0
      const until = Number(url.searchParams.get('until')) || Infinity
      return room.activityFor(url.searchParams.get('as'), 5000).filter((r) => r.ts > since && r.ts <= until).slice(-(Number(url.searchParams.get('limit')) || 400))
    },
    'POST /api/redact': async (req) => {
      const { room: key, target, reason } = await body(req)
      const { room } = pick(key)
      return room.redact(localHuman(), target, reason)
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

    'GET /api/debug': () => {
      const swarm = app.core.managers.connection.swarmInstance
      return {
        swarmConnections: [...(swarm?.connections ?? [])].map((c) => Buffer.from(c.remotePublicKey).toString('hex').slice(0, 12)),
        peers: [...app.core.managers.sockets.peers.keys()].map((k) => k.slice(0, 12)),
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
