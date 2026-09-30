// A room = one pearcore private space + one rKey account chain.
//
// Transport trust (who may carry traffic) is pearcore's whitelist, derived
// from the chain's 'host' keys. Author trust (who may speak) is checked per
// record against the chain. Only the device holding the root appends to the
// chain; everyone else merges the copies they receive.

import { EventEmitter } from 'node:events'
import * as fsSync from 'node:fs'
import { extname } from 'node:path'
import { Chain, enroll, revoke, consent } from 'rkey'
import { SCOPES, envelope, isOurs, makeMessage, makeControl, makeActivity, makeReaction, makeRedaction, makeInvite, verifyRecord, parseMentions } from './proto.js'
import { budget, addressedTo, replyDepth } from './turns.js'

const edRef = (hex) => `ed25519:${hex}`
const PRESENCE_EVERY = 20_000
const PRESENCE_STALE = 60_000
const DEBUG = !!process.env.RKEYCHAT_DEBUG
const SYNC_EVERY = 60_000
const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', css: 'text/css', zip: 'application/zip' }
export const mimeOf = (name) => MIMES[extname(String(name)).slice(1).toLowerCase()] ?? 'application/octet-stream'
export const TURN_WINDOW = 45_000 // how long the next agent in line waits before taking an unclaimed turn
export const MAX_BLOB = 8 * 1024 * 1024 // one pearcore message; ~40 min of voice
const RECENT = 48 * 3600_000 // history sync compares ids within this window

export class Room extends EventEmitter {
  constructor ({ core, store, room, device, root = null, participants = {} }) {
    super()
    this.core = core
    this.store = store
    this.cfg = room // { name, topic, sharelink, root }
    this.device = device // rKey signer for this machine's pearcore key
    this.rootSigner = root // only on the owner device
    this.local = participants // name -> { signer, role, bridge? }
    this.pending = store.readJSON('pending.json', [])
    this.presence = new Map() // deviceRef -> { ts, participants: [{ name, state }] }
    this.agentState = new Map() // name -> 'idle' | 'thinking' | ...
    this.passed = new Map() // name -> Set of record ids it chose not to answer
    this.fetching = new Map() // root -> in-flight fetch
    const entries = store.readJSON('chain.json', null)
    this.chain = entries ? new Chain(entries) : null
  }

  get isOwner () { return !!this.rootSigner }
  get topic () { return this.cfg.topic }

  // ---------- lifecycle ----------

