// Logging a new device into an account, with nothing copied by hand.
//
// The device that already holds the account (A) makes a throwaway pearcore
// space just for this login and shows a QR: the account root, the display
// name, that space's link, and a one-time token. The new device (B) scans it,
// mints its keys, joins the login space and posts its join request there with
// the token. A checks the token, enrolls B under the root into every room A is
// in, answers with the room invites, and tears the login space down. B joins
// the rooms and is admitted at once: it's already in every chain.
//
// What crosses the login space is public keys, consents and signed ops; the
// token is single-use and expires. The space itself is readable by anyone who
// holds its link for the few minutes it exists, which is why nothing secret
// travels through it.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { envelope, isOurs } from './proto.js'
import { joinRequest } from './room.js'
import { encodeInvite, decodeInvite } from './invite.js'

const TTL = 10 * 60_000
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString())

export const encodeLogin = (o) => 'rkl1.' + b64(o)

// A pairing offer with an action. Same mechanism as a login — a throwaway space, a
// one-time token, a QR — but it says what the scan is *for*. 'login' brings a device
// into the account; 'room' puts whoever scans into one room and nothing else.
//
// Its own prefix, not an extra field on rkl1., because a build that predates this
// would read an unknown field as absent and log the scanner into the whole account.
// An old build meets rkp1. and says it doesn't recognise the code, which is right.
export const encodePair = (o) => 'rkp1.' + b64(o)
export function decodePair (code) {
  const s = String(code ?? '').trim()
  if (!s.startsWith('rkp1.')) throw new Error('that isn\'t a pairing code (they start with rkp1.)')
  const { a: action, r: root, n: name, s: sharelink, k: token, rn: roomName } = unb64(s.slice(5))
  if (!action || !root || !sharelink || !token) throw new Error('pairing code is incomplete')
  if (action !== 'login' && action !== 'room') throw new Error(`unknown pairing action "${action}"`)
  return { action, root, name, sharelink, token, roomName }
}
// Either kind, so one scanner handles both.
export const isPairing = (code) => /^rk[lp]1\./.test(String(code ?? '').trim())
export function decodeAny (code) {
  const s = String(code ?? '').trim()
  if (s.startsWith('rkp1.')) return decodePair(s)
  return { action: 'login', ...decodeLogin(s) }
}
export function decodeLogin (code) {
  const s = String(code ?? '').trim()
  if (!s.startsWith('rkl1.')) throw new Error('that isn\'t a login code (they start with rkl1.)')
  const { r: root, n: name, s: sharelink, k: token } = unb64(s.slice(5))
  if (!root || !name || !sharelink || !token) throw new Error('login code is incomplete')
  return { root, name, sharelink, token }
}

export class Login {
  constructor (app) {
    this.app = app
    this.offers = new Map() // topic -> { token, space, expires, name, done }
    this.claims = new Map() // topic -> { resolve, reject, timer }
    this.progress = null // what the running claim is doing, for the UI
    app.core.emitter.on('SpaceMessage', (e) => this.#onMessage(e).catch((err) => console.error('[login]', err.message)))
    if (process.env.RKEYCHAT_LOGIN_TRACE) app.core.emitter.on('SpaceMessage', (e) => { if (this.claims.size || this.offers.size) console.log(`[login] trace ${e.message.topic.slice(0, 8)} ${typeof e.content} ${e.content?.type ?? e.content?.app ?? String(e.content).slice(0, 30)} from ${Buffer.from(e.info?.publicKey ?? '').toString('hex').slice(0, 8)}`) })
  }

  // This pearcore instance holds rooms and login spaces, nothing else: anything that
  // isn't a room is a login space left behind by a daemon that stopped mid-login.
  // Never the one in use: leaving and rejoining the same topic in one process leaves
  // the swarm confused (seen as: the other side's answers never arrive).
  async #sweep (keep) {
    const rooms = new Set(this.app.cfg.rooms.map((r) => r.topic))
    for (const s of await this.app.core.space.list()) {
      if (rooms.has(s.topicHash) || s.topicHash === keep || this.offers.has(s.topicHash) || this.claims.has(s.topicHash)) continue
      try { await this.app.core.space.leave(s) } catch {}
    }
  }

