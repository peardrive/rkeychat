// Boots pearcore for this device and runs every room it's in. Rooms can be
// created or joined while the daemon runs (GUI or CLI); no restart needed.

import { join, resolve, basename } from 'node:path'

// can this device hold project folders and run seats? (the phone runs on Bare: no)
const canHost = () => typeof Bare === 'undefined'

import { slug, requestsFor, requestOf, pendingProjectsOf } from './project-requests.js'
import { existsSync, readFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadSettings } from './glossary.js'
import { writeManifest } from './app-space.js'
import { EventEmitter } from 'node:events'
import { createCore } from 'pearcore/src/core.js'
import { Chain, generate, consent, enroll } from 'rkey'
import { loadConfig, saveConfig, dataDir, participantSigners, rootSigner, deviceSigner, migrate, addParticipant, readKeyFile } from './config.js'
import { RoomStore } from './store.js'
import { Room, joinRequest } from './room.js'
import { AgentRunner, askSettings } from './agents.js'
import { parseTools, resolveTools, describeTools } from './tools.js'
import { providerSettings, checkPermissionMode, checkModel, checkProviderName, checkBaseUrl, checkAutoLimit, describeProviders, describeRun, MODE_WORDS, PERMISSION_MODES } from './seat-settings.js'
import { serve, decodeInvite, encodeInvite } from './server.js'
import { SCOPES } from './proto.js'
import { Login } from './login.js'

const VIAS = ['cli', 'acp']
function checkVia (via) {
  via = String(via ?? 'cli').trim() || 'cli'
  if (!VIAS.includes(via)) throw new Error(`unknown via "${via}" (cli or acp)`)
  return via
}

async function openCore (cfg) {
  const core = await createCore({ rootPath: join(dataDir(), 'pearcore') })
  // pearcore (through c8633de) attaches its file-watcher handlers unbound, so the
  // first change to a shared file crashes the process. Bind them before it starts watching.
  const reg = core.managers?.spaceFiles?.localFileRegistry
  if (reg) for (const m of ['onChangeEvent', 'onDeleteEvent']) if (typeof reg[m] === 'function') reg[m] = reg[m].bind(reg)
  const accounts = await core.accounts.list()
  const { username, password } = cfg.pearcore
  if (!accounts.some((a) => a.username === username)) await core.accounts.create(username, password)
  const creds = await core.accounts.authenticate(username, password)
  return { core, device: deviceSigner(creds.secretKey) }
}

export class App extends EventEmitter {
  constructor ({ cfg, core, device }) {
    super()
    this.cfg = cfg
    this.core = core
    this.device = device
    this.rooms = new Map() // topic -> { room, runners: Map<name, AgentRunner> }
    this.inflight = new Set()
    if (Number(this.cfg.askMinutes) >= 1) askSettings.minutes = Number(this.cfg.askMinutes) // how long an agent's ask waits (docs/project-agents.md) // project request ids being made right now
    providerSettings.providers = this.cfg.providers ??= {} // where a seat's model is bought from (seat-settings.js)
    this.closing = new Set() // rooms this device is closing itself (their own 'close' must not re-enter removeRoom)
  }

  // the local person who signs controls here, if any
  get human () { return Object.entries(this.cfg.participants).find(([, p]) => p.role === 'human')?.[0] ?? null }

