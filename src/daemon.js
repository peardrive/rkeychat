// Boots pearcore for this device and runs every room it's in. Rooms can be
// created or joined while the daemon runs (GUI or CLI); no restart needed.

import { join, resolve } from 'node:path'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createCore } from 'pearcore/src/core.js'
import { Chain, generate, consent, enroll } from 'rkey'
import { loadConfig, saveConfig, dataDir, participantSigners, rootSigner, deviceSigner, migrate, addParticipant, readKeyFile } from './config.js'
import { RoomStore } from './store.js'
import { Room, joinRequest } from './room.js'
import { AgentRunner } from './agents.js'
import { serve, decodeInvite, encodeInvite } from './server.js'
import { SCOPES } from './proto.js'
import { Login } from './login.js'

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
  }

  get participants () { return participantSigners(this.cfg) }

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
    return room
  }

  // A project agent: a Claude Code conversation that lives in `dir`, with its own key
  // in `dir/.rkeychat/agent.json`. Added live — no daemon restart — and signed into
  // every room this device owns right away; rooms owned elsewhere need the usual
  // `rkeychat request` + approval, like any new key on this device.
  async addAgent ({ name, dir, permissionMode = 'acceptEdits', tools = [], model = null }) {
    dir = resolve(String(dir ?? '').trim() || process.cwd())
    if (!existsSync(dir)) throw new Error(`no such folder: ${dir}`)
    const keyFile = join(dir, '.rkeychat', 'agent.json')
    const bridge = { kind: 'claude', dir, permissionMode, ...(tools.length ? { tools } : {}), ...(model ? { model } : {}) }
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
    for (const { room, runners } of this.rooms.values()) {
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
    return { name, dir, keyFile, ref: p.signer.ref, account: p.account?.ref ?? null, enrolled }
  }

  agents () {
    return Object.entries(this.cfg.participants).filter(([, p]) => p.role === 'agent').map(([name, p]) => ({
      name, bridge: p.bridge?.kind ?? 'stream', dir: p.bridge?.dir ?? null, keyFile: p.keyFile ?? null, ref: p.ref,
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
        last: l ? { name: l.name, text: l.text || (l.att?.length ? 'Voice memo' : ''), ts: l.ts } : null
      }
    })
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
          await target.approve({ device: { ref: d.key, name: devName, consent: d.consent }, participants: [{ ref: session.key, name: human, role: 'human', consent: session.consent }] })
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
