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
import { SCOPES, MAIN, isConvId, newConvId, APP_ROLES, ASK_CHOICES, envelope, isOurs, makeMessage, makeControl, makeActivity, makeReaction, makeRedaction, makeInvite, makeAsk, verifyRecord, parseMentions } from './proto.js'
import { budget, addressedTo, replyDepth } from './turns.js'
import { windowOf } from './feed-window.js'
import { RoomSearch } from './search.js'
import { imageSize } from './image-size.js'
import { cleanGrantRule, describeRule } from './grants.js'

// record kinds the chat feed never shows as lines of their own (reactions and removals are applied to the
// messages they point at; invites are addressed to one device)
export const FEED_SKIP = ['react', 'redact', 'invite']
// controls only the owner's own keys may write (see #admits); 'close' ends the room for everyone
export const ACCOUNT_GATED = ['project', 'home', 'seat', 'auto', 'watch', 'close', 'answer', 'grant']

const edRef = (hex) => `ed25519:${hex}`
const PRESENCE_EVERY = 20_000
const PRESENCE_STALE = 60_000
const DEBUG = !!process.env.RKEYCHAT_DEBUG
const SYNC_EVERY = 60_000
const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', css: 'text/css', zip: 'application/zip' }
export const mimeOf = (name) => MIMES[extname(String(name)).slice(1).toLowerCase()] ?? 'application/octet-stream'
export const TURN_WINDOW = 45_000 // how long the next agent in line waits before taking an unclaimed turn
export const MAX_BLOB = 8 * 1024 * 1024 // one pearcore message; ~40 min of voice
const FILE_LIMIT = 60 * 60_000 // the most a fetch may take
const FILE_STALL = 90_000 // a fetch with nothing arriving for this long is given up and said so
const FILE_LIST_WAIT = 20_000 // how long a fetch waits for the space's listing to show the file
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
    this.agentConv = new Map() // name -> the conversation its current/last turn was in
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

  stop () { clearInterval(this.timer); clearInterval(this.syncTimer); this._search?.close() }

  // this room's message search (search.js); its index opens on the first search, not at startup
  get search () { return (this._search ??= new RoomSearch(this)) }

  // Search results as the page shows them: newest first, with who wrote each.
  find (q, opts) {
    return this.search.find(q, opts).map((r) => { const rec = this.store.get(r.id); return { ...r, name: this.view(rec).name, conv: this.store.convOf(rec) } })
  }

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

  // The seats as their hosts last described them: the newest `applied` 'seat' control per agent. This is how a
  // device that hosts no seat (a phone) knows a bot's mode, model and provider, and which providers its host has.
  // Only active agents count; a stale control for a seat that left the room is dropped.
  seatsFromLog () {
    const active = new Set(this.participantsList().filter((p) => p.role === 'agent' && p.status === 'active').map((p) => p.name))
    const out = new Map()
    for (const r of this.store.ordered) {
      if (r.kind !== 'control' || r.action !== 'seat' || !r.agent || !r.seat?.applied || !active.has(r.agent)) continue
      const s = r.seat
      out.set(r.agent, { name: r.agent, bridge: 'claude', via: s.via ?? 'acp', dir: s.dir ?? null, permissionMode: s.permissionMode ?? 'acceptEdits', auto: s.permissionMode === 'auto' ? (s.auto ?? null) : null, model: s.model ?? null, provider: s.provider ?? null, askMinutes: s.askMinutes ?? null, providers: s.providers ?? [], remote: true, ts: r.ts })
    }
    return [...out.values()]
  }

  // The room's cap on Auto: the newest 'auto' control (account-gated) as { minutes, turns }, or null when there is
  // none or both were emptied. A seat's own grant is clamped to it by its host (src/seat-settings.js autoState).
  autoCap () {
    let cap = null
    for (const r of this.store.ordered) {
      if (r.kind !== 'control' || r.action !== 'auto') continue
      const a = r.auto ?? {}
      cap = a.minutes == null && a.turns == null ? null : { minutes: a.minutes ?? null, turns: a.turns ?? null }
    }
    return cap
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
    // `name` becomes the author's display name, which collides with a rename
    // control's own `name` (the room's new one). Keep that where a reader can
    // still find it, or a rename renders as "guy · rename" and says nothing.
    const roomName = rec.kind === 'control' && rec.action === 'rename' ? rec.name : undefined
    return { ...rec, name: node ? nameOf(node.label) : rec.author.slice(0, 16), device: node ? deviceOf(node.label) : '', human: scope.includes(SCOPES.admin), conv: this.store.convOf(rec), ...(roomName ? { roomName } : {}) }
  }

  // What admins removed: message ids and blocked content hashes.
  blocked () {
    const ids = new Map(); const hashes = new Set()
    for (const r of this.store.ordered) {
      if (r.kind !== 'redact') continue
      if (r.target) ids.set(r.target, r)
      for (const h of r.hashes ?? []) hashes.add(h)
      for (const h of r.unblock ?? []) hashes.delete(h) // applied in order, so a later lift wins
    }
    return { ids, hashes }
  }

  // The room's log as agents and the budget read it. With `conv`, one conversation's: its messages plus the
  // room-wide controls (store.inConv). Without, everything, as before conversations existed.
  log (conv) {
    const { ids } = this.blocked()
    return (conv ? this.store.inConv(conv) : this.store.ordered).map((r) => this.#viewLogged(r, ids))
  }

  // One window of what the feed shows (see feed-window.js): { log, hasOlder, hasNewer }, or null when the
  // named message is not in this room. Decorates only the records it returns. With `conv`, that conversation's
  // feed; the notes that describe conversations and the app ('conv'/'app' controls) are never feed lines.
  page ({ before, after, around, limit, conv } = {}, skip = FEED_SKIP) {
    const all = conv ? this.store.inConv(conv) : this.store.ordered
    const list = all.filter((r) => !skip.includes(r.kind) && !(r.kind === 'control' && (r.action === 'conv' || r.action === 'app')))
    const w = windowOf(list, { before, after, around, limit })
    if (!w) return null
    const { ids } = this.blocked()
    return { log: list.slice(w.start, w.end).map((r) => this.decorate(this.#viewLogged(r, ids), ids)), hasOlder: w.hasOlder, hasNewer: w.hasNewer }
  }

  // ---------- conversations ----------

  // Every conversation of this room, from the signed 'conv' notes and the messages: the default one
  // (MAIN, "General" unless renamed) first, then the rest in the order they were made. Each:
  // { conv, title, created, archived, runtime, last, count, busy }. Archived ones are included, flagged.
  conversations () {
    const out = new Map()
    const ensure = (conv, ts) => {
      let c = out.get(conv)
      if (!c) { c = { conv, title: conv === MAIN ? 'General' : 'New conversation', created: ts, archived: false, runtime: null, last: null, count: 0, busy: [] }; out.set(conv, c) }
      return c
    }
    ensure(MAIN, this.store.ordered[0]?.ts ?? Date.now())
    const { ids } = this.blocked()
    for (const r of this.store.ordered) {
      if (r.kind === 'control' && r.action === 'conv' && isConvId(r.conv)) {
        const c = ensure(r.conv, r.ts)
        if (r.text !== undefined && String(r.text).trim()) c.title = String(r.text).trim().slice(0, 120)
        if (r.archived !== undefined) c.archived = !!r.archived
        if (r.runtime !== undefined) c.runtime = r.runtime
        continue
      }
      if (r.kind !== 'msg' || ids.has(r.id)) continue
      const c = ensure(this.store.convOf(r), r.ts)
      c.count++
      const v = this.view(r)
      c.last = { ts: r.ts, name: v.name, text: r.text || (r.att?.some((a) => a.kind === 'file') ? `File: ${r.att.find((a) => a.kind === 'file').name}` : r.att?.length ? 'Voice memo' : '') }
    }
    for (const [name, conv] of this.agentConv) if (out.has(conv) && this.agentState.get(name) === 'thinking') out.get(conv).busy.push(name)
    return [...out.values()]
  }

  conversation (conv) { return this.conversations().find((c) => c.conv === conv) ?? null }

  // Which app this room belongs to and what it is to that app, from the latest signed 'app' note:
  // { app, role, name, icon } or null. (PearDrive files the space under that app.)
  appInfo () {
    let a = null
    for (const r of this.store.ordered) {
      if (r.kind !== 'control' || r.action !== 'app' || !r.app) continue
      // each note carries what it says; what it leaves out stays as it was (an 'org' change does not forget the home)
      a = { app: r.app, role: APP_ROLES.includes(r.role) ? r.role : (a?.role ?? 'chat'), name: r.name ?? a?.name ?? this.cfg.name, home: r.home !== undefined ? r.home : (a?.home ?? null), org: r.org !== undefined ? r.org : (a?.org ?? null), request: r.request !== undefined ? r.request : (a?.request ?? null), ...(r.icon ? { icon: r.icon } : a?.icon ? { icon: a.icon } : {}) }
    }
    return a
  }

  // The 'project' requests carried by this room (docs/projects-home-and-sync.md §1), oldest first. Each passed
  // the account gate, so each was signed by one of the owner's own devices.
  projectRequests () { return this.store.ordered.filter((r) => r.kind === 'control' && r.action === 'project') }

  // Has the owner closed this room? (A 'close' control; only the owner's keys pass the gate for it.)
  closed () { return this.store.ordered.some((r) => r.kind === 'control' && r.action === 'close') }

  // The device a project's folder lives on (docs/projects-home-and-sync.md §1), or null for a chat.
  home () { return this.appInfo()?.home ?? null }
  get isHome () { return !!this.device && this.home()?.device === this.device.ref }

  // What a feed line needs from outside the window the page holds: the preview of the message a reply answers
  // (withQuote), and for a rename or a settings change, what it changed from (withBefore).
  decorate (v, ids = this.blocked().ids) { return this.withBefore(this.withQuote(v, ids)) }

  // A rename carries the room's name before it (`was`), and a settings change the settings before it
  // (`before`: { text, order, agents }), so the line can say what moved even when the earlier one is far
  // outside the window. Absent when there was no earlier one ("named this room", "set who answers first").
  withBefore (v) {
    if (v?.kind !== 'control' || (v.action !== 'rename' && v.action !== 'charter')) return v
    const all = this.store.ordered
    let i = all.findIndex((r) => r.id === v.id)
    while (--i >= 0) {
      const r = all[i]
      if (r.kind !== 'control' || r.action !== v.action) continue
      if (v.action === 'rename' && r.name) return { ...v, was: r.name }
      if (v.action === 'charter') return { ...v, before: { text: r.text ?? '', order: r.order ?? [], agents: r.agents ?? {} } }
    }
    return v
  }

  // When `name` last posted before the message `id` (the thinking overlay's look-back), or null.
  previousBy (id, name) {
    const all = this.store.ordered
    let i = all.findIndex((r) => r.id === id)
    while (--i >= 0) if (all[i].kind === 'msg' && this.view(all[i]).name === name) return all[i].ts
    return null
  }

  // A reply carries a short summary of the message it answers (`q`), so the page can show the quote even when
  // that message is outside the window it holds. `v` is a decorated record; returns it, with `q` when it has one.
  withQuote (v, ids = this.blocked().ids) {
    const id = v?.re?.[0]
    const r = id && this.store.get(id)
    if (!r) return v
    const q = this.view(r)
    const file = q.att?.find((a) => a.kind === 'file')
    const text = ids.has(r.id) ? '(removed)' : q.text || (file ? `File: ${file.name}` : q.att?.length ? 'Voice memo' : '')
    return { ...v, q: { id: r.id, name: q.name, text: text.slice(0, 160) } }
  }

  // The newest message that was not removed, as log() would show it, or null. With `conv`, in that conversation.
  lastMessage (conv) {
    const { ids } = this.blocked()
    const all = this.store.ordered
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].kind === 'msg' && !ids.has(all[i].id) && (!conv || this.store.convOf(all[i]) === conv)) return this.view(all[i])
    }
    return null
  }

  #viewLogged (r, ids) {
    const v = this.view(r)
    const red = ids.get(r.id)
    if (!red || r.kind !== 'msg') return v
    return { ...v, text: '', att: undefined, mentions: [], redacted: { by: this.view(red).name, ts: red.ts } }
  }

  // The round budget: room-wide controls, and the human reset counted inside one conversation when given.
  budget (conv) { return budget(this.log(conv)) }

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
    // Account-gated controls (docs/projects-home-and-sync.md §4): making a project on a device, moving its home,
    // starting or configuring a seat, connecting a folder. Only the room owner's own keys may say so: the root,
    // or a key enrolled directly under it (the owner's devices). An admin member is not enough.
    if (rec.kind === 'control' && ACCOUNT_GATED.includes(rec.action) && !this.isOwnerKey(rec.author)) return false
    // an answer names an ask this room holds, with one of the known choices; the first admitted answer wins
    if (rec.kind === 'control' && rec.action === 'answer') {
      const a = this.store.get(rec.ask)
      if (!a || a.kind !== 'ask' || !ASK_CHOICES.includes(rec.choice)) return false
    }
    // a hash the room removed can't come back in a new message
    if (rec.kind === 'msg' && (rec.att ?? []).some((a) => this.blocked().hashes.has(a.hash))) return false
    return true
  }

  // ---------- ingest ----------

  // A record handed in from outside the space transport (a test, another carrier): taken exactly as a peer's
  // would be. Returns 'ok' or why it was refused.
  receive (rec) {
    const why = this.#admitReason(rec)
    if (why === 'ok') this.#ingest(rec)
    return why
  }

  async #onSpaceMessage ({ message, content }) {
    if (message.topic !== this.topic || !isOurs(content)) return
    this.lastRx = Date.now()
    const fromDevice = edRef(message.publicKey)
    if (DEBUG) console.error('[rx]', content.type, 'from', message.publicKey.slice(0, 8), content.rec ? `${content.rec.kind} ${this.#admitReason(content.rec)}` : '')
    switch (content.type) {
      case 'rec':
        return this.#ingest(content.rec)
      case 'hist-res': {
        // a catch-up batch (after a reconnect, a restart, a suspended phone): stored quietly (no wake-ups, no
        // per-record pushes), then one 'caught-up' so a page holding this room's threads loads them again
        let added = 0
        for (const r of content.records ?? []) if (this.#ingest(r, { quiet: true })) added++
        if (added) {
          if (DEBUG) console.error(`[${this.cfg.name}] caught up ${added} record(s)`)
          this.emit('caught-up', { added })
        }
        return this.emit('changed')
      }
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
    // the owner ended the room: whoever holds it drops it (the daemon listens)
    if (rec.kind === 'control' && rec.action === 'close') this.emit('closed', this.view(rec))
    // a person answered an agent's ask: the waiting runner hears it (awaitAnswer)
    if (rec.kind === 'control' && rec.action === 'answer') this.emit('answer', this.view(rec))
    // one of the owner's devices changed a seat's settings (or its host said how it now runs): the host applies it
    if (rec.kind === 'control' && rec.action === 'seat' && rec.agent) this.emit('seat', this.view(rec))
    // a debug note shared from another device (a phone, mostly): fetch its files now, while that device is
    // awake, so a helper can read them later from here. Phones don't; they're the ones sleeping.
    if (!quiet && rec.kind === 'msg' && rec.via === 'note' && typeof Bare === 'undefined') {
      for (const a of rec.att ?? []) if (a.kind === 'file' && !this.localFile(a.hash)) setTimeout(() => this.fetchFile(a).catch(() => {}), 1500)
    }
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
  // `asOwner`: this request is the owner's own device logging in (the login handover, or the owner enrolling
  // their other devices), so a human named like the owner is the owner's device. Any other path (an invite to a
  // room, a pasted request code) may not take the owner's name: audit 2026-11-15, H1 — before this, any invite
  // let a stranger's daemon ask for { name: 'guy', role: 'human' } and be enrolled as the owner with admin.
  async approve (request, { asOwner = false } = {}) {
    if (!this.isOwner) throw new Error('only the room owner can approve')
    const root = this.chain.root
    const taken = new Set(this.members().filter((m) => m.status !== 'revoked' && !m.device).map((m) => m.name))
    const ops = []
    const d = request.device
    // a device already in the room may roll its keys under the names it already holds here, and only those
    // (audit H1, second door: "rolling" used to lift the name check for every name)
    const held = new Set(d && this.state.isActive(d.ref) ? this.members().filter((m) => m.status !== 'revoked' && m.device === d.name).map((m) => m.name) : [])
    const rolling = (name) => held.has(name)
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
      const ownDevice = asOwner && p.role === 'human' && this.local[name]?.role === 'human'
      if (!ownDevice && p.role === 'human' && this.local[name]?.role === 'human' && p.account?.ref !== root) throw new Error(`name already in use: ${name} (that is the owner; a device logs in as the owner through the login code, not a room invite)`)
      const a = ownDevice ? null : p.account
      if (a && a.ref !== root) {
        // an account root: same account joining from another device is fine, a different account with a taken name is not
        const existing = this.state.get(a.ref)
        if (!existing && taken.has(name) && !rolling(name)) throw new Error(`name already in use: ${name}`)
        if (existing?.revoked && this.#burned(a.ref)) continue
        if (!existing || existing.revoked) ops.push(await enroll(this.rootSigner, { root, key: a.ref, consent: a.consent, consentAfter: a.after, scope: ['bind', SCOPES.chat, role, 'delegate'], label: name }))
        if (a.enroll?.key === p.ref) ops.push(a.enroll) // the account enrolls its own session key (signed by it)
      } else {
        // a key under this room's own root: another device of the owner (label name@device), or a legacy key
        if (!ownDevice && a?.ref !== root && taken.has(name) && !rolling(name)) throw new Error(`name already in use: ${name}`)
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

  async activity (name, text, { claim, usage, conv } = {}) {
    const p = this.local[name]
    if (!p || !this.state?.can(p.signer.ref, SCOPES.chat)) return null
    const rec = await makeActivity(p.signer, { room: this.topic, text, claim, usage, conv })
    this.store.addActivity(rec)
    this.emit('activity', this.view(rec))
    this.#busyTick()
    await this.#send('act', { rec })
    return rec
  }

  // What each agent has actually spent, from the usage on its own activity records.
  // A wake is the unit: an agent pays for its whole context before it writes a word,
  // so this counts every token the runtime reported, not just output.
  spend (sinceMs = Date.now() - 24 * 3600_000) {
    const out = {}
    for (const r of this.store.activity) {
      const u = r.usage; if (!u) continue
      const name = this.view(r).name; if (!name) continue
      const e = out[name] ??= { wakes: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0, models: {} }
      if (r.ts < sinceMs) continue
      e.wakes++; e.in += u.in; e.out += u.out; e.cacheRead += u.cacheRead; e.cacheWrite += u.cacheWrite
      e.total += u.in + u.out + u.cacheRead + u.cacheWrite
      if (u.model) e.models[u.model] = (e.models[u.model] ?? 0) + 1
    }
    return out
  }

  // An agent is over budget when its measured day's spend passes the cap its room
  // rule sets. Over budget means not woken at all, so the next wake costs nothing,
  // which is the only control that actually stops the meter.
  overBudget (name) {
    const cap = Number(this.ruleFor(name).tokensPerDay) || 0
    if (!cap) return null
    const spent = this.spend()[name]?.total ?? 0
    return spent >= cap ? { cap, spent } : null
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

  async post (name, text, { re = [], via, att, conv } = {}) {
    const p = this.local[name]
    if (!p) throw new Error(`${name} is not hosted on this device`)
    text = String(text ?? '').trim()
    // a reply stays in the conversation of what it answers; otherwise the one asked for, else the default
    conv = conv || (re.length ? this.store.convOf(this.store.get(re[0])) : MAIN)
    if (!isConvId(conv)) throw new Error('not a conversation id')
    // signed statements are integer-only: durations in ms, peaks 0-100
    att = Array.isArray(att) && att.length
      ? att.slice(0, 4).map((a) => ({
          hash: String(a.hash),
          kind: a.kind === 'file' ? 'file' : undefined,
          name: a.kind === 'file' ? String(a.name).slice(0, 255) : undefined,
          path: a.kind === 'file' ? String(a.path).slice(0, 1024) : undefined,
          mime: String(a.mime ?? 'application/octet-stream'),
          size: Math.round(Number(a.size) || 0),
          w: a.kind === 'file' && Number(a.w) > 0 ? Math.round(Number(a.w)) : undefined,
          h: a.kind === 'file' && Number(a.h) > 0 ? Math.round(Number(a.h)) : undefined,
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
    const mirror = via === 'mirror' || via === 'note'
    const b = this.budget(conv)
    const depth = human || mirror ? 0 : triggers.length ? replyDepth(triggers) : b.used + 1
    if (!human && !mirror && !b.allows(depth, name)) throw new Error('not allowed to post right now (paused, limited, or out of rounds) — waiting for a human')
    const rec = await makeMessage(p.signer, {
      room: this.topic,
      text,
      mentions: parseMentions(text, this.names()),
      re: triggers.map((t) => t.id),
      depth,
      via: via === 'voice' || via === 'mirror' || via === 'note' ? via : undefined,
      att,
      conv
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
    return { role: r.role ?? '', wake: r.wake ?? 'order', backupFor: r.backupFor ?? null, tokensPerDay: Number(r.tokensPerDay) || 0 }
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
    const mime = mimeOf(name)
    // a picture says its shape, so a chat lays its gallery out before the bytes arrive (src/image-size.js)
    const dims = mime.startsWith('image/') ? imageSize(localPath) : null
    return { kind: 'file', hash: root, name, path, size: st.size, mime, ...(dims ? { w: dims.w, h: dims.h } : {}) }
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
      // the listing can lag the message by a few seconds on a device that just connected (the phone, 2026-11-25:
      // its first request for a picture came before the entry and the page gave up): wait a little for it
      let entry = await browser.getFile(att.path)
      const until = Date.now() + FILE_LIST_WAIT
      while (!(entry && entry.exists) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000))
        entry = await browser.getFile(att.path)
      }
      if (!entry || !entry.exists) throw new Error(`nobody online has this file right now (${this.connections().length} peer(s) connected)`)
      const dir = this.store.filePath(att.hash)
      fsSync.mkdirSync(dir, { recursive: true })
      const dest = `${dir}/${att.name}`
      const providers = this.providersOf(att)
      console.log(`[files] fetching ${att.name} (${att.size ?? '?'} B) from ${providers.length} provider(s): ${providers.map((p) => p.slice(0, 8)).join(', ') || 'nobody listed'}`)
      const task = await entry.download(att.hash, dest)
      this.emit('file-progress', { hash: att.hash, percent: 0 })
      const onProgress = () => { const p = task.getProgress?.()?.percent; if (typeof p === 'number') this.emit('file-progress', { hash: att.hash, percent: p }) }
      task.onProgress?.(onProgress)
      const started = Date.now()
      try {
        // a fetch that gets nothing says so (2026-11-25: the phone waited for ever on pictures the Mac never sent, and
        // nothing was logged): a peer's refusal, the task's own error, or no progress for FILE_STALL
        await new Promise((resolve, reject) => {
          let done = false
          const finish = (fn) => { if (done) return; done = true; clearInterval(tick); clearTimeout(t); fn() }
          const t = setTimeout(() => finish(() => reject(new Error(`download timed out after ${Math.round(FILE_LIMIT / 60000)} min`))), FILE_LIMIT); t.unref?.()
          let lastPct = -1; let lastMove = Date.now()
          const tick = setInterval(() => {
            const p = task.getProgress?.()?.percent
            if (typeof p === 'number' && p !== lastPct) { lastPct = p; lastMove = Date.now() }
            if (Date.now() - lastMove > FILE_STALL) finish(() => reject(new Error(`nothing arrived for ${Math.round(FILE_STALL / 1000)}s (${this.providersOf(att).length} provider(s) listed, ${this.connections().length} peer(s) connected)`)))
          }, 1000); tick.unref?.()
          task.onComplete(() => finish(resolve))
          task.onError?.((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
        })
      } catch (err) {
        try { await task.stop?.() } catch {}
        console.error(`[files] ${att.name}: ${err.message} (after ${Math.round((Date.now() - started) / 1000)}s)`)
        throw err
      } finally { task.offProgress?.(onProgress) }
      console.log(`[files] fetched ${att.name} in ${Math.round((Date.now() - started) / 1000)}s`)
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

  // Taking back something you posted is not the same act as banning a file from the
  // room. By default only the second blocks the attachment: withdrawing your own
  // message leaves its file shareable, because the usual reason is that the message
  // was wrong, not that the file is. `blockFiles` forces either way.
  async redact (name, target, reason, { blockFiles } = {}) {
    const p = this.local[name]
    if (!p || p.role !== 'human') throw new Error('only a person can remove messages')
    const msg = this.store.get(target)
    if (!msg || msg.kind !== 'msg') throw new Error('no such message')
    const mine = msg.author === p.signer.ref
    const block = blockFiles ?? !mine
    const hashes = block ? (msg.att ?? []).map((a) => a.hash) : []
    const rec = await makeRedaction(p.signer, { room: this.topic, target, hashes, reason })
    if (!this.#ingest(rec)) throw new Error('only the room\'s admins can remove messages')
    await this.#send('rec', { rec })
    return rec
  }

  // Lift a block put on a file earlier. Admin-only, like the block itself.
  async unblockFile (name, hash) {
    const p = this.local[name]
    if (!p || p.role !== 'human') throw new Error('only a person can unblock a file')
    const full = [...this.blocked().hashes].find((h) => h === hash || h.startsWith(hash))
    if (!full) throw new Error('that file is not blocked here')
    const rec = await makeRedaction(p.signer, { room: this.topic, target: '', unblock: [full], reason: 'unblock' })
    if (!this.#ingest(rec)) throw new Error('only the room\'s admins can unblock a file')
    await this.#send('rec', { rec })
    return { unblocked: full }
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
    for (const raw of this.store.ordered) {
      if (raw.kind !== 'react') continue
      const r = this.view(raw)
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

  // ---------- permissions asked of a person (docs/project-agents.md "Asking a person") ----------

  // An agent asks: a signed 'ask' record in the conversation. Returns the record, or null when the agent cannot
  // post here (no chat scope).
  async ask (name, { conv, tool, what, input, options, expires, rule, ruleLabel } = {}) {
    const p = this.local[name]
    if (!p || p.role !== 'agent' || !this.state?.can(p.signer.ref, SCOPES.chat)) return null
    const rec = await makeAsk(p.signer, { room: this.topic, conv, tool, what, input, options, expires, rule, ruleLabel })
    if (!this.#ingest(rec)) return null
    await this.#send('rec', { rec })
    return rec
  }

  // A person answers: a signed 'answer' control. Only the owner's own keys are admitted (ACCOUNT_GATED); on a
  // member's device the control is refused here and everywhere else, so the error is immediate.
  async answer (name, askId, choice) {
    if (!ASK_CHOICES.includes(choice)) throw new Error(`choice must be one of ${ASK_CHOICES.join(', ')}`)
    const a = this.store.get(askId)
    if (!a || a.kind !== 'ask') throw new Error('no such ask in this room')
    if (this.answerOf(askId)) throw new Error('already answered')
    const p = this.local[name]
    if (!p || p.role !== 'human') throw new Error('answers need a local human participant')
    if (!this.isOwnerKey(p.signer.ref)) throw new Error('only the owner\'s own devices may answer an agent\'s ask')
    return this.control(name, 'answer', { ask: askId, choice })
  }

  // What the owner let this project's agents do without asking (src/grants.js): every 'grant' control and every ask
  // answered "for this project" (allow_always on an ask that carried a rule), in order, a later withdrawal winning.
  // Each: { rule, label, by, ts, from: 'ask' | 'settings' }. `dir` is the project folder on this device: a rule that
  // would open a forbidden place there is dropped.
  grants (dir = null) {
    const out = new Map()
    const asks = new Map()
    for (const r of this.store.ordered) {
      if (r.kind === 'ask' && r.rule) asks.set(r.id, r)
      if (r.kind !== 'control') continue
      if (r.action === 'grant' && r.rule) {
        const rule = cleanGrantRule(r.rule, dir)
        if (!rule) continue
        if (r.revoke) out.delete(rule)
        else out.set(rule, { rule, label: describeRule(rule), by: this.view(r).name, ts: r.ts, from: 'settings' })
      } else if (r.action === 'answer' && r.choice === 'allow_always' && asks.has(r.ask)) {
        if (this.answerOf(r.ask)?.id !== r.id) continue // only the first answer counts
        const rule = cleanGrantRule(asks.get(r.ask).rule, dir)
        if (rule) out.set(rule, { rule, label: describeRule(rule), by: this.view(r).name, ts: r.ts, from: 'ask' })
      }
    }
    return [...out.values()]
  }

  // The owner grants a rule, or withdraws one (a signed, account-gated 'grant' control).
  async grant (name, rule, { revoke = false, dir = null } = {}) {
    const clean = cleanGrantRule(rule, dir)
    if (!clean) throw new Error('that cannot be granted (a folder no agent reads, the home folder, or a shell)')
    const p = this.local[name]
    if (!p || p.role !== 'human') throw new Error('grants need a local human participant')
    if (!this.isOwnerKey(p.signer.ref)) throw new Error("only the owner's own devices may grant")
    return this.control(name, 'grant', { rule: clean, revoke })
  }

  // The first admitted answer to an ask (viewed: name and device of who answered), or null.
  answerOf (askId) {
    for (const r of this.store.ordered) if (r.kind === 'control' && r.action === 'answer' && r.ask === askId) return this.view(r)
    return null
  }

  // Asks nobody has answered and that have not lapsed, viewed, oldest first; within one conversation when given.
  openAsks (conv, now = Date.now()) {
    return this.store.ordered
      .filter((r) => r.kind === 'ask' && (!conv || this.store.convOf(r) === conv) && r.expires > now && !this.answerOf(r.id))
      .map((r) => this.view(r))
  }

  // Wait for an answer to one ask: the one already there, or the next one admitted; null after `ms`.
  awaitAnswer (askId, ms = 10 * 60_000) {
    const have = this.answerOf(askId)
    if (have) return Promise.resolve(have)
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); this.off('answer', on); resolve(v) }
      const on = (a) => { if (a.ask === askId) done(a) }
      const t = setTimeout(() => done(null), ms); t.unref?.()
      this.on('answer', on)
    })
  }

  // Is this key the room owner's own: the root, or a key enrolled directly under it (one of the owner's devices)?
  isOwnerKey (ref) {
    const s = this.state
    if (!s || !this.chain) return false
    if (ref === this.chain.root) return true
    const n = s.get(ref)
    if (!n || n.parent !== this.chain.root || !s.isActive(ref)) return false
    const scope = s.scopeOf(ref)
    // a person on one of the owner's devices: admin, and not an account root of someone else (those carry delegate)
    return scope.includes(SCOPES.admin) && !scope.includes('delegate')
  }

  // Describe a conversation: a signed 'conv' note by a local human. Fields left undefined are unchanged.
  // `conv` absent: a new conversation (its id comes back in the record).
  async setConversation (name, { conv, title, archived, runtime } = {}) {
    conv = conv ?? newConvId()
    if (!isConvId(conv)) throw new Error('not a conversation id')
    const rec = await this.control(name, 'conv', { conv, text: title, archived, runtime })
    return this.conversation(conv) ?? { conv, title: title ?? 'New conversation', created: rec.ts, archived: !!archived, runtime: runtime ?? null, last: null, count: 0, busy: [] }
  }

  // Say which app this room belongs to and what it is to it (see proto.js 'app'). Owner-side, once per change.
  async setApp (name, { app = 'rkeychat', role, title, icon, home, org, request } = {}) {
    if (role !== undefined && !APP_ROLES.includes(role)) throw new Error(`role must be one of ${APP_ROLES.join(', ')}`)
    return this.control(name, 'app', { app, role, name: title, icon, home, org, request })
  }

  // The owner ends the room: a signed 'close' control. Every device that sees it takes the room off itself.
  async close (name) { return this.control(name, 'close') }

  // Ask one of the owner's devices to make a project (docs/projects-home-and-sync.md §1): a signed, account-gated
  // 'project' control carried by this room; the home device acts on it when it sees it.
  async requestProject (name, { title, home, prompt, org } = {}) {
    if (!home?.device) throw new Error('which device should hold the project?')
    return this.control(name, 'project', { name: title, home, text: prompt, org })
  }

  // The owner's devices as this room's chain knows them: [{ ref, name, online, here }]. A device is the owner's
  // when the owner's human key is enrolled on it (label name@device).
  ownDevices () {
    const s = this.state
    if (!s) return []
    const human = Object.entries(this.local).find(([, p]) => p.role === 'human')?.[0]
    const members = this.members().filter((m) => m.status !== 'revoked')
    const names = new Set(members.filter((m) => m.name === human && m.device).map((m) => m.device))
    const now = Date.now()
    return members.filter((m) => m.label?.startsWith('device:') && names.has(m.label.slice(7))).map((m) => {
      const p = this.presence.get(m.ref)
      // a device is online when its presence was heard lately; the window is wider than the room's own (a phone
      // asking about its Mac has often just reconnected and seen one presence, minutes old)
      return { ref: m.ref, name: m.label.slice(7), online: !!(p && now - p.ts < 5 * PRESENCE_STALE) || m.ref === this.device?.ref, here: m.ref === this.device?.ref }
    })
  }

  // Unanswered messages addressed to `name`, oldest first, since its last post. With `conv`, within that
  // conversation only: an agent's turn is one conversation at a time, and what it said elsewhere does not
  // count as having answered here.
  triggersFor (name, conv) {
    const log = this.log(conv)
    let lastOwn = -1
    log.forEach((r, i) => { if (r.kind === 'msg' && r.name === name) lastOwn = i })
    const answered = new Set(log.filter((r) => r.name === name).flatMap((r) => r.re ?? []))
    const passed = this.passed.get(name) ?? new Set()
    const byId = new Map(log.map((r) => [r.id, r]))
    const mine = log.slice(lastOwn + 1).filter((r) => addressedTo(r, name, byId) && !answered.has(r.id) && !passed.has(r.id))
    const direct = (t) => t.mentions.includes(name) || (t.human && t.re?.length > 0) // named, or a reply to this agent
    const rule = this.ruleFor(name)
    if (this.overBudget(name)) return [] // spent its allowance for the day: not woken, so it costs nothing
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

  // `conv`: where the agent is working right now (the conversation list shows who is thinking where).
  setAgentState (name, state, conv) {
    this.agentState.set(name, state)
    if (conv) this.agentConv.set(name, conv)
    this.emit('agent-state', { name, state, conv: conv ?? this.agentConv.get(name) ?? MAIN })
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