  async start () {
    const { emitter } = this.core
    emitter.on('SpaceMessage', (e) => this.#onSpaceMessage(e).catch((err) => this.emit('error', err)))
    emitter.on('Connection', ({ topics }) => { if (topics.includes(this.topic)) { this.#hello(); this.announceFiles() } })
    emitter.on('SpaceHashList', ({ topics }) => { if (topics.includes(this.topic)) { this.#hello(); this.announceFiles() } })
    emitter.on('SpaceSync', () => this.#hello())
    if (DEBUG) {
      emitter.on('Reject', (ctx) => console.error('[pearcore reject]', JSON.stringify(ctx).slice(0, 300)))
      const mm = this.core.managers.message
      if (!mm.__rkcTraced) {
        mm.__rkcTraced = true
        const orig = mm.handleIncomingMessage.bind(mm)
        mm.handleIncomingMessage = async (sock, data, info) => {
          try {
            const m = JSON.parse(Buffer.from(data).toString())
            console.error('[pearcore in]', m.type, Buffer.from(info.publicKey).toString('hex').slice(0, 8), `${data.length}B`)
            if (process.env.RKEYCHAT_CAPTURE && m.type === 'SpaceMessage') {
              const { writeFileSync, mkdirSync } = await import('node:fs')
              mkdirSync(process.env.RKEYCHAT_CAPTURE, { recursive: true })
              writeFileSync(`${process.env.RKEYCHAT_CAPTURE}/${Date.now()}-${data.length}.json`, Buffer.from(data))
            }
          } catch {}
          return orig(sock, data, info)
        }
      }
    }
    this.timer = setInterval(() => { this.#healSockets(); this.#sendPresence() }, PRESENCE_EVERY)
    this.timer.unref()
    // anti-entropy: even if a live message is lost, everything converges
    this.syncTimer = setInterval(() => this.#hello(), SYNC_EVERY)
    this.syncTimer.unref()
    if (this.isOwner) await this.#syncWhitelist()
    this.applyRename()
    this.#hello()
  }

  stop () { clearInterval(this.timer); clearInterval(this.syncTimer) }

  async space () {
    const list = await this.core.space.list()
    return list.find((s) => s.isSync && s.topicHash === this.topic) ?? null
  }

  async #send (type, body) {
    const space = await this.space()
    if (DEBUG) console.error('[tx]', type, space ? '' : '(no space)')
    if (!space) return false // not admitted yet
    await this.core.messages.send(space, envelope(type, body))
    return true
  }

  #hello () {
    clearTimeout(this.helloTimer)
    this.helloTimer = setTimeout(async () => {
      if (this.chain) await this.#send('chain', { entries: this.chain.toJSON(), pending: this.pending })
      const since = Date.now() - RECENT
      await this.#send('hist-req', { since: Math.min(since, this.store.lastTs), have: this.store.since(since, Infinity).map((r) => r.id) })
      await this.#sendPresence()
    }, 300)
  }

  // Workaround for a pearcore bug: its SocketManager keeps one socket per peer,
  // and when Hyperswarm dedupes a double connection the record can be dropped
  // while the surviving connection stays open — pearcore then silently skips
  // that peer on send. Re-register live connections from known room devices.
  #healSockets () {
    const swarm = this.core.managers.connection.swarmInstance
    const sockets = this.core.managers.sockets
    if (!swarm || !this.state) return
    for (const conn of swarm.connections) {
      if (conn.destroyed || !conn.remotePublicKey) continue
      const key = Buffer.from(conn.remotePublicKey).toString('hex')
      const rec = sockets.peers.get(key)
      // healthy: the record points at this live connection (or another live one)
      if (rec && (rec.socket === conn || !rec.socket?.destroyed)) continue
      if (!this.state.can(edRef(key), SCOPES.host)) continue
      if (DEBUG) console.error('[heal] re-registering orphaned socket for', key.slice(0, 8))
      sockets.addSocket(conn, key, [this.topic])
      this.#hello()
    }
  }

  // ---------- membership ----------

  get state () { return this.chain?.view(this.pending).state ?? null }

  members () {
    const s = this.state
    if (!s) return []
    return s.members().filter((m) => m.depth > 0).map((m) => ({ ...m, name: m.label }))
  }

  participantsList () {
    const now = Date.now()
    const online = new Set()
    for (const p of this.presence.values()) {
      if (now - p.ts < PRESENCE_STALE) p.participants.forEach((x) => online.add(x.name))
    }
    Object.keys(this.local).forEach((n) => online.add(n))
    return this.members()
      .filter((m) => m.scope.includes(SCOPES.chat))
      .map((m) => ({
        name: m.name,
        ref: m.ref,
        status: m.status,
        role: m.scope.includes(SCOPES.admin) ? 'human' : 'agent',
        local: !!this.local[m.name],
        online: online.has(m.name),
        state: this.agentState.get(m.name) ?? this.#remoteState(m.name) ?? 'idle'
      }))
  }

  #remoteState (name) {
    for (const p of this.presence.values()) {
      const x = p.participants.find((y) => y.name === name)
      if (x) return x.state
    }
    return null
  }

  names () { return this.participantsList().filter((p) => p.status === 'active').map((p) => p.name) }

  // Decorate a verified record with who wrote it, per the current chain.
  view (rec) {
    const s = this.state
    const node = s?.get(rec.author)
    const scope = node ? s.scopeOf(rec.author) : []
    return { ...rec, name: node?.label ?? rec.author.slice(0, 16), human: scope.includes(SCOPES.admin) }
  }

  // What admins removed: message ids and blocked content hashes.
  blocked () {
    const ids = new Map(); const hashes = new Set()
    for (const r of this.store.ordered) {
      if (r.kind !== 'redact') continue
      ids.set(r.target, r)
      for (const h of r.hashes ?? []) hashes.add(h)
    }
    return { ids, hashes }
  }

  log () {
    const { ids } = this.blocked()
    return this.store.ordered.map((r) => {
      const v = this.view(r)
      const red = ids.get(r.id)
      if (!red || r.kind !== 'msg') return v
      return { ...v, text: '', att: undefined, mentions: [], redacted: { by: this.view(red).name, ts: red.ts } }
    })
  }

  budget () { return budget(this.log()) }

  #admitReason (rec) {
    const s = this.state
    if (!s) return 'no-chain'
    if (!verifyRecord(rec)) return 'bad-sig'
    if (rec.room !== this.topic) return 'wrong-room'
    if (!s.trustedAt(rec.author, rec.ts)) return 'untrusted-at-ts'
    return this.#admits(rec) ? 'ok' : 'scope'
  }

  #admits (rec) {
    const s = this.state
    if (!s || !verifyRecord(rec) || rec.room !== this.topic) return false
    if (!s.trustedAt(rec.author, rec.ts)) return false
    const need = rec.kind === 'control' || rec.kind === 'redact' || rec.kind === 'invite' ? SCOPES.admin : SCOPES.chat
    if (!s.scopeOf(rec.author).includes(need)) return false
    // a hash the room removed can't come back in a new message
    if (rec.kind === 'msg' && (rec.att ?? []).some((a) => this.blocked().hashes.has(a.hash))) return false
    return true
  }

  // ---------- ingest ----------

  async #onSpaceMessage ({ message, content }) {
    if (message.topic !== this.topic || !isOurs(content)) return
    const fromDevice = edRef(message.publicKey)
    if (DEBUG) console.error('[rx]', content.type, 'from', message.publicKey.slice(0, 8), content.rec ? `${content.rec.kind} ${this.#admitReason(content.rec)}` : '')
    switch (content.type) {
      case 'rec':
        return this.#ingest(content.rec)
      case 'hist-res':
        for (const r of content.records ?? []) this.#ingest(r, { quiet: true })
        return this.emit('changed')
      case 'hist-req': {
        const have = new Set(Array.isArray(content.have) ? content.have : [])
        const records = this.store.since(Number(content.since) || 0, Infinity).filter((r) => !have.has(r.id)).slice(0, 1000)
        if (records.length) await this.#send('hist-res', { records })
        return
      }
      case 'act': {
        const rec = content.rec
        const s = this.state
        if (rec?.kind === 'activity' && rec.room === this.topic && s?.can(rec.author, SCOPES.chat) && verifyRecord(rec) && this.store.addActivity(rec)) {
          this.emit('activity', this.view(rec))
        }
        return
      }
      case 'blob':
        try { this.store.putBlob(Buffer.from(String(content.data), 'base64'), content.hash); this.emit('blob', content.hash) } catch {}
        return
      case 'blob-req':
        for (const h of (content.hashes ?? []).slice(0, 8)) if (this.store.hasBlob(h) && !this.blocked().hashes.has(h)) await this.#sendBlob(h)
        return
      case 'chain':
        return this.#onChain(content.entries, content.pending)
      case 'op':
        return this.#onPending([content.op])
      case 'presence':
        if (this.state?.can(fromDevice, SCOPES.host)) {
          this.presence.set(fromDevice, { ts: Date.now(), participants: content.participants ?? [] })
          this.emit('presence')
        }
    }
  }

  #ingest (rec, { quiet = false } = {}) {
    if (this.store.has(rec?.id) || !this.#admits(rec)) return false
    this.store.add(rec)
    if (rec.kind === 'control' && rec.action === 'rename') this.applyRename()
    if (rec.kind === 'invite' && rec.to === this.device.ref) this.emit('invite', { code: rec.code, from: this.cfg.name })
    if (!quiet) this.emit('record', this.view(rec))
    return true
  }

  #onChain (entries, pending = []) {
    if (!Array.isArray(entries)) return
    if (!this.chain) {
      try {
        const c = new Chain(entries)
        if (c.root !== this.cfg.root) return // not the account our invite named
        this.chain = c
      } catch { return }
    } else {
      const r = this.chain.merge(entries)
      if (r.result === 'fork') this.emit('fork', r)
      if (r.result !== 'advanced') return this.#onPending(pending)
    }
    this.store.writeJSON('chain.json', this.chain.toJSON())
    this.#onPending(pending)
    this.emit('chain')
  }

  #onPending (ops) {
    let changed = false
    for (const op of ops ?? []) {
      if (!op?.sig || this.pending.some((p) => p.sig === op.sig)) continue
      const { applied } = this.chain?.view([op]) ?? { applied: [] }
      if (!applied.length) continue
      this.pending.push(op)
      changed = true
    }
    if (!changed) return
    this.store.writeJSON('pending.json', this.pending)
    if (this.isOwner) this.#foldPending().catch((err) => this.emit('error', err))
    this.emit('chain')
  }

  // ---------- owner: chain writes ----------

  async #foldPending () {
    const ops = this.pending
    for (const op of ops) {
      try { await this.chain.append(op, this.rootSigner) } catch {}
    }
    this.pending = this.pending.filter((p) => !ops.includes(p))
    this.#chainChanged()
  }

  #chainChanged () {
    this.store.writeJSON('chain.json', this.chain.toJSON())
    this.store.writeJSON('pending.json', this.pending)
    this.#syncWhitelist().then(() => this.#send('chain', { entries: this.chain.toJSON(), pending: this.pending }))
    this.emit('chain')
  }

