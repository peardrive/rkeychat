// Boots pearcore for this device and runs every room it's in. Rooms can be
// created or joined while the daemon runs (GUI or CLI); no restart needed.

import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createCore } from 'pearcore/src/core.js'
import { Chain, generate, consent, enroll } from 'rkey'
import { loadConfig, saveConfig, dataDir, participantSigners, rootSigner, deviceSigner, migrate } from './config.js'
import { RoomStore } from './store.js'
import { Room, joinRequest } from './room.js'
import { AgentRunner } from './agents.js'
import { serve, decodeInvite, encodeInvite } from './server.js'
import { SCOPES } from './proto.js'

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
    for (const rcfg of this.cfg.rooms) {
      if (rcfg.pendingJoin) {
        const list = await this.core.space.list()
        if (!list.some((s) => s.topicHash === rcfg.topic)) await this.core.space.join(rcfg.sharelink)
        delete rcfg.pendingJoin
        saveConfig(this.cfg)
      }
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

  find (key) {
    if (!key) return this.rooms.values().next().value ?? null
    return this.rooms.get(key) ?? [...this.rooms.values()].find((r) => r.room.cfg.name === key) ?? null
  }

  list () {
    return [...this.rooms.values()].map(({ room }) => ({
      name: room.cfg.name,
      topic: room.topic,
      owner: room.isOwner,
      admitted: !!room.chain,
      members: room.participantsList().filter((p) => p.status === 'active').length,
      people: room.participantsList().filter((p) => p.status === 'active').map((p) => ({ name: p.name, role: p.role, online: p.online, local: p.local })),
      last: (() => { const l = room.log().filter((r) => r.kind === 'msg' && !r.redacted).at(-1); return l ? { name: l.name, text: l.text || (l.att?.length ? 'Voice memo' : ''), ts: l.ts } : null })()
    }))
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
    return room
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

export async function runDaemon ({ createRoomName } = {}) {
  const loaded = loadConfig()
  if (!loaded) throw new Error('no config — run `rkeychat init` first')
  const cfg = migrate(loaded)
  const { core, device } = await openCore(cfg)
  const app = new App({ cfg, core, device })
  await app.init()
  if (createRoomName && !cfg.rooms.some((r) => r.name === createRoomName)) await app.createRoom(createRoomName)

  const server = await serve({ app }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  rkeychat is already running on this device (port ${cfg.port}).\n  Open http://127.0.0.1:${cfg.port}, or use rkeychat commands in this terminal; they talk to the running daemon.\n`)
      process.exit(1)
    }
    throw err
  })

  console.log(`rkeychat · device ${cfg.deviceName} · ${app.rooms.size} room${app.rooms.size === 1 ? '' : 's'}`)
  console.log(`\n  open  http://127.0.0.1:${cfg.port}`)
  console.log('  this terminal is the daemon: leave it running (Ctrl-C stops it).')
  console.log('  run rkeychat commands from another tab, or next time use: rkeychat start --background\n')

  // a bug deep in pearcore must not take the whole chat down: log it loudly and carry on
  process.on('uncaughtException', (err) => console.error('[daemon] uncaught exception (kept running):', err?.stack ?? err))
  process.on('unhandledRejection', (err) => console.error('[daemon] unhandled rejection (kept running):', err?.stack ?? err))

  const shutdown = async () => {
    server.close()
    for (const { room } of app.rooms.values()) room.stop()
    try { await core.accounts.logout() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