  // a seat whose key file is gone is left out (said once); `rkeychat room remove NAME` takes its room and it off for good
  get participants () {
    return participantSigners(this.cfg, {
      onLost: (name, keyFile) => {
        this.#lost ??= new Set()
        if (this.#lost.has(name)) return
        this.#lost.add(name)
        console.warn(`[${name}] its key file is gone (${keyFile}): the seat is left out until the folder is back, or remove it`)
      }
    })
  }
  #lost

  // The one identity root for this person. Every room they create hangs off it.
  // (Software key for now; a Satochip / Keycard signer drops in here later.)
  root () {
    if (!this.cfg.root) {
      const k = generate('bip340')
      this.cfg.root = { suite: 'bip340', secretKey: k.secretKey }
      saveConfig(this.cfg)
    }
    return rootSigner(this.cfg)
  }

  async init () {
    // Every room must have its pearcore space (or pending link) under it. A record can
    // go missing after the join (pearcore used to delete every pending link on any sync),
    // and a room without a space is deaf: it opens, but hears and sends nothing.
    const list = await this.core.space.list()
    for (const rcfg of this.cfg.rooms) {
      if (!list.some((s) => s.topicHash === rcfg.topic)) {
        try { await this.core.space.join(rcfg.sharelink); console.log(`[${rcfg.name}] re-joined its space`) } catch (err) { console.error(`[${rcfg.name}] couldn't join its space:`, err.message) }
      }
      if (rcfg.pendingJoin) { delete rcfg.pendingJoin; saveConfig(this.cfg) }
      await this.#open(rcfg)
    }
  }

  async #open (rcfg) {
    const root = this.cfg.root && rootSigner(this.cfg)
    const participants = this.participants
    const room = new Room({
      core: this.core,
      store: new RoomStore(join(dataDir(), rcfg.dir)),
      room: rcfg,
      device: this.device,
      root: root && root.ref === rcfg.root ? root : null,
      participants
    })
    room.on('error', (err) => console.error(`[room ${rcfg.name}]`, err?.stack ?? err))
    room.on('agent-error', (e) => console.error(`[${rcfg.name} · ${e.name}]`, e.error))
    room.on('fork', (f) => console.error(`[${rcfg.name}] rKey chain FORK at seq`, f.seq))
    room.on('renamed', () => { saveConfig(this.cfg); this.emit('room-renamed', this.rooms.get(rcfg.topic)) })
    // an owner we already trust signed this device into another room: join it
    // another of the owner's devices asks this one to hold a project (docs/projects-home-and-sync.md §1):
    // the control is account-gated in #admits, so arriving here means the owner's own key signed it
    room.on('record', (rec) => {
      if (rec.kind !== 'control' || rec.action !== 'project' || rec.home?.device !== this.device.ref) return
      // the event carries the viewed record (its `name` is the author); #projectRequested reads the signed one
      this.#projectRequested(rec.id, room)
    })
    // one of the owner's devices (the phone, mostly) changed a seat's settings from the bot's profile: the device
    // that hosts the seat applies them and writes back how the seat now runs (docs/project-agents.md "The bot's
    // settings"). Account-gated in #admits, like 'project'.
    room.on('seat', (rec) => this.#seatControl(rec, room))
    // a seat in Auto whose grant ran out (so many minutes or turns, its own or the room's cap): back to its old mode
    room.on('auto-over', ({ name, why }) => this.#autoOver(name, why))
    room.on('auto-turn', () => saveConfig(this.cfg)) // the turn count lives on the bridge object, which is the config's
    // once the chain is there (loaded from disk a moment after start, or when it first arrives): say how the seats
    // hosted here run, if the room's newest word on them is stale or missing
    const announce = () => { if (this.rooms.has(rcfg.topic) && room.state) this.#announceStaleSeats(room) }
    room.once('chain', () => setTimeout(announce, 2000).unref?.())
    setTimeout(announce, 3500).unref?.()
    // the owner ended this room from another device: take it off this one (its seat and records go)
    room.on('closed', (rec) => {
      if (this.closing.has(rcfg.topic)) return
      console.log(`[${rcfg.name}] closed by its owner (${rec.name}${rec.device ? `@${rec.device}` : ''}): removing it here`)
      this.removeRoom(rcfg.topic, { closed: true }).catch((err) => console.error(`[${rcfg.name}] close:`, err.message))
    })
    room.on('invite', async ({ code, from }) => {
      try {
        const inv = decodeInvite(code)
        if (this.rooms.has(inv.topic) || inv.root !== rcfg.root) return
        await this.joinRoom(code)
        console.log(`joined "${inv.name}" (invited via "${from}")`)
      } catch (err) { console.error('[invite]', err.message) }
    })
    await room.start()
    const runners = new Map()
    for (const [name, p] of Object.entries(participants)) {
      if (p.role === 'agent') runners.set(name, new AgentRunner(room, name, p.bridge ?? { kind: 'stream' }))
    }
    this.rooms.set(rcfg.topic, { room, runners })
    // a config key that the room doesn't know is the silent way an agent goes deaf: say so
    const check = () => { for (const [name, p] of Object.entries(participants)) { const ref = room.local[name]?.signer.ref; if (room.state && ref && !room.state.isActive(ref)) console.error(`[${rcfg.name}] WARNING: ${name}'s key on this device (${ref.slice(0, 24)}…) is ${room.state.status(ref)} here; it can't post or be woken. rkeychat request --room "${rcfg.name}" and have the owner approve it.`) } }
    room.on('chain', check); setTimeout(check, 3000).unref?.()
    this.emit('room-added', this.rooms.get(rcfg.topic))
    // what this room already holds for us: a close we missed, or project requests still to honour (one that
    // arrived while the daemon was down, or failed last time)
    setTimeout(() => {
      if (!this.rooms.has(rcfg.topic)) return
      if (room.closed() && !room.isOwner) { console.log(`[${rcfg.name}] was closed by its owner: removing it here`); this.removeRoom(rcfg.topic, { closed: true }).catch((err) => console.error(`[${rcfg.name}] close:`, err.message)); return }
      for (const r of requestsFor(room.projectRequests(), this.device.ref, { done: this.cfg.projectRequests ?? [], inflight: this.inflight })) this.#projectRequested(r.id, room)
    }, 500).unref?.()
    return room
  }

  // A project agent: a Claude Code conversation that lives in `dir`, with its own key
  // in `dir/.rkeychat/agent.json`. Added live — no daemon restart — and signed into
  // every room this device owns right away; rooms owned elsewhere need the usual
  // `rkeychat request` + approval, like any new key on this device.
  async addAgent ({ name, dir, permissionMode = 'acceptEdits', tools, model = null, via = 'cli', rooms = null }) {
    name = String(name ?? '').trim().toLowerCase()
    permissionMode = checkPermissionMode(permissionMode ?? 'acceptEdits')
    model = checkModel(model)
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new Error('an agent name is 1-40 characters: letters, digits, - and _')
    if (this.cfg.participants[name]) throw new Error(`there is already a participant called ${name} on this device`)
    dir = resolve(String(dir ?? '').trim() || process.cwd())
    if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`)
    const keyFile = join(dir, '.rkeychat', 'agent.json')
    // `tools` is what it may do without asking (src/tools.js): a preset name, or a list.
    // Unset means the lab preset; `none` is the old behaviour (ask, so headless: refuse).
    tools = parseTools(tools)
    if (tools !== undefined) resolveTools(tools, dir) // throws on an unknown preset, before anything is written
    // `via` is how the daemon drives Claude Code: `cli` (claude -p, stream-json) or `acp`
    // (the Agent Client Protocol adapter, src/acp.js: permissions answered from the tool
    // list, a person's message cancels a running turn, sessions resumed by id).
    via = checkVia(via)
    const bridge = { kind: 'claude', dir, permissionMode, ...(via === 'acp' ? { via } : {}), ...(tools !== undefined ? { tools } : {}), ...(model ? { model } : {}) }
    // the device's choice from setup (settings.agent): a provider's name puts every new seat on it; 'claude' or
    // nothing leaves the seat on this computer's login
    const chosen = loadSettings().agent
    if (chosen && chosen !== 'claude' && this.cfg.providers?.[chosen]) bridge.provider = chosen
    addParticipant(this.cfg, name, { role: 'agent', bridge, keyFile })
    saveConfig(this.cfg)
    // the key is a secret: keep it out of the project's git history
    try {
      const gi = join(dir, '.gitignore')
      const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
      if (existsSync(join(dir, '.git')) && !/^\.rkeychat\/?$/m.test(cur)) appendFileSync(gi, `${cur && !cur.endsWith('\n') ? '\n' : ''}.rkeychat/\n`)
    } catch {}
    const p = this.participants[name]
    const enrolled = []
    // `rooms`: only these (a project's seat belongs to its project); default every room this device owns
    for (const { room, runners } of this.rooms.values()) {
      if (rooms && !rooms.includes(room.topic)) continue
      room.local[name] = p
      runners.set(name, new AgentRunner(room, name, bridge))
      if (room.isOwner) {
        try {
          await room.approve({ participants: [{ ref: p.signer.ref, name, role: 'agent', consent: await consent(p.signer, room.cfg.root) }] })
          enrolled.push(room.cfg.name)
        } catch (err) { console.error(`[${room.cfg.name}] could not enroll ${name}:`, err.message) }
      }
    }
    this.emit('agents-changed')
    return { name, dir, keyFile, ref: p.signer.ref, account: p.account?.ref ?? null, enrolled, tools: describeTools(tools), via }
  }

  // How long an agent's ask waits for a person: per seat (its bridge), else the device default (config.json
  // askMinutes), else a day. Live: the runners read it on the next ask.
  setAskMinutes (name, minutes, { quiet = false } = {}) {
    const n = Number(minutes)
    if (!(n >= 1 && n <= 1440)) throw new Error('ask minutes must be between 1 and 1440 (a day)')
    if (name) {
      const raw = this.cfg.participants[name]
      if (!raw) throw new Error(`no agent ${name} on this device`)
      if (raw.bridge?.kind !== 'claude') throw new Error(`${name} is not a project agent`)
      raw.bridge.askMinutes = n
      for (const { runners } of this.rooms.values()) { const r = runners.get(name); if (r?.bridge) r.bridge.askMinutes = n }
    } else {
      this.cfg.askMinutes = n
      askSettings.minutes = n
    }
    saveConfig(this.cfg)
    if (name && !quiet) this.announceSeat(name)
    return { name: name ?? null, minutes: n, default: this.cfg.askMinutes ?? askSettings.minutes }
  }

  #claudeSeat (name) {
    const raw = this.cfg.participants[name]
    if (!raw) throw new Error(`no agent ${name} on this device`)
    if (raw.bridge?.kind !== 'claude') throw new Error(`${name} is not a project agent (its bridge is ${raw.bridge?.kind ?? 'stream'})`)
    return raw
  }

  // ---- a seat's settings, as the room sees them ----

  // Does this device host the seat (its folder and process are here)?
  #hosts (name) { const p = this.cfg.participants[name]; return !!(p && p.role === 'agent' && p.bridge?.kind === 'claude') }

  // How a seat runs, for the 'seat' control this device writes back and for the snapshot's seat rows.
  seatState (name) {
    const b = this.cfg.participants[name]?.bridge ?? {}
    return { permissionMode: b.permissionMode ?? 'acceptEdits', auto: b.permissionMode === 'auto' ? (b.auto ?? null) : null, model: b.model ?? null, provider: b.provider ?? null, askMinutes: b.askMinutes ?? null, via: b.via ?? 'cli', dir: b.dir ?? null, providers: describeProviders(this.cfg.providers).map(({ name, hasToken }) => ({ name, hasToken })) }
  }

  // A seat's Auto grant ran out: back to the mode it had, said in every room it sits in, and announced.
  #autoOver (name, why) {
    const raw = this.cfg.participants[name]
    if (!this.#hosts(name) || raw.bridge.permissionMode !== 'auto') return
    const b = raw.bridge.auto?.back
    const back = b && b !== 'auto' && PERMISSION_MODES.includes(b) ? b : 'default'
    this.setPermissionMode(name, back, { quiet: true })
    for (const { room } of this.rooms.values()) {
      if (room.local[name] && room.state) room.activity(name, `auto is over (${why}): back to ${MODE_WORDS[back].name}`).catch(() => {})
    }
    this.announceSeat(name)
  }

  // A 'seat' control arrived (the view: `name` is its author). A request for a seat hosted here is applied, then this
  // device writes back how the seat now runs (`applied: true`); echoes and other hosts' seats are left alone.
  // A request that cannot be honoured (a provider this host does not have) is said in the seat's activity.
  #seatControl (rec, room) {
    const name = rec.agent
    if (!this.#hosts(name) || !room.local[name] || rec.seat?.applied) return
    const s = rec.seat ?? {}
    try {
      if (s.via !== undefined) this.setAgentVia(name, s.via, { quiet: true })
      if (s.permissionMode !== undefined || s.auto !== undefined) this.setPermissionMode(name, s.permissionMode ?? 'auto', { quiet: true, auto: s.auto })
      if (s.model !== undefined || s.provider !== undefined) this.setAgentModel(name, { model: s.model, provider: s.provider }, { quiet: true })
      if (s.askMinutes !== undefined) this.setAskMinutes(name, s.askMinutes, { quiet: true })
    } catch (err) {
      room.activity(name, `could not change the settings ${rec.name}${rec.device ? ` (${rec.device})` : ''} asked for: ${err.message}`).catch(() => {})
    }
    this.announceSeat(name)
  }

  // Write how a seat hosted here runs into every room it sits in, signed by this device's human (one of the
  // owner's keys, or the control is not admitted anywhere and there is nothing to say).
  announceSeat (name) {
    if (!this.#hosts(name)) return
    const seat = { ...this.seatState(name), applied: true }
    for (const { room } of this.rooms.values()) this.#announceSeatIn(room, name, seat)
  }

  #announceSeatIn (room, name, seat = { ...this.seatState(name), applied: true }) {
    const human = this.human
    const h = human ? room.local[human] : null
    if (!room.local[name] || !h || !room.state || !room.isOwnerKey(h.signer.ref)) return
    room.control(human, 'seat', { agent: name, seat }).catch((err) => console.error(`[${room.cfg.name}] seat ${name}:`, err.message))
  }

  // At start: a seat whose room has no (or an older) description of how it runs gets one, so a phone that opens
  // the bot's profile sees the truth. Nothing is written when the newest description already matches. Only this
  // room is written: each room runs this for itself (2026-11-23: writing every room from every room's check put
  // six copies of the same control into each room at one start).
  #announceStaleSeats (room) {
    const known = new Map(room.seatsFromLog().map((s) => [s.name, s]))
    for (const name of Object.keys(this.cfg.participants)) {
      if (!this.#hosts(name) || !room.local[name]) continue
      const now = this.seatState(name)
      const k = known.get(name)
      const same = k && ['permissionMode', 'model', 'provider', 'askMinutes', 'via', 'dir'].every((f) => (k[f] ?? null) === (now[f] ?? null)) && JSON.stringify(k.providers) === JSON.stringify(now.providers) && JSON.stringify(k.auto ?? null) === JSON.stringify(now.auto ?? null)
      if (!same) this.#announceSeatIn(room, name, { ...now, applied: true })
    }
  }

  // The seat's permission mode (default = ask, acceptEdits, plan, auto; never bypass). Live: open ACP sessions
  // switch now; cli processes are retired and the next turn starts with the flag.
  // Auto takes a grant `{ minutes, turns }` (nothing = no limit) and remembers the mode to go back to when it runs
  // out; setting Auto again starts the clock and the count over.
  setPermissionMode (name, mode, { quiet = false, auto } = {}) {
    const raw = this.#claudeSeat(name)
    mode = checkPermissionMode(mode)
    const prev = raw.bridge.permissionMode ?? 'acceptEdits'
    if (mode === 'auto') raw.bridge.auto = { since: Date.now(), ...checkAutoLimit(auto), used: 0, back: prev === 'auto' ? (raw.bridge.auto?.back ?? 'default') : prev }
    else delete raw.bridge.auto
    raw.bridge.permissionMode = mode
    saveConfig(this.cfg)
    for (const { runners } of this.rooms.values()) runners.get(name)?.applyMode?.(mode)
    this.emit('agents-changed')
    if (!quiet) this.announceSeat(name)
    return { name, permissionMode: mode, auto: raw.bridge.auto ?? null, run: describeRun(raw.bridge) }
  }

  // The seat's model (null: the login's default) and provider (null: this computer's Claude login). A provider must
  // exist on this device before a seat may name it. A model change is live in ACP sessions; a provider change
  // retires the processes, since the environment is fixed at spawn.
  setAgentModel (name, { model, provider } = {}, { quiet = false } = {}) {
    const raw = this.#claudeSeat(name)
    if (model !== undefined) {
      const m = checkModel(model)
      if (m) raw.bridge.model = m; else delete raw.bridge.model
    }
    let providerChanged = false
    if (provider !== undefined) {
      const p = provider == null || provider === '' || provider === 'claude' ? null : checkProviderName(provider)
      if (p && !this.cfg.providers?.[p]) throw new Error(`no provider "${p}" on this device (rkeychat provider set ${p} URL)`)
      providerChanged = (raw.bridge.provider ?? null) !== p
      if (p) raw.bridge.provider = p; else delete raw.bridge.provider
    }
    saveConfig(this.cfg)
    for (const { runners } of this.rooms.values()) {
      const r = runners.get(name)
      if (!r) continue
      if (providerChanged) r.reconfigured?.()
      else if (model !== undefined) r.applyModel?.(raw.bridge.model ?? null)
    }
    this.emit('agents-changed')
    if (!quiet) this.announceSeat(name)
    return { name, model: raw.bridge.model ?? null, provider: raw.bridge.provider ?? null, run: describeRun(raw.bridge) }
  }

  // A provider on this device: a name, the base URL Claude Code is pointed at, and the token (kept, never shown).
  // Setting one again without a token keeps the token it has.
  setProvider (name, { baseUrl, token } = {}) {
    name = checkProviderName(name)
    const cur = this.cfg.providers?.[name] ?? {}
    const next = { baseUrl: baseUrl !== undefined ? checkBaseUrl(baseUrl) : cur.baseUrl, token: token ? String(token).trim() : cur.token }
    if (!next.baseUrl) throw new Error('a provider needs a base URL')
    this.cfg.providers ??= {}
    this.cfg.providers[name] = next
    providerSettings.providers = this.cfg.providers
    saveConfig(this.cfg)
    // seats on it were started with the old URL or token; every seat's description carries the provider list
    for (const [seat, p] of Object.entries(this.cfg.participants)) {
      if (p.bridge?.provider === name) for (const { runners } of this.rooms.values()) runners.get(seat)?.reconfigured?.()
      this.announceSeat(seat)
    }
    return describeProviders(this.cfg.providers).find((p) => p.name === name)
  }

  removeProvider (name) {
    name = checkProviderName(name)
    if (!this.cfg.providers?.[name]) throw new Error(`no provider "${name}" on this device`)
    const using = Object.entries(this.cfg.participants).filter(([, p]) => p.bridge?.provider === name).map(([n]) => n)
    if (using.length) throw new Error(`${using.map((n) => '@' + n).join(', ')} still run${using.length === 1 ? 's' : ''} on ${name}; put them back on the login first (rkeychat agent model NAME --provider claude)`)
    delete this.cfg.providers[name]
    providerSettings.providers = this.cfg.providers
    saveConfig(this.cfg)
    for (const seat of Object.keys(this.cfg.participants)) this.announceSeat(seat)
    return { removed: name }
  }

  providers () { return describeProviders(this.cfg.providers) }

  // Switch a project agent between the two ways of driving Claude Code. Live: its process
  // is retired (after its turn, if one is in flight); the next turn starts the other kind,
  // resuming the same conversation by session id.
  setAgentVia (name, via, { quiet = false } = {}) {
    const raw = this.cfg.participants[name]
    if (!raw) throw new Error(`no agent ${name} on this device`)
    if (raw.bridge?.kind !== 'claude') throw new Error(`${name} is not a project agent (its bridge is ${raw.bridge?.kind ?? 'stream'})`)
    via = checkVia(via)
    if (via === 'acp') raw.bridge.via = 'acp'; else delete raw.bridge.via
    saveConfig(this.cfg)
    for (const { runners } of this.rooms.values()) runners.get(name)?.reconfigured?.()
    this.emit('agents-changed')
    if (!quiet) this.announceSeat(name)
    return { name, via }
  }

  // Change what a project agent may do without asking. Live: its process is retired (after
  // its turn, if one is in flight) and the next turn starts one with the new flags.
  setAgentTools (name, tools) {
    const raw = this.cfg.participants[name]
    if (!raw) throw new Error(`no agent ${name} on this device`)
    if (raw.bridge?.kind !== 'claude') throw new Error(`${name} is not a project agent (its bridge is ${raw.bridge?.kind ?? 'stream'}); tools apply to project agents only`)
    tools = parseTools(tools) ?? 'lab'
    resolveTools(tools, raw.bridge.dir)
    if (tools === 'lab') delete raw.bridge.tools; else raw.bridge.tools = tools
    saveConfig(this.cfg)
    // the runners hold the same bridge object (participantSigners passes it through), so
    // they already see the change; retire the processes that were started with the old flags
    for (const { runners } of this.rooms.values()) runners.get(name)?.reconfigured?.()
    this.emit('agents-changed')
    return { name, tools: describeTools(tools) }
  }

  agents () {
    return Object.entries(this.cfg.participants).filter(([, p]) => p.role === 'agent').map(([name, p]) => ({
      name, bridge: p.bridge?.kind ?? 'stream', via: p.bridge?.kind === 'claude' ? (p.bridge.via ?? 'cli') : null, dir: p.bridge?.dir ?? null, keyFile: p.keyFile ?? null, ref: p.ref,
      tools: p.bridge?.kind === 'claude' ? describeTools(p.bridge.tools) : null,
      ...(p.bridge?.kind === 'claude' ? { permissionMode: p.bridge.permissionMode ?? 'acceptEdits', auto: p.bridge.permissionMode === 'auto' ? (p.bridge.auto ?? null) : null, model: p.bridge.model ?? null, provider: p.bridge.provider ?? null, askMinutes: p.bridge.askMinutes ?? null, run: describeRun(p.bridge) } : {}),
      sessions: p.keyFile ? (() => { try { return readKeyFile(p.keyFile).sessions ?? {} } catch { return {} } })() : {},
      rooms: [...this.rooms.values()].map(({ room, runners }) => ({ name: room.cfg.name, topic: room.topic, enrolled: !!(room.state && room.local[name] && room.state.isActive(room.local[name].signer.ref)), state: room.agentState.get(name) ?? 'idle', busy: !!runners.get(name)?.busy }))
    }))
  }

  find (key) {
    if (!key) return this.rooms.values().next().value ?? null
    return this.rooms.get(key) ?? [...this.rooms.values()].find((r) => r.room.cfg.name === key) ?? null
  }

  list () {
    return [...this.rooms.values()].map(({ room }) => {
      const active = room.participantsList().filter((p) => p.status === 'active')
      const l = room.lastMessage()
      return {
        name: room.cfg.name,
        topic: room.topic,
        owner: room.isOwner,
        admitted: !!room.chain,
        members: active.length,
        people: active.map((p) => ({ name: p.name, role: p.role, online: p.online, local: p.local })),
        last: l ? { name: l.name, text: l.text || (l.att?.length ? 'Voice memo' : ''), ts: l.ts } : null,
        // projects and conversations (docs/projects-api.md)
        folder: room.cfg.folder ?? null,
        app: room.appInfo(),
        convs: room.conversations().map(({ conv, title, archived, last, count, busy }) => ({ conv, title, archived, last, count, busy }))
      }
    })
  }

  // A project: a room bound to a folder on this device, with its own seat (a project agent in that
  // folder, driven over ACP unless said otherwise) and the signed note that says what the room is.
  // One gesture from the shell: drop a folder, and the room, the chain, the seat and the note exist.
  async createProject ({ folder, name, agent, via = 'acp', org, request } = {}) {
    if (!canHost()) throw new Error('this device cannot hold a project; pick one of your computers')
    folder = resolve(String(folder ?? '').trim())
    if (!folder || !existsSync(folder)) throw new Error(`no such folder: ${folder}`)
    const base = basename(folder)
    name = String(name ?? '').trim() || base
    if (this.cfg.rooms.some((r) => r.folder === folder)) throw new Error(`${folder} is already a project ("${this.cfg.rooms.find((r) => r.folder === folder).name}")`)
    const room = await this.createRoom(name)
    const rcfg = this.cfg.rooms.find((r) => r.topic === room.topic)
    rcfg.folder = folder
    saveConfig(this.cfg)
    this.#manifest(room, 'project').catch((err) => console.error(`[${name}] manifest:`, err.message))
    const human = Object.entries(this.cfg.participants).find(([, p]) => p.role === 'human')?.[0]
    // `request`: the 'project' control this answers, so the device that asked matches the room by id, not by name
    if (human) await room.setApp(human, { role: 'project', title: name, home: { device: this.device.ref, name: this.cfg.deviceName }, org: org ?? undefined, request: request ?? undefined }).catch((err) => console.error(`[${name}] app note:`, err.message))
    // the seat: named after the folder unless taken, in the folder, in this room only
    let seat = String(agent ?? '').trim() || slug(name)
    const isPerson = (n) => this.cfg.participants[n]?.role === 'human'
    if (isPerson(seat)) seat = `${seat}-bot`
    if (this.cfg.participants[seat] && this.cfg.participants[seat].bridge?.dir !== folder) {
      let i = 2; while (this.cfg.participants[`${seat}${i}`] || isPerson(`${seat}${i}`)) i++
      seat = `${seat}${i}`
    }
    let seatInfo = null
    if (this.cfg.participants[seat]) {
      // the folder already has a seat on this device (e.g. rkeychat agent init was run there): sign it into the room
      const p = this.participants[seat]
      room.local[seat] = p
      this.rooms.get(room.topic).runners.set(seat, new AgentRunner(room, seat, p.bridge))
      await room.approve({ participants: [{ ref: p.signer.ref, name: seat, role: 'agent', consent: await consent(p.signer, room.cfg.root) }] })
      seatInfo = { name: seat, dir: folder, existing: true }
    } else {
      seatInfo = await this.addAgent({ name: seat, dir: folder, via, rooms: [room.topic] })
    }
    this.emit('rooms-changed')
    return { room: this.list().find((r) => r.topic === room.topic), seat: seatInfo }
  }

  // The space's manifest (.pearmeta/app.json + the icon): what this room is to rKeyChat, for PearDrive's "My Apps".
  async #manifest (room, kind) {
    const space = await room.space()
    if (!space) return
    const home = kind === 'project' ? { device: this.device.ref, name: this.cfg.deviceName } : null
    await writeManifest(this.core, space, { kind, name: room.cfg.name, home })
  }

  // Where new projects go on this device when nobody names a folder: the workspace root (a setting).
  // Not ~/Projects: that is often a person's own folder of work (it is Guy's), and a tool must not drop folders into it unasked.
  workspace () { return resolve(String(loadSettings().workspace || join(homedir(), 'rKeyChat'))) }

  // A 'project' control that names this device as home: make the folder under the workspace root and the
  // project, and answer with the room's app note (`request` = the control's id). A request is marked done only
  // once it has been answered, so one that fails is tried again (next record, next start). A name already in
  // use here is the answer: that room's note gains the request id, and the asker's wait ends on it.
  #projectRequested (id, via) {
    const req = requestOf(via.store.get(id))
    if (!req || req.home?.device !== this.device.ref) return
    const done = this.cfg.projectRequests ??= []
    if (done.includes(id) || this.inflight.has(id)) return
    this.inflight.add(id)
    const finish = () => { done.push(id); if (done.length > 200) done.splice(0, done.length - 200); saveConfig(this.cfg) }
    const human = this.human
    const run = async () => {
      const folder = join(this.workspace(), slug(req.name))
      const existing = this.cfg.rooms.find((r) => r.folder === folder || r.name === req.name)
      if (existing) {
        const room = this.rooms.get(existing.topic)?.room
        if (room?.isOwner && human && room.appInfo()?.request !== id) await room.setApp(human, { request: id })
        console.log(`[project] "${req.name}" already exists here; answered the request from ${via.cfg.name} with it`)
        finish(); return
      }
      mkdirSync(folder, { recursive: true })
      const out = await this.createProject({ folder, name: req.name, org: req.org, request: id })
      if (req.text) { // the prompt the requester wrote, as the room's charter
        const room = this.rooms.get(out.room.topic)?.room
        if (room && human) await room.control(human, 'charter', { text: req.text }).catch(() => {})
      }
      finish()
      console.log(`[project] made "${req.name}" at ${folder}, asked from ${via.cfg.name}`)
    }
    run().catch((err) => console.error(`[project] "${req.name}" (asked from ${via.cfg.name}) failed: ${err.message}; it will be tried again`)).finally(() => this.inflight.delete(id))
  }

  // What this device asked other devices for and has not seen arrive (the shell shows the wait).
  pendingProjects () {
    const mine = Object.values(this.participants).filter((p) => p.role === 'human').map((p) => p.signer.ref)
    const rooms = [...this.rooms.values()].map(({ room }) => ({ name: room.cfg.name, requests: room.projectRequests(), answered: [room.appInfo()?.request].filter(Boolean), devices: room.ownDevices() }))
    return pendingProjectsOf(rooms, mine)
  }

  // The owner's devices, merged across the rooms this device is in: [{ ref, name, online, here }].
  devices () {
    const out = new Map()
    for (const { room } of this.rooms.values()) for (const d of room.ownDevices()) {
      const cur = out.get(d.ref)
      out.set(d.ref, cur ? { ...cur, online: cur.online || d.online } : d)
    }
    if (!out.has(this.device.ref)) out.set(this.device.ref, { ref: this.device.ref, name: this.cfg.deviceName, online: true, here: true })
    // a phone holds no folders and runs no seats: projects live on a computer
    for (const d of out.values()) if (d.here) d.canHost = canHost()
    return [...out.values()].sort((a, b) => (b.here - a.here) || (b.online - a.online) || a.name.localeCompare(b.name))
  }

  // Ask another of the owner's devices to make the project: a signed 'project' control through a room both are
  // in (the owner's human must be able to write controls there). Returns where it was asked.
  async requestProject ({ name, home, prompt, org } = {}) {
    name = String(name ?? '').trim(); if (!name) throw new Error('a project needs a name')
    const dev = this.devices().find((d) => d.ref === home || d.name === home)
    if (!dev) throw new Error(`not one of your devices: ${home}`)
    if (dev.here) throw new Error('that is this device; make the project here')
    const human = Object.entries(this.cfg.participants).find(([, p]) => p.role === 'human')?.[0]
    if (!human) throw new Error('only a person can ask for a project')
    const carrier = [...this.rooms.values()].map((r) => r.room).find((room) => room.chain && room.isOwnerKey(room.local[human]?.signer.ref) && room.ownDevices().some((d) => d.ref === dev.ref))
    if (!carrier) throw new Error(`no room shared with ${dev.name} where you can ask`)
    const rec = await carrier.requestProject(human, { title: name, home: { device: dev.ref, name: dev.name }, prompt, org })
    return { asked: dev.name, via: carrier.cfg.name, id: rec.id, online: dev.online }
  }

  // Take a room off this device: its seat (when it lives only here), its runners, its local records. The owner
  // closes the room first (a signed 'close': the owner's other devices and the members drop it too); a room
  // someone else owns is left (our keys self-revoke). With `closed`, the owner already ended it elsewhere:
  // nothing to announce, nobody to leave. The project folder on disk is never touched.
  async removeRoom (key, { closed = false } = {}) {
    const r = this.find(key)
    if (!r) throw new Error(`no room "${key}"`)
    const { room, runners } = r
    const topic = room.topic
    const human = this.human
    if (!closed && room.isOwner && room.chain && human && room.local[human]) {
      this.closing.add(topic)
      try {
        await room.close(human)
        await new Promise((resolve) => setTimeout(resolve, 1500)) // a moment for the record to reach the peers that are online
      } catch (err) { console.error(`[${room.cfg.name}] close:`, err.message) } finally { this.closing.delete(topic) }
    } else if (!closed && !room.isOwner && room.chain) {
      for (const [name, p] of Object.entries(this.participants)) if (room.local[name] && room.state?.isActive(p.signer.ref)) await room.leave(name).catch(() => {})
      await room.leave().catch(() => {})
    }
    for (const runner of runners.values()) runner.stop?.()
    room.stop()
    this.rooms.delete(topic)
    const rcfg = this.cfg.rooms.find((x) => x.topic === topic)
    this.cfg.rooms = this.cfg.rooms.filter((x) => x.topic !== topic)
    // a seat made for this project (its folder is the room's) that sits in no other room goes too
    const seats = []
    for (const [name, p] of Object.entries(this.cfg.participants)) {
      if (p.role !== 'agent' || p.bridge?.kind !== 'claude' || !rcfg?.folder || p.bridge.dir !== rcfg.folder) continue
      const elsewhere = [...this.rooms.values()].some(({ room: o }) => o.local[name] && o.state?.isActive(this.participants[name]?.signer.ref))
      if (!elsewhere) { delete this.cfg.participants[name]; delete this.participants[name]; seats.push(name) }
    }
    saveConfig(this.cfg)
    if (rcfg?.dir) rmSync(join(dataDir(), rcfg.dir), { recursive: true, force: true })
    this.emit('rooms-changed')
    return { removed: room.cfg.name, topic, seats, folder: rcfg?.folder ?? null }
  }

  // Put a room in an organization (or take it out: org null). Owner only; the note is signed and shared.
  async setRoomOrg (key, org) {
    const r = this.find(key); if (!r) throw new Error(`no room "${key}"`)
    if (!r.room.isOwner) throw new Error('only the owner can move a project between organizations')
    const human = Object.entries(this.cfg.participants).find(([, p]) => p.role === 'human')?.[0]
    await r.room.setApp(human, { org: org == null || String(org).trim() === '' ? null : String(org).trim() })
    r.room.emit('changed'); this.emit('rooms-changed')
    return this.list().find((x) => x.topic === r.room.topic)
  }

  // Bind (or rebind) a folder to a room on this device; the room becomes a project here.
  async setRoomFolder (topic, folder) {
    const r = this.rooms.get(topic)
    if (!r) throw new Error('no such room')
    folder = folder == null || folder === '' ? null : resolve(String(folder).trim())
    if (folder && !existsSync(folder)) throw new Error(`no such folder: ${folder}`)
    const rcfg = this.cfg.rooms.find((x) => x.topic === topic)
    rcfg.folder = folder ?? undefined
    if (!folder) delete rcfg.folder
    saveConfig(this.cfg)
    const human = Object.entries(this.cfg.participants).find(([, p]) => p.role === 'human')?.[0]
    if (human && r.room.isOwner) await r.room.setApp(human, { role: folder ? 'project' : 'chat', home: folder ? { device: this.device.ref, name: this.cfg.deviceName } : null }).catch(() => {})
    if (r.room.isOwner) this.#manifest(r.room, folder ? 'project' : 'chat').catch(() => {})
    r.room.emit('changed')
    this.emit('rooms-changed')
    return this.list().find((x) => x.topic === topic)
  }

  // Create a room with just the people you pick. Local humans are always in;
  // local agents only if named; people from your other rooms get signed in
  // with the consent they already gave your root, then invited automatically.
  async createRoom (name, { members = [] } = {}) {
    name = String(name ?? '').trim()
    if (!name) throw new Error('a room needs a name')
    if (this.cfg.rooms.some((r) => r.name === name)) throw new Error(`you already have a room called "${name}"`)
    const root = this.root()
    const r = root.ref
    const space = await this.core.space.create({
      spaceName: `rkeychat:${name}`,
      permissionRead: false,
      readWhitelist: [this.device.ref.slice(8)],
      permissionBroadcast: false,
      broadcastWhitelist: [this.device.ref.slice(8)]
    })
    const rcfg = { name, topic: space.topicHash, sharelink: space.sharelink, root: r, dir: `rooms/${space.topicHash.slice(0, 16)}` }

    const chain = await Chain.create(root, { label: 'root' })
    await chain.append(await enroll(root, { root: r, key: this.device.ref, consent: await consent(this.device, r), scope: ['bind', SCOPES.host], label: `device:${this.cfg.deviceName}` }), root)
    for (const [pname, p] of Object.entries(this.participants)) {
      if (p.role !== 'human' && !members.includes(pname)) continue
      const role = p.role === 'human' ? SCOPES.admin : SCOPES.agent
      if (p.account && p.account.ref !== r) {
        // an agent with its own root: enrolled under ours with delegate, then it enrolls its session key
        await chain.append(await enroll(root, { root: r, key: p.account.ref, consent: await consent(p.account, r), scope: ['bind', SCOPES.chat, role, 'delegate'], label: pname }), root)
        await chain.append(await enroll(p.account, { root: r, key: p.signer.ref, consent: await consent(p.signer, r), scope: ['bind', SCOPES.chat, role], label: `${pname}@${this.cfg.deviceName}` }), root)
      } else {
        // a key under our own root (a person's device key, or a legacy agent key)
        await chain.append(await enroll(root, { root: r, key: p.signer.ref, consent: await consent(p.signer, r), scope: ['bind', SCOPES.chat, role], label: p.role === 'human' ? `${pname}@${this.cfg.deviceName}` : pname }), root)
      }
    }
    new RoomStore(join(dataDir(), rcfg.dir)).writeJSON('chain.json', chain.toJSON())
    this.cfg.rooms.push(rcfg)
    saveConfig(this.cfg)
    const room = await this.#open(rcfg)
    this.#manifest(room, 'chat').catch((err) => console.error(`[${name}] manifest:`, err.message))
    for (const m of members.filter((m) => !this.participants[m])) {
      try { await this.addMember(room.topic, m) } catch (err) { console.error(`[${name}] couldn't add ${m}:`, err.message) }
    }
    // your other devices are you: a room you make here is theirs too
    try { await this.enrollOwnDevices(room) } catch (err) { console.error(`[${name}] couldn't add your other devices:`, err.message) }
    return room
  }

  // Every device of ours known from another room we own (its device key and the human's
  // session key on it, both under our root) gets enrolled into `target` and sent the
  // invite through a room it already shares with us. Nothing is asked of the device:
  // its consents are the ones it gave when it first joined. (Oct 1: a room made on the
  // Mac never appeared on the phone.)
  async enrollOwnDevices (target) {
    if (!target?.isOwner) return []
    const human = Object.entries(this.participants).find(([, p]) => p.role === 'human')?.[0]
    if (!human) return []
    const mine = new Set(target.members().filter((m) => m.status === 'active').map((m) => m.ref))
    const added = []
    for (const { room: source } of this.rooms.values()) {
      if (!source.isOwner || source === target || source.cfg.root !== target.cfg.root || !source.chain) continue
      const st = source.state
      const active = (op) => op && st.isActive(op.key)
      const devices = source.chain.entries.map((x) => x.op).filter((op) => op?.t === 'enroll' && op.label?.startsWith('device:') && active(op) && op.key !== this.device.ref && !mine.has(op.key))
      for (const d of devices) {
        const devName = d.label.replace(/^device:/, '')
        const session = source.chain.entries.map((x) => x.op).findLast((op) => op?.t === 'enroll' && op.label === `${human}@${devName}` && active(op) && op.parent === source.cfg.root)
        if (!session) continue
        try {
          await target.approve({ device: { ref: d.key, name: devName, consent: d.consent }, participants: [{ ref: session.key, name: human, role: 'human', consent: session.consent }] }, { asOwner: true })
          await source.sendInvite(d.key, encodeInvite(target.cfg), target.cfg.name)
          mine.add(d.key); added.push(devName)
        } catch (err) { console.error(`[${target.cfg.name}] ${devName}:`, err.message) }
      }
    }
    if (added.length) console.log(`[${target.cfg.name}] added your other device${added.length === 1 ? '' : 's'}: ${added.join(', ')}`)
    return added
  }

  // People you've approved anywhere, who could be added to other rooms you own.
  knownPeople () {
    const out = new Map()
    for (const { room } of this.rooms.values()) {
      if (!room.isOwner) continue
      for (const m of room.members()) {
        if (m.status !== 'active' || m.label?.startsWith('device:') || this.participants[m.name]) continue
        if (!out.has(m.name)) out.set(m.name, { name: m.name, role: m.scope.includes('admin') ? 'human' : 'agent', from: room.cfg.name })
      }
    }
    return [...out.values()]
  }

  async addMember (topic, name) {
    const target = this.rooms.get(topic)?.room
    if (!target?.isOwner) throw new Error('you can only add people to rooms you own')
    const source = [...this.rooms.values()].map((r) => r.room).find((r) => r.isOwner && r !== target && r.cfg.root === target.cfg.root && r.enrollmentOf(name))
    if (!source) throw new Error(`${name} isn't in any of your other rooms yet — invite them the usual way`)
    const { participant, device } = source.enrollmentOf(name)
    if (!device) throw new Error(`couldn't tell which device ${name} is on`)
    // rKey ops are bound to the root, not the room, so the account's own ops from the
    // source room are valid here too: its root enrollment and its session-key enrollment
    const role = participant.scope.includes('admin') ? 'human' : 'agent'
    const acct = source.chain.entries.find((x) => x.op?.t === 'enroll' && x.op.key === participant.parent)?.op
    const account = acct && acct.parent === source.cfg.root && acct.key !== source.cfg.root
      ? { ref: acct.key, consent: acct.consent, enroll: participant }
      : undefined
    await target.approve({
      device: { ref: device.key, name: device.label.replace(/^device:/, ''), consent: device.consent },
      participants: [{ ref: participant.key, name, role, consent: participant.consent, account }]
    })
    await source.sendInvite(device.key, encodeInvite(target.cfg), target.cfg.name)
    return { added: name, via: source.cfg.name }
  }

  async joinRoom (invite) {
    const inv = decodeInvite(invite)
    if (this.rooms.has(inv.topic)) throw new Error(`already in "${inv.name}"`)
    const rcfg = { ...inv, dir: `rooms/${inv.topic.slice(0, 16)}` }
    const list = await this.core.space.list()
    if (!list.some((s) => s.topicHash === rcfg.topic)) await this.core.space.join(rcfg.sharelink)
    this.cfg.rooms.push(rcfg)
    saveConfig(this.cfg)
    const room = await this.#open(rcfg)
    return { room, request: await this.request(room) }
  }

  request (room) {
    return joinRequest({ root: room.cfg.root, deviceName: this.cfg.deviceName, device: this.device, participants: this.participants, state: room.state })
  }
}

// Everything a daemon is, without owning the process: config → pearcore → rooms → HTTP.
// `rkeychat start` wraps it with a terminal (runDaemon); the desktop app (electron/main.js)
// hosts it in Electron's main process and calls `stop` on quit. EADDRINUSE comes back as
// a thrown error with `code` set, for the caller to explain in its own words.
export async function bootDaemon ({ createRoomName } = {}) {
  const loaded = loadConfig()
  if (!loaded) throw new Error('no config — run `rkeychat init` first')
  const cfg = migrate(loaded)
  const { core, device } = await openCore(cfg)
  const app = new App({ cfg, core, device })
  await app.init()
  app.login = new Login(app)
  if (createRoomName && !cfg.rooms.some((r) => r.name === createRoomName)) await app.createRoom(createRoomName)
  const server = await serve({ app })

  // a bug deep in pearcore must not take the whole chat down: log it loudly and carry on
  process.on('uncaughtException', (err) => console.error('[daemon] uncaught exception (kept running):', err?.stack ?? err))
  process.on('unhandledRejection', (err) => console.error('[daemon] unhandled rejection (kept running):', err?.stack ?? err))

  let stopped = false
  const stop = async () => {
    if (stopped) return; stopped = true
    server.close()
    for (const { room, runners } of app.rooms.values()) { for (const r of runners.values()) r.stop?.(); room.stop() }
    try { await core.accounts.logout() } catch {}
  }
  return { cfg, core, app, server, stop }
}

export async function runDaemon ({ createRoomName } = {}) {
  const { cfg, app, stop } = await bootDaemon({ createRoomName }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      const port = loadConfig()?.port ?? 4455
      console.error(`\n  rkeychat is already running on this device (port ${port}).\n  Open http://127.0.0.1:${port}, or use rkeychat commands in this terminal; they talk to the running daemon.\n`)
      process.exit(1)
    }
    throw err
  })

  console.log(`rkeychat · device ${cfg.deviceName} · ${app.rooms.size} room${app.rooms.size === 1 ? '' : 's'}`)
  console.log(`\n  open  http://127.0.0.1:${cfg.port}`)
  console.log('  this terminal is the daemon: leave it running (Ctrl-C stops it).')
  console.log('  run rkeychat commands from another tab, or next time use: rkeychat start --background\n')

  const shutdown = async () => { await stop(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
