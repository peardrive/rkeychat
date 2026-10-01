// A room = one pearcore private space + one rKey account chain.
//
// Transport trust (who may carry traffic) is pearcore's whitelist, derived
// from the chain's 'host' keys. Author trust (who may speak) is checked per
// record against the chain. Only the device holding the root appends to the
// chain; everyone else merges the copies they receive.

import { EventEmitter } from 'node:events'
import * as fsSync from 'node:fs'
import { extname } from 'node:path'
import { Chain, enroll, revoke, unban, consent } from 'rkey'
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
    // name -> { signer, previous?, role, bridge?, account? }. In a room that hasn't
    // enrolled a re-minted session key yet, the previous key keeps signing.
    this.local = new Proxy(participants, {
      get: (t, name) => {
        const p = t[name]
        if (!p || typeof name !== 'string' || !p.previous) return p
        const s = this.state
        if (!s || s.isActive(p.signer.ref) || !s.isActive(p.previous.ref)) return p
        return { ...p, signer: p.previous }
      }
    })
    this.pending = store.readJSON('pending.json', [])
    this.presence = new Map() // deviceRef -> { ts, participants: [{ name, state }] }
    this.agentState = new Map() // name -> 'idle' | 'thinking' | ...
    // name -> Set of record ids it chose not to answer; kept on disk so a restart doesn't re-offer them
    this.passed = new Map(Object.entries(store.readJSON('passed.json', {})).map(([n, ids]) => [n, new Set(ids)]))
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
    this.timer = setInterval(() => { this.#healSockets(); this.#sendPresence(); this.#deafCheck() }, PRESENCE_EVERY)
    this.timer.unref()
    // anti-entropy: even if a live message is lost, everything converges
    this.syncTimer = setInterval(() => this.#hello(), SYNC_EVERY)
    this.syncTimer.unref()
    if (this.isOwner) await this.#syncWhitelist()
    this.applyRename()
    this.startedAt = Date.now()
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

  // Live transport view: how many swarm connections we hold to members of this room.
  connections () {
    const swarm = this.core.managers.connection.swarmInstance
    if (!swarm || !this.state) return 0
    let n = 0
    for (const c of swarm.connections) {
      if (c.destroyed || !c.remotePublicKey) continue
      if (this.state.can(edRef(Buffer.from(c.remotePublicKey).toString('hex')), SCOPES.host)) n++
    }
    return n
  }

  // A daemon can come up looking healthy and never hear the room again (seen
  // on the Mini: 17 minutes of silence after a peer restarted). If others are
  // expected but nothing has arrived for a while and we hold no connections,
  // refresh discovery so Hyperswarm looks for them again.
  #deafCheck () {
    const others = this.members().some((m) => m.status === 'active' && m.scope.includes(SCOPES.host) && m.ref !== this.device.ref)
    if (!others) return
    const quiet = Date.now() - (this.lastRx ?? this.startedAt ?? 0)
    if (quiet < 3 * PRESENCE_STALE || this.connections() > 0) return
    if (this.lastRefresh && Date.now() - this.lastRefresh < 2 * PRESENCE_STALE) return
    this.lastRefresh = Date.now()
    console.error(`[${this.cfg.name}] no traffic for ${Math.round(quiet / 1000)}s and no connections: refreshing discovery`)
    try {
      const cm = this.core.managers.connection
      const d = cm.discoveryMap?.[this.topic]
      if (d?.refresh) d.refresh({ server: true, client: true }).catch(() => {})
      else cm.join(this.topic).catch?.(() => {})
    } catch (err) { console.error('[deaf-check]', err.message) }
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
    return s.members().filter((m) => m.depth > 0).map((m) => ({ ...m, name: nameOf(m.label), device: deviceOf(m.label) }))
  }

  participantsList () {
    const now = Date.now()
    const online = new Set()
    for (const p of this.presence.values()) {
      if (now - p.ts < PRESENCE_STALE) p.participants.forEach((x) => online.add(x.name))
    }
    Object.keys(this.local).forEach((n) => online.add(n))
    // one row per account: its root and its device/session keys share a name
    const byName = new Map()
    for (const m of this.members()) {
      if (!m.scope.includes(SCOPES.chat)) continue
      const row = byName.get(m.name) ?? { name: m.name, ref: m.ref, status: 'revoked', role: m.scope.includes(SCOPES.admin) ? 'human' : 'agent', keys: [], devices: [], local: !!this.local[m.name], online: online.has(m.name), state: this.#stateOf(m.name), busy: this.#recentActivity(m.name) }
      row.keys.push({ ref: m.ref, device: m.device, status: m.status, reason: m.reason, parent: m.parent, account: !m.device && m.scope.includes('delegate') })
      if (m.status === 'active') { row.status = 'active'; if (m.device && !row.devices.includes(m.device)) row.devices.push(m.device) }
      if (!m.device) row.ref = m.ref // the account root, if there is one
      byName.set(m.name, row)
    }
    return [...byName.values()]
  }

  #stateOf (name) { return this.agentState.get(name) ?? this.#remoteState(name) ?? 'idle' }

  // an agent that reported activity in the last while is working, even between turns
  #recentActivity (name) {
    const a = this.store.activity
    for (let i = a.length - 1; i >= 0 && i >= a.length - 200; i--) {
      if (a[i].ts < Date.now() - 90_000) return null
      if (this.view(a[i]).name === name) return a[i].text
    }
    return null
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
    return { ...rec, name: node ? nameOf(node.label) : rec.author.slice(0, 16), device: node ? deviceOf(node.label) : '', human: scope.includes(SCOPES.admin) }
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
    this.lastRx = Date.now()
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
          this.#busyTick()
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

  // presence rows change when activity starts and when it goes quiet
  #busyTick () {
    this.emit('changed')
    clearTimeout(this.busyTimer)
    this.busyTimer = setTimeout(() => this.emit('changed'), 95_000)
    this.busyTimer.unref?.()
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
    const taken = new Set(this.members().filter((m) => m.status !== 'revoked' && !m.device).map((m) => m.name))
    const ops = []
    const d = request.device
    // a device already in the room may roll its keys under the same names; a new device may not take a name in use
    const rolling = !!(d && this.state.isActive(d.ref))
    if (d && !this.state.isActive(d.ref) && !this.#burned(d.ref)) {
      ops.push(await enroll(this.rootSigner, { root, key: d.ref, consent: d.consent, consentAfter: d.after, scope: ['bind', SCOPES.host], label: `device:${d.name}` }))
    }
    for (const p of request.participants ?? []) {
      if (this.state.isActive(p.ref)) continue
      if (this.#burned(p.ref)) continue // compromised or banned keys stay out; the rest of the request still counts
      const name = String(p.name).toLowerCase()
      const role = p.role === 'human' ? SCOPES.admin : SCOPES.agent
      // the owner's own name arriving from another device is the owner's device: a key under
      // the owner's root, not a second account (that's how a phone becomes "you")
      const ownDevice = p.role === 'human' && this.local[name]?.role === 'human'
      const a = ownDevice ? null : p.account
      if (a && a.ref !== root) {
        // an account root: same account joining from another device is fine, a different account with a taken name is not
        const existing = this.state.get(a.ref)
        if (!existing && taken.has(name) && !rolling) throw new Error(`name already in use: ${name}`)
        if (existing?.revoked && this.#burned(a.ref)) continue
        if (!existing || existing.revoked) ops.push(await enroll(this.rootSigner, { root, key: a.ref, consent: a.consent, consentAfter: a.after, scope: ['bind', SCOPES.chat, role, 'delegate'], label: name }))
        if (a.enroll?.key === p.ref) ops.push(a.enroll) // the account enrolls its own session key (signed by it)
      } else {
        // a key under this room's own root: another device of the owner (label name@device), or a legacy key
        if (!ownDevice && a?.ref !== root && taken.has(name) && !rolling) throw new Error(`name already in use: ${name}`)
        ops.push(await enroll(this.rootSigner, { root, key: p.ref, consent: p.consent, consentAfter: p.after, scope: ['bind', SCOPES.chat, role], label: d?.name ? `${name}@${d.name}` : name }))
      }
      taken.add(name)
    }
    for (const op of ops) await this.chain.append(op, this.rootSigner)
    this.#chainChanged()
    return ops.length
  }

  // Bring a revoked account back: re-enroll its root with the consent it gave
  // before, then replay the enrollments it signed for its own session keys.
  async readopt (ref) {
    if (!this.isOwner) throw new Error('only the room owner can re-adopt')
    const root = this.chain.root
    const last = this.chain.entries.findLast((x) => x.op?.t === 'enroll' && x.op.key === ref)?.op
    if (!last) throw new Error('no enrollment on record for that key')
    const ops = []
    const node = this.state.get(ref)
    if (node?.revoked) {
      // a revoked key stays revoked (rKey); its orphaned children can be adopted under us directly
      const seen = new Set()
      for (const e of this.chain.entries) {
        const op = e.op
        if (op?.t !== 'enroll' || op.parent !== ref || seen.has(op.key)) continue
        seen.add(op.key)
        const child = this.state.get(op.key)
        if (child?.revoked || this.state.isActive(op.key)) continue
        ops.push(await enroll(this.rootSigner, { root, key: op.key, consent: op.consent, scope: op.scope.filter((s) => s !== 'delegate'), label: op.label }))
      }
      if (!ops.length) throw new Error('that key is revoked and has nothing to bring back')
    } else {
      ops.push(await enroll(this.rootSigner, { root, key: ref, consent: last.consent, scope: last.scope, label: last.label }))
      const seen = new Set()
      for (const e of this.chain.entries) {
        const op = e.op
        if (op?.t === 'enroll' && op.parent === ref && !seen.has(op.key)) { seen.add(op.key); ops.push(op) }
      }
    }
    for (const op of ops) await this.chain.append(op, this.rootSigner)
    this.#chainChanged()
    return ops.length
  }

  // compromised: never back. banned: not until the owner lifts it.
  #burned (ref) { const r = this.state?.get(ref)?.revoked; return !!r && (r.reason === 'compromised' || r.reason === 'banned') }

  async revoke (ref, reason = 'removed') {
    if (!this.isOwner) throw new Error('only the room owner can revoke others')
    await this.chain.append(await revoke(this.rootSigner, { root: this.chain.root, key: ref, reason }), this.rootSigner)
    this.#chainChanged()
  }

  // A device whose every account in this room is gone must go too, or it keeps
  // reading: pearcore's read whitelist is the room's active host keys. Devices are
  // matched to accounts by the name@device labels and by what each device announced.
  async pruneDevices (reason = 'removed') {
    if (!this.isOwner) return 0
    const s = this.state
    const members = this.members()
    const activeChat = members.filter((m) => m.status === 'active' && m.scope.includes(SCOPES.chat) && !m.label?.startsWith('device:'))
    const hostedOn = new Map() // device name -> count of active accounts there
    for (const m of activeChat) if (m.device) hostedOn.set(m.device, (hostedOn.get(m.device) ?? 0) + 1)
    for (const [deviceRef, p] of this.presence) {
      for (const x of p.participants ?? []) if (activeChat.some((m) => m.name === x.name)) hostedOn.set(`ref:${deviceRef}`, (hostedOn.get(`ref:${deviceRef}`) ?? 0) + 1)
    }
    let n = 0
    for (const d of members.filter((m) => m.status === 'active' && m.label?.startsWith('device:') && m.ref !== this.device.ref)) {
      const name = d.label.slice(7)
      if (hostedOn.get(name) || hostedOn.get(`ref:${d.ref}`)) continue
      // legacy keys without a device label: keep the device if it announced them recently
      if (!activeChat.some((m) => m.device) && this.presence.has(d.ref)) continue
      await this.chain.append(await revoke(this.rootSigner, { root: this.chain.root, key: d.ref, reason }), this.rootSigner)
      n++
    }
    if (n) this.#chainChanged()
    return n
  }

  async unban (ref) {
    if (!this.isOwner) throw new Error('only the room owner can lift a ban')
    await this.chain.append(await unban(this.rootSigner, { root: this.chain.root, key: ref }), this.rootSigner)
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
    this.#busyTick()
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
    let c = { text: '', order: [], agents: {} }
    for (const r of this.store.ordered) if (r.kind === 'control' && r.action === 'charter') c = { text: r.text ?? '', order: r.order ?? [], agents: r.agents ?? {} }
    return c
  }

  // This agent's rule in this room: { role, wake: 'order' | 'mention' | 'backup', backupFor }
  ruleFor (name) {
    const r = this.charter().agents?.[name] ?? {}
    return { role: r.role ?? '', wake: r.wake ?? 'order', backupFor: r.backupFor ?? null }
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
    let root
    try {
      const entry = await browser.addFile(`chat/${name}`, localPath)
      root = await new Promise((resolve, reject) => {
        entry.onError(reject)
        entry.onComplete(() => resolve(entry.rootHash))
      })
    } catch (err) {
      // the same file on disk was shared before: reuse our existing record
      const me = this.device.ref.slice(8)
      const variants = this.core.managers.spaceFileList.get(this.topic)[path] ?? {}
      root = Object.entries(variants).find(([, v]) => v.peers?.[me])?.[0]
      if (!root) throw err
    }
    if (!root) throw new Error('indexing produced no root')
    this.store.rememberFile(root, localPath)
    return { kind: 'file', hash: root, name, path, size: st.size, mime: mimeOf(name) }
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
      this.emit('file-progress', { hash: att.hash, percent: 0 })
      const onProgress = () => { const p = task.getProgress?.()?.percent; if (typeof p === 'number') this.emit('file-progress', { hash: att.hash, percent: p }) }
      task.onProgress?.(onProgress)
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('download timed out')), 6 * 3600_000); t.unref()
          task.onComplete(() => { clearTimeout(t); resolve() })
        })
      } finally { task.offProgress?.(onProgress) }
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
    const e = this.chain?.entries.findLast((x) => x.op?.t === 'enroll' && nameOf(x.op.label) === name && !x.op.label.startsWith('device:') && s.isActive(x.op.key))
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
    const byId = new Map(log.map((r) => [r.id, r]))
    const mine = log.slice(lastOwn + 1).filter((r) => addressedTo(r, name, byId) && !answered.has(r.id) && !passed.has(r.id))
    const direct = (t) => t.mentions.includes(name) || (t.human && t.re?.length > 0) // named, or a reply to this agent
    const rule = this.ruleFor(name)
    const now = Date.now()
    // mentioned only: the open floor never wakes this agent
    if (rule.wake === 'mention') return mine.filter(direct)
    // backup for X: direct mentions as usual; otherwise only what X was due to answer
    // and hasn't, one window after X's own slot (or one window flat if X is offline)
    if (rule.wake === 'backup' && rule.backupFor && rule.backupFor !== name) {
      const x = rule.backupFor
      const xOnline = this.participantsList().some((p) => p.name === x && p.online)
      const xAnswered = new Set(log.filter((r) => r.name === x).flatMap((r) => r.re ?? []))
      const xClaimed = (t) => this.store.activity.some((a) => a.ts >= t.ts && Array.isArray(a.claim) && a.claim.includes(t.id) && this.view(a).name === x)
      const xSlot = Math.max(0, this.charter().order.indexOf(x)) * TURN_WINDOW
      const forX = log.slice(lastOwn + 1).filter((r) => addressedTo(r, x, byId) && !xAnswered.has(r.id) && !passed.has(r.id) && !direct(r))
      const out = mine.filter(direct)
      for (const t of forX) {
        if (xClaimed(t)) continue
        const dueAt = t.ts + (xOnline ? xSlot + 2 * TURN_WINDOW : TURN_WINDOW)
        if (now < dueAt) { this.#pokeAt(dueAt); continue }
        if (!out.includes(t)) out.push(t)
      }
      return out.sort((a, b) => a.ts - b.ts)
    }
    // turn order: a message that names nobody goes to the first agent in the
    // charter's list; the next in line waits one window, then takes it unless
    // an earlier agent has claimed or answered it. Mentions bypass the order.
    // a paused agent is out of the line, not a 45 s hole in it
    const pausedAgents = new Set(this.budget().agents?.paused ?? [])
    const order = this.charter().order.filter((n) => this.ruleFor(n).wake === 'order' && !pausedAgents.has(n))
    const i = order.indexOf(name)
    if (i <= 0) return mine
    const earlier = new Set(order.slice(0, i))
    const taken = (t) => log.some((r) => r.kind === 'msg' && earlier.has(r.name) && (r.re ?? []).includes(t.id)) ||
      this.store.activity.some((a) => a.ts >= t.ts && Array.isArray(a.claim) && a.claim.includes(t.id) && earlier.has(this.view(a).name))
    return mine.filter((t) => {
      if (!t.human || t.mentions.length) return true
      if (taken(t)) { if (!this.passed.has(name)) this.passed.set(name, new Set()); this.passed.get(name).add(t.id); this.#savePassed(); return false }
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
    this.#savePassed()
    this.emit('changed')
  }

  #savePassed () {
    const out = {}
    for (const [n, ids] of this.passed) out[n] = [...ids].slice(-500)
    try { this.store.writeJSON('passed.json', out) } catch {}
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
// A join request carries this device, and each participant with its account:
// the account root's consent to the room, plus the account's own enrollment
// of the session key (pre-signed; the owner appends it after enrolling the root).
// `state` (the room's current key state, if this device has it) lets a key that
// was removed earlier anchor its consent to that revocation, which is what lets
// it back in.
export async function joinRequest ({ root, deviceName, device, participants, state = null }) {
  const after = (ref) => state?.get(ref)?.revoked?.sig
  const fresh = async (signer) => { const a = after(signer.ref); return { consent: await consent(signer, root, a ? { after: a } : {}), after: a } }
  const dev = await fresh(device)
  return {
    device: { ref: device.ref, name: deviceName, consent: dev.consent, after: dev.after },
    participants: await Promise.all(Object.entries(participants).map(async ([name, p]) => {
      const c = await fresh(p.signer)
      const out = { ref: p.signer.ref, name, role: p.role, consent: c.consent, after: c.after }
      if (p.account && p.account.ref !== p.signer.ref) {
        const role = p.role === 'human' ? SCOPES.admin : SCOPES.agent
        const ac = await fresh(p.account)
        out.account = {
          ref: p.account.ref,
          consent: ac.consent,
          after: ac.after,
          enroll: await enroll(p.account, { root, key: p.signer.ref, consent: out.consent, consentAfter: c.after, scope: ['bind', SCOPES.chat, role], label: `${name}@${deviceName}` })
        }
      }
      return out
    }))
  }
}

export const nameOf = (label = '') => String(label).split('@')[0]
export const deviceOf = (label = '') => String(label).split('@')[1] ?? ''