  async #syncWhitelist () {
    const space = await this.space()
    if (!space) return
    const hosts = this.members()
      .filter((m) => m.status === 'active' && m.scope.includes(SCOPES.host) && m.ref.startsWith('ed25519:'))
      .map((m) => m.ref.slice(8))
      .sort()
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
    if (same([...space.readWhitelist].sort(), hosts) && same([...space.broadcastWhitelist].sort(), hosts)) return
    await this.core.space.update(space, {
      permissionRead: false,
      permissionBroadcast: false,
      readWhitelist: hosts,
      broadcastWhitelist: hosts
    })
  }

  // request = { device: { ref, name, consent }, participants: [{ ref, name, role, consent }] }
  async approve (request) {
    if (!this.isOwner) throw new Error('only the room owner can approve')
    const root = this.chain.root
    const taken = new Set(this.members().filter((m) => m.status !== 'revoked').map((m) => m.name))
    const ops = []
    const d = request.device
    if (d && !this.state.isActive(d.ref)) {
      ops.push(await enroll(this.rootSigner, { root, key: d.ref, consent: d.consent, scope: ['bind', SCOPES.host], label: `device:${d.name}` }))
    }
    for (const p of request.participants ?? []) {
      if (this.state.isActive(p.ref)) continue
      if (this.state.get(p.ref)?.revoked) continue // revoked keys stay out; the rest of the request still counts
      const name = String(p.name).toLowerCase()
      if (taken.has(name)) throw new Error(`name already in use: ${name}`)
      const role = p.role === 'human' ? SCOPES.admin : SCOPES.agent
      ops.push(await enroll(this.rootSigner, { root, key: p.ref, consent: p.consent, scope: ['bind', SCOPES.chat, role], label: name }))
      taken.add(name)
    }
    for (const op of ops) await this.chain.append(op, this.rootSigner)
    this.#chainChanged()
    return ops.length
  }

  async revoke (ref, reason = 'removed') {
    if (!this.isOwner) throw new Error('only the room owner can revoke others')
    await this.chain.append(await revoke(this.rootSigner, { root: this.chain.root, key: ref, reason }), this.rootSigner)
    this.#chainChanged()
  }

  // A local participant or this device removes itself; works without the owner.
  async leave (name) {
    const signer = name ? this.local[name]?.signer : this.device
    if (!signer) throw new Error(`no local key for ${name}`)
    const op = await revoke(signer, { root: this.chain.root, key: signer.ref })
    this.#onPending([op])
    await this.#send('op', { op })
  }

  // ---------- activity (people can watch it; agents never read it) ----------

  async activity (name, text, { claim } = {}) {
    const p = this.local[name]
    if (!p || !this.state?.can(p.signer.ref, SCOPES.chat)) return null
    const rec = await makeActivity(p.signer, { room: this.topic, text, claim })
    this.store.addActivity(rec)
    this.emit('activity', this.view(rec))
    await this.#send('act', { rec })
    return rec
  }

  activityFor (name, limit = 300) {
    return this.store.activity.map((r) => this.view(r)).filter((r) => !name || r.name === name).slice(-limit)
  }

  // ---------- attachments ----------

  async #sendBlob (hash) {
    const bytes = this.store.getBlob(hash)
    if (bytes && bytes.length <= MAX_BLOB) await this.#send('blob', { hash, data: bytes.toString('base64') })
  }

  // Ask peers for attachments we don't have yet (fetched on demand, not bulk-synced).
  async wantBlobs (hashes) {
    const missing = hashes.filter((h) => !this.store.hasBlob(h))
    if (missing.length) await this.#send('blob-req', { hashes: missing })
    return missing
  }

  // ---------- posting ----------

  async post (name, text, { re = [], via, att } = {}) {
    const p = this.local[name]
    if (!p) throw new Error(`${name} is not hosted on this device`)
    text = String(text ?? '').trim()
    // signed statements are integer-only: durations in ms, peaks 0-100
    att = Array.isArray(att) && att.length
      ? att.slice(0, 4).map((a) => ({
          hash: String(a.hash),
          kind: a.kind === 'file' ? 'file' : undefined,
          name: a.kind === 'file' ? String(a.name).slice(0, 255) : undefined,
          path: a.kind === 'file' ? String(a.path).slice(0, 1024) : undefined,
          mime: String(a.mime ?? 'application/octet-stream'),
          size: Math.round(Number(a.size) || 0),
          ms: a.ms != null ? Math.round(Number(a.ms)) : a.duration != null ? Math.round(Number(a.duration) * 1000) : undefined,
          peaks: Array.isArray(a.peaks) ? a.peaks.slice(0, 64).map((p) => Math.max(0, Math.min(100, Math.round(Number(p) <= 1 ? Number(p) * 100 : Number(p))))) : undefined,
          transcript: a.transcript ? String(a.transcript) : undefined
        }))
      : undefined
    if (!text && !att) throw new Error('empty message')
    for (const a of att ?? []) if (a.kind !== 'file' && !this.store.hasBlob(a.hash)) throw new Error('attachment not found on this device')
    if ((att ?? []).some((a) => this.blocked().hashes.has(a.hash))) throw new Error('that file was removed from this room by an admin')
    const triggers = re.map((id) => this.store.get(id)).filter(Boolean).map((r) => this.view(r))
    const human = p.role === 'human'
    // an agent speaking without answering anything continues the current thread
    const mirror = via === 'mirror'
    const depth = human || mirror ? 0 : triggers.length ? replyDepth(triggers) : this.budget().used + 1
    if (!human && !mirror && !this.budget().allows(depth, name)) throw new Error('not allowed to post right now (paused, limited, or out of rounds) — waiting for a human')
    const rec = await makeMessage(p.signer, {
      room: this.topic,
      text,
      mentions: parseMentions(text, this.names()),
      re: triggers.map((t) => t.id),
      depth,
      via: via === 'voice' || via === 'mirror' ? via : undefined,
      att
    })
    if (!this.#ingest(rec)) throw new Error('your key is not an active chat member of this room')
    await this.#send('rec', { rec })
    // push attachment bytes to whoever's online now; anyone else asks later
    for (const a of att ?? []) await this.#sendBlob(a.hash)
    return this.view(rec)
  }

  // Deliver an invite for another room to a device that's in this one.
  async sendInvite (toDeviceRef, code, roomName) {
    const human = Object.entries(this.local).find(([, p]) => p.role === 'human')?.[1]
    if (!human) throw new Error('only a person can invite')
    const rec = await makeInvite(human.signer, { room: this.topic, to: toDeviceRef, code, name: roomName })
    if (!this.#ingest(rec)) throw new Error('only the room\'s admins can send invites')
    await this.#send('rec', { rec })
    return rec
  }

  // The room's preferred message style for agents: 'concise' (default) or 'verbose'.
  style () {
    let st = 'concise'
    for (const r of this.store.ordered) if (r.kind === 'control' && r.action === 'style' && r.style) st = r.style
    return st
  }

  // The room's purpose (a standing prompt every agent gets) and the order in
  // which agents answer a message that names nobody. Latest admin record wins.
  charter () {
    let c = { text: '', order: [] }
    for (const r of this.store.ordered) if (r.kind === 'control' && r.action === 'charter') c = { text: r.text ?? '', order: r.order ?? [] }
    return c
  }

  // A rename is a control record, so it reaches every member and survives
  // restarts. The config name follows the latest one.
  applyRename () {
    let name = null
    for (const r of this.store.ordered) if (r.kind === 'control' && r.action === 'rename' && r.name) name = r.name
    if (name && name !== this.cfg.name) { this.cfg.name = name; this.emit('renamed', name) }
  }

  // ---------- files, by hash, on pearcore's drive ----------
  // A shared file lives in this space at a virtual path (/chat/<name>) as a
  // signed provider record (path → Merkle root → who has it). Anyone in the
  // space fetches it by root from whoever is online; once fetched, this device
  // registers as a provider too, so files get more available as they spread.

  async #browser () {
    const space = (await this.core.space.list()).find((s) => s.topicHash === this.topic)
    if (!space) throw new Error('space not found')
    return this.core.drives.get(space)
  }

  // pearcore only sends its file list during a space sync, so a peer that
  // connects later never learns what we hold. Re-announce our own records
  // (already signed) through pearcore's broadcaster when someone connects.
  announceFiles () {
    try {
      const me = this.device.ref.slice(8)
      const files = this.core.managers.spaceFileList.get(this.topic)
      const b = this.core.managers.spaceFiles.fileEventBroadcaster
      let n = 0
      for (const [path, variants] of Object.entries(files)) {
        for (const [rootHash, v] of Object.entries(variants)) {
          const mine = v.peers?.[me]
          if (!mine) continue
          b.add('add', { topic: this.topic, path, publicKey: me, timestamp: mine.timestamp, rootHash, signature: mine.signature })
          n++
        }
      }
      if (DEBUG && n) console.error('[files] re-announced', n, 'records')
    } catch (err) { if (DEBUG) console.error('[files] announce failed', err.message) }
  }

  // Share a file that already exists on this device. Returns the attachment.
  async shareFile (localPath, { name } = {}) {
    const { statSync } = await import('node:fs')
    const { basename } = await import('node:path')
    const st = statSync(localPath)
    if (!st.isFile()) throw new Error('not a file')
    name = String(name ?? basename(localPath)).replace(/[\/\\]/g, '_').trim() || 'file'
    const path = `/chat/${name}`
    const browser = await this.#browser()
    const entry = await browser.addFile(`chat/${name}`, localPath)
    const root = await new Promise((resolve, reject) => {
      entry.onError(reject)
      entry.onComplete(() => resolve(entry.rootHash))
    })
    if (!root) throw new Error('indexing produced no root')
    this.store.rememberFile(root, localPath)
    return { kind: 'file', hash: root, name, path: entry.path ?? path, size: st.size, mime: mimeOf(name) }
  }

  // Where a shared file is on this device, if it is (our own, or fetched).
  localFile (root) {
    const p = this.store.fileIndex()[root]
    return p && fsSync.existsSync(p) ? p : null
  }

  // Everyone the space knows has this file right now.
  providersOf (att) {
    try {
      const recs = this.core.managers?.spaceFileList?.get(this.topic)?.[att.path]?.[att.hash]?.peers ?? {}
      return Object.keys(recs)
    } catch { return [] }
  }

  // Fetch a shared file from the space. Resolves to the local path.
  async fetchFile (att) {
    const have = this.localFile(att.hash)
    if (have) return have
    if (this.blocked().hashes.has(att.hash)) throw new Error('that file was removed from this room by an admin')
    if (this.fetching.has(att.hash)) return this.fetching.get(att.hash)
    const job = (async () => {
      const browser = await this.#browser()
      const entry = await browser.getFile(att.path)
      if (!entry || !entry.exists) throw new Error('nobody online has this file right now')
      const dir = this.store.filePath(att.hash)
      fsSync.mkdirSync(dir, { recursive: true })
      const dest = `${dir}/${att.name}`
      const task = await entry.download(att.hash, dest)
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('download timed out')), 6 * 3600_000); t.unref()
        task.onComplete(() => { clearTimeout(t); resolve() })
      })
      this.store.rememberFile(att.hash, dest)
      // become a provider too (fire and forget)
      browser.addFile(att.name, dest).catch(() => {})
      this.emit('file', { hash: att.hash, path: dest })
      return dest
    })()
    this.fetching.set(att.hash, job)
    try { return await job } finally { this.fetching.delete(att.hash) }
  }

  // Everything this room knows about a key: its enroll op (with the key's own
  // consent), so the same root can sign it into another room without asking again.
  enrollmentOf (name) {
    const s = this.state
    const e = this.chain?.entries.findLast((x) => x.op?.t === 'enroll' && x.op.label === name && s.isActive(x.op.key))
    if (!e) return null
    const deviceRef = [...this.presence.entries()].find(([, p]) => p.participants.some((x) => x.name === name))?.[0] ??
      this.chain.entries.filter((x) => x.op?.t === 'enroll' && x.op.label?.startsWith('device:') && s.isActive(x.op.key))
        .sort((a, b) => Math.abs(a.op.ts - e.op.ts) - Math.abs(b.op.ts - e.op.ts))[0]?.op.key
    const d = this.chain.entries.findLast((x) => x.op?.t === 'enroll' && x.op.key === deviceRef)?.op
    return { participant: e.op, device: d }
  }

  async redact (name, target, reason) {
    const p = this.local[name]
    if (!p || p.role !== 'human') throw new Error('only a person can remove messages')
    const msg = this.store.get(target)
    if (!msg || msg.kind !== 'msg') throw new Error('no such message')
    const hashes = (msg.att ?? []).map((a) => a.hash)
    const rec = await makeRedaction(p.signer, { room: this.topic, target, hashes, reason })
    if (!this.#ingest(rec)) throw new Error('only the room\'s admins can remove messages')
    await this.#send('rec', { rec })
    return rec
  }

  async react (name, target, emoji, on = true) {
    const p = this.local[name]
    if (!p) throw new Error(`${name} is not hosted on this device`)
    if (!this.store.get(target)) throw new Error('no such message')
    const rec = await makeReaction(p.signer, { room: this.topic, target, emoji, on })
    if (!this.#ingest(rec)) throw new Error('reaction rejected')
    await this.#send('rec', { rec })
    return this.view(rec)
  }

  // Current reactions per message: { msgId: { emoji: [names] } } (last toggle wins).
  reactions () {
    const state = new Map()
    for (const r of this.log()) {
      if (r.kind !== 'react') continue
      const key = `${r.target}\u0000${r.emoji}\u0000${r.name}`
      if (r.on) state.set(key, r); else state.delete(key)
    }
    const out = {}
    for (const r of state.values()) {
      ((out[r.target] ??= {})[r.emoji] ??= []).push(r.name)
    }
    return out
  }

  async control (name, action, opts = {}) {
    const p = this.local[name]
    if (!p || p.role !== 'human') throw new Error('controls need a local human participant')
    const rec = await makeControl(p.signer, { room: this.topic, action, ...opts })
    if (!this.#ingest(rec)) throw new Error('control rejected (not an admin?)')
    await this.#send('rec', { rec })
    return rec
  }

  // Unanswered messages addressed to `name`, oldest first, since its last post.
  triggersFor (name) {
    const log = this.log()
    let lastOwn = -1
    log.forEach((r, i) => { if (r.kind === 'msg' && r.name === name) lastOwn = i })
    const answered = new Set(log.filter((r) => r.name === name).flatMap((r) => r.re ?? []))
    const passed = this.passed.get(name) ?? new Set()
    const mine = log.slice(lastOwn + 1).filter((r) => addressedTo(r, name) && !answered.has(r.id) && !passed.has(r.id))
    // turn order: a message that names nobody goes to the first agent in the
    // charter's list; the next in line waits one window, then takes it unless
    // an earlier agent has claimed or answered it. Mentions bypass the order.
    const order = this.charter().order
    const i = order.indexOf(name)
    if (i <= 0) return mine
    const earlier = new Set(order.slice(0, i))
    const taken = (t) => log.some((r) => r.kind === 'msg' && earlier.has(r.name) && (r.re ?? []).includes(t.id)) ||
      this.store.activity.some((a) => a.ts >= t.ts && Array.isArray(a.claim) && a.claim.includes(t.id) && earlier.has(this.view(a).name))
    const now = Date.now()
    return mine.filter((t) => {
      if (!t.human || t.mentions.length) return true
      if (taken(t)) { if (!this.passed.has(name)) this.passed.set(name, new Set()); this.passed.get(name).add(t.id); return false }
      const dueAt = t.ts + i * TURN_WINDOW
      if (now < dueAt) { this.#pokeAt(dueAt); return false }
      return true
    })
  }

  #pokeAt (when) {
    const delay = Math.max(50, when - Date.now() + 20)
    if (this.pokeTimer && this.pokeAtTs <= when) return
    clearTimeout(this.pokeTimer)
    this.pokeAtTs = when
    this.pokeTimer = setTimeout(() => { this.pokeTimer = null; this.emit('changed') }, delay)
  }

  // An agent chose to stay silent on these; don't wake it for them again.
  markPassed (name, ids) {
    if (!this.passed.has(name)) this.passed.set(name, new Set())
    ids.forEach((id) => this.passed.get(name).add(id))
    this.emit('changed')
  }

  setAgentState (name, state) {
    this.agentState.set(name, state)
    this.emit('presence')
    this.#sendPresence()
  }

  async #sendPresence () {
    const participants = Object.keys(this.local).map((name) => ({ name, state: this.agentState.get(name) ?? 'idle' }))
    await this.#send('presence', { participants })
  }
}

// Build the join request a new device hands to the owner.
export async function joinRequest ({ root, deviceName, device, participants }) {
  return {
    device: { ref: device.ref, name: deviceName, consent: await consent(device, root) },
    participants: await Promise.all(Object.entries(participants).map(async ([name, p]) => ({
      ref: p.signer.ref, name, role: p.role, consent: await consent(p.signer, root)
    })))
  }
}