  // A: make an offer. Returns the code to show as a QR and as text.
  //
  // With no room it is an account login, as before: the scanner becomes this account
  // on a new device and is enrolled into every room this device owns. With a room it
  // is an invitation to that room alone — the scanner keeps its own identity and its
  // other rooms, and nothing but that one room is granted.
  async offer ({ room: roomKey } = {}) {
    const cfg = this.app.cfg
    const [name] = Object.entries(cfg.participants).find(([, p]) => p.role === 'human') ?? []
    if (!name) throw new Error('this device has no account to invite anyone with')
    if (!cfg.root) throw new Error('only the device that holds the account root can hand out invitations')
    let room = null
    if (roomKey) {
      room = this.app.find(roomKey)?.room
      if (!room) throw new Error(`no room called "${roomKey}" on this device`)
      if (!room.isOwner) throw new Error(`you don't own "${room.cfg.name}", so you can't invite to it`)
    }
    const root = this.app.root().ref
    const token = randomBytes(12).toString('base64url')
    const space = await this.app.core.space.create({ spaceName: `rkeychat-login:${token.slice(0, 6)}`, permissionRead: true, permissionBroadcast: true })
    const expires = Date.now() + TTL
    this.offers.set(space.topicHash, { token, space, expires, name, done: false, room: room?.topic ?? null })
    this.#sweep(space.topicHash).catch(() => {})
    const timer = setTimeout(() => this.#close(space.topicHash), TTL)
    timer.unref?.()
    const code = room
      ? encodePair({ a: 'room', r: root, n: name, s: space.sharelink, k: token, rn: room.cfg.name })
      : encodeLogin({ r: root, n: name, s: space.sharelink, k: token })
    return { code, expires, name, room: room?.cfg.name ?? null, action: room ? 'room' : 'login' }
  }

  // B: claim an offer. Resolves with the rooms joined once A has answered.
  async claim (code) {
    const { action, root, name, sharelink, token, roomName } = decodeAny(code)
    const app = this.app
    const { addParticipant, saveConfig } = await import('./config.js')
    // Only an account login rewrites who this device is. A room invitation must leave
    // the scanner's identity and its other rooms exactly as they were — it is being
    // let into one room, not handed somebody's account.
    if (action === 'login' && !app.cfg.participants[name]) {
      for (const [n, p] of Object.entries(app.cfg.participants)) if (p.role === 'human') delete app.cfg.participants[n]
      addParticipant(app.cfg, name, { role: 'human' })
      saveConfig(app.cfg)
    }
    const step = (text) => { this.progress = { text, at: Date.now() }; console.log('[login]', text); app.emit('login-progress', this.progress) }
    step(action === 'room' ? `joining the handover space for "${roomName ?? 'a room'}"` : 'joining the login space')
    // a retry, or a relaunch mid-login: reuse what we have rather than leave and rejoin
    let space = (await app.core.space.list()).find((s) => s.sharelink === sharelink)
    if (!space) {
      try { space = await app.core.space.join(sharelink) } catch (err) { throw new Error(`couldn't join the login space: ${err.message}`) }
    }
    const topic = space.topicHash
    clearTimeout(this.leaving?.get(topic))
    this.#sweep(topic).catch(() => {})
    step(`looking for the other device (space ${topic.slice(0, 8)}, ${space.sharelink === sharelink ? 'same' : 'DIFFERENT'} link)`)
    const request = await joinRequest({ root, deviceName: app.cfg.deviceName, device: app.device, participants: app.participants })
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.claims.delete(topic); reject(new Error(`no answer from the other device after 3 minutes (${this.#peers()} peers connected; is it still showing the code?)`)) }, 180_000)
      this.claims.set(topic, { resolve, reject, timer })
    })
    // keep sending until answered: the connection may still be forming
    const send = () => app.core.messages.send(space, envelope('login-req', { token, request })).catch(() => {})
    let sent = 0
    const every = setInterval(() => { send(); if (++sent % 5 === 0) step(`waiting for the other device (${this.#peers(topic)} on the login space of ${this.#peers()} peers, ${sent * 3}s)`) }, 3000); send()
    try {
      const { invites } = await answer
      step(`enrolled; joining ${invites.length} room${invites.length === 1 ? '' : 's'}`)
      const joined = []
      for (const code of invites) {
        try {
          const inv = decodeInvite(code)
          if (app.rooms.has(inv.topic)) continue
          await app.joinRoom(code)
          joined.push(inv.name)
        } catch (err) { console.error('[login] join', err.message) }
      }
      return { name, joined }
    } catch (err) {
      step(`failed: ${err.message}`)
      throw err
    } finally {
      clearInterval(every)
      this.progress = null
      // keep the login space a little longer: a rescan of the same code reuses it
      this.leaving ??= new Map()
      const t = setTimeout(() => { this.leaving.delete(topic); app.core.space.leave(space).catch(() => {}) }, 120_000)
      t.unref?.(); this.leaving.set(topic, t)
    }
  }

  // peers we hold a connection to; with a topic, only those that announced that space
  #peers (topic) {
    const sockets = this.app.core.managers?.sockets
    if (!sockets) return 0
    try { return sockets.getConnectedSockets(topic ? { topics: [topic] } : {}).length } catch { return 0 }
  }

  async #onMessage ({ message, content }) {
    const topic = message.topic
    if (!isOurs(content)) {
      if (this.claims.has(topic) || this.offers.has(topic)) console.log(`[login] odd message on login space ${topic.slice(0, 8)}: ${typeof content} ${String(content?.type ?? content).slice(0, 40)}`)
      return
    }
    if (content.type === 'login-req') {
      const o = this.offers.get(topic)
      console.log(`[login] request from ${content.request?.device?.name ?? '?'}: ${o ? 'offer open' : 'no such offer'}`)
      if (!o) return
      const given = Buffer.from(String(content.token ?? '')); const want = Buffer.from(o.token)
      if (given.length !== want.length || !timingSafeEqual(given, want)) return
      if (Date.now() > o.expires) return this.#close(topic)
      // The new device repeats its request every few seconds until it hears back, so a
      // lost answer (or an app killed mid-login and relaunched) just means we answer again.
      // approve() skips keys that are already in, so repeating it changes nothing.
      const device = content.request?.device?.ref
      const first = !o.done || o.device !== device
      o.done = true; o.device = device
      // An account login enrolls the device everywhere this machine owns. A room
      // invitation enrolls it in that one room and grants nothing else — the scanner
      // never learns the other rooms exist.
      const invites = []
      const owned = [...this.app.rooms.values()].filter(({ room }) => room.isOwner && (!o.room || room.topic === o.room))
      if (o.room && !owned.length) console.error('[login] the offered room is gone; nothing granted')
      for (const { room } of owned) {
        try { await room.approve(content.request); invites.push(encodeInvite(room.cfg)) } catch (err) { console.error(`[login] ${room.cfg.name}:`, err.message) }
      }
      await this.app.core.messages.send(o.space, envelope('login-ok', { invites, name: o.name }))
      if (first) {
        const who = content.request?.device?.name ?? 'a device'
        console.log(o.room ? `[login] ${who} was let into ${invites.length === 1 ? 'the room' : 'no room'}` : `[login] ${who} logged in to ${invites.length} room(s)`)
        this.app.emit('login', { device: who, rooms: invites.length, room: o.room ?? null })
      }
      // stay a while: the same device may still be asking, or come back after a restart
      clearTimeout(o.linger); o.linger = setTimeout(() => this.#close(topic), 90_000); o.linger.unref?.()
    }
    if (content.type === 'login-ok') {
      const c = this.claims.get(topic)
      if (!c) { console.log(`[login] answer for ${topic.slice(0, 8)} but waiting on ${[...this.claims.keys()].map((k) => k.slice(0, 8)).join(',') || 'nothing'}`); return }
      clearTimeout(c.timer); this.claims.delete(topic)
      c.resolve({ invites: content.invites ?? [] })
    }
  }

  async #close (topic) {
    const o = this.offers.get(topic)
    if (!o) return
    this.offers.delete(topic)
    clearTimeout(o.linger)
    try { await this.app.core.space.leave(o.space) } catch {}
  }

  pending () {
    return [...this.offers.values()].filter((o) => !o.done && o.expires > Date.now()).map((o) => ({ expires: o.expires }))
  }

  claiming () {
    return this.progress
  }
}
