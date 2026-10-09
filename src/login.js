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

import { randomBytes } from 'node:crypto'
import { bytesToHex } from '@noble/hashes/utils.js'
import { digest, verifySig } from 'rkey'
import { envelope, isOurs } from './proto.js'
import { joinRequest } from './room.js'
import { encodeInvite, decodeInvite } from './invite.js'
import { decodeShareLink } from 'pearcore/src/utils/sharelink.utils.js'

// How long an invitation stays answerable. Long enough to send someone the link and
// let them get to it; short enough that one you forgot about dies by itself. It is
// used-once whatever happens, and the host can cancel any of them early.
const TTL = 60 * 60_000
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString())

// An invitation is a **bare pearcore sharelink**. Nothing of ours rides on the wire.
//
// Everything we used to wrap around it is already there or can wait:
//   what the scan is for  -> the space NAME, which we choose (invite: / login:)
//   the one-time secret   -> the NONCE, which is fresh per space and unguessable
//   who is inviting, the room's name, the account root -> sent in band once they join
//
// The nonce is the challenge. pearcore's handover space is public-read, so a peer
// that learned the topic some other way could knock on it; the requester therefore
// proves it holds the nonce by signing it. That is not an extra secret — it is the
// one already in the link, used rather than taken on trust.
export const INVITE = 'rkeychat-invite'
export const LOGIN = 'rkeychat-login'
export const PROOF = 'rkeychat-handover'

export function readLink (code) {
  const s = String(code ?? '').trim()
  const d = s.startsWith('pearcore://') || s.includes('://') ? decodeShareLink(s) : null
  if (!d) throw new Error("that isn't a pearcore link")
  const [kind] = String(d.spaceName ?? '').split(':')
  if (kind !== INVITE && kind !== LOGIN) throw new Error(`that link is for "${d.spaceName}", not an rKeyChat invitation`)
  return { action: kind === INVITE ? 'room' : 'login', sharelink: s, nonce: d.nonce, spaceName: d.spaceName }
}
export const isInvitation = (code) => { try { readLink(code); return true } catch { return false } }

// Proof that the holder of a key also holds the nonce from the link. Domain-separated
// and bound to this space, so it cannot be lifted into another one.
export const proofBody = (topic, nonce) => ({ topic, nonce })
export const signProof = async (signer, topic, nonce) => bytesToHex(await signer.sign(digest(PROOF, proofBody(topic, nonce))))
export const checkProof = (ref, sig, topic, nonce) => {
  try { return verifySig(ref, sig, digest(PROOF, proofBody(topic, nonce))) } catch { return false }
}

export class Login {
  constructor (app) {
    this.app = app
    // 'ask' (default) means nothing is granted until the host says so. 'auto' is the
    // old behaviour, kept only because a scripted test wants it.
    this.approve = process.env.RKEYCHAT_AUTO_APPROVE === '1' ? 'auto' : 'ask'
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

  // A: make an invitation. Returns a bare pearcore link.
  //
  // An hour by default: long enough to send someone the link and let them get to it,
  // short enough that a forgotten one dies on its own. It is used-once regardless,
  // and the host can see and cancel every live one (`pending`, `cancel`).
  async offer ({ room: roomKey, ttl = TTL } = {}) {
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
    const kind = room ? INVITE : LOGIN
    const space = await this.app.core.space.create({
      spaceName: `${kind}:${randomBytes(3).toString('hex')}`,
      permissionRead: true,
      permissionBroadcast: true
    })
    const expires = Date.now() + ttl
    this.offers.set(space.topicHash, {
      space, expires, name, done: false, used: null,
      nonce: decodeShareLink(space.sharelink).nonce,
      room: room?.topic ?? null, roomName: room?.cfg.name ?? null
    })
    this.#sweep(space.topicHash).catch(() => {})
    const timer = setTimeout(() => this.#close(space.topicHash), ttl)
    timer.unref?.()
    return { code: space.sharelink, expires, name, room: room?.cfg.name ?? null, action: room ? 'room' : 'login', topic: space.topicHash }
  }

  // Everything still open, so the host can see what is outstanding and kill it.
  pending () {
    const now = Date.now()
    return [...this.offers.entries()]
      .filter(([, o]) => o.expires > now)
      .map(([topic, o]) => ({ topic, expires: o.expires, room: o.roomName, action: o.room ? 'room' : 'login', used: !!o.used }))
  }

  // Who is at the door. The host sees the device's name and the start of its key,
  // which is what can actually be compared against the other screen.
  asking () {
    return [...this.offers.entries()]
      .filter(([, o]) => o.asked && !o.granted && o.expires > Date.now())
      .map(([topic, o]) => ({ ...o.asked, topic, expires: o.expires }))
  }

  // Say yes. The waiting device is still knocking every three seconds, so the next
  // knock goes through and nothing has to be scanned again.
  grant (topic) {
    const key = this.#offerKey(topic)
    const o = this.offers.get(key)
    if (!o?.asked) throw new Error('nobody is waiting on that invitation')
    o.granted = true
    return { granted: o.asked.deviceName, room: o.roomName }
  }

  async deny (topic) {
    const key = this.#offerKey(topic)
    const o = this.offers.get(key)
    await this.#refuse(o, 'the invitation was declined')
    await this.#close(key)
    return { denied: o.asked?.deviceName ?? 'the device' }
  }

  #offerKey (topic) {
    if (this.offers.has(topic)) return topic
    const hit = [...this.offers.keys()].find((t) => t.startsWith(String(topic ?? '')))
    if (!hit) throw new Error('no such invitation (it may have expired already)')
    return hit
  }

  async cancel (topic) {
    const key = this.#offerKey(topic)
    await this.#close(key)
    return { cancelled: key }
  }

  // B: claim an invitation. Resolves once the host has approved and we are in.
  //
  // Two short exchanges inside the handover space: we prove we hold the nonce from
  // the link, the host tells us what this invitation is and who is offering it, then
  // we send the signed join request. Nothing is granted until the host says so.
  async claim (code) {
    const { action, sharelink, nonce } = readLink(code)
    const app = this.app
    const step = (text) => { this.progress = { text, at: Date.now() }; console.log('[login]', text); app.emit('login-progress', this.progress) }
    step(action === 'room' ? 'joining the handover space' : 'joining the login space')
    // a retry, or a relaunch mid-join: reuse what we have rather than leave and rejoin
    let space = (await app.core.space.list()).find((s2) => s2.sharelink === sharelink)
    if (!space) {
      try { space = await app.core.space.join(sharelink) } catch (err) { throw new Error(`couldn't join the handover space: ${err.message}`) }
    }
    const topic = space.topicHash
    clearTimeout(this.leaving?.get(topic))
    this.#sweep(topic).catch(() => {})
    const proof = await signProof(app.device, topic, nonce)

    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.claims.delete(topic); reject(new Error(`no answer after 3 minutes (${this.#peers()} peers connected; is the other device still showing it?)`)) }, 180_000)
      this.claims.set(topic, { resolve, reject, timer, proof, nonce, action, sent: false, host: decodeShareLink(sharelink).publicKey })
    })
    // Keep knocking until the host answers: the connection may still be forming, and
    // the host may not be looking yet. `hi` carries the proof; everything we need to
    // build the request comes back in `hello`.
    const hi = () => app.core.messages.send(space, envelope('handover-hi', { proof, device: app.device.ref })).catch(() => {})
    let sent = 0
    const every = setInterval(() => { hi(); if (++sent % 5 === 0) step(`waiting for the other device (${this.#peers(topic)} here of ${this.#peers()} peers, ${sent * 3}s)`) }, 3000)
    hi()
    try {
      const { invites, name } = await answer
      step(`approved; joining ${invites.length} room${invites.length === 1 ? '' : 's'}`)
      const joined = []
      for (const c of invites) {
        try {
          const inv = decodeInvite(c)
          if (app.rooms.has(inv.topic)) continue
          await app.joinRoom(c)
          joined.push(inv.name)
        } catch (err) { console.error('[login] join', err.message) }
      }
      return { name, joined, action }
    } catch (err) {
      step(`failed: ${err.message}`)
      throw err
    } finally {
      clearInterval(every)
      this.claims.delete(topic)
      this.progress = null
      // The handover space has done its job. Leave promptly — the conversation
      // continues inside the real room now, and this link is finished with.
      app.core.space.leave(space).catch(() => {})
    }
  }

  // Take the account's name only for a login. A room invitation must leave the
  // scanner's identity and its other rooms exactly as they were.
  async #becomeIfLogin (action, name) {
    if (action !== 'login' || !name) return
    const app = this.app
    if (app.cfg.participants[name]) return
    const { addParticipant, saveConfig } = await import('./config.js')
    for (const [n, p] of Object.entries(app.cfg.participants)) if (p.role === 'human') delete app.cfg.participants[n]
    addParticipant(app.cfg, name, { role: 'human' })
    saveConfig(app.cfg)
  }

  // peers we hold a connection to; with a topic, only those that announced that space
  #peers (topic) {
    const sockets = this.app.core.managers?.sockets
    if (!sockets) return 0
    try { return sockets.getConnectedSockets(topic ? { topics: [topic] } : {}).length } catch { return 0 }
  }

  async #onMessage ({ message, content }) {
    const topic = message.topic
    if (!isOurs(content)) return
    const o = this.offers.get(topic)
    const c = this.claims.get(topic)

    // ---- host side
    if (o && (content.type === 'handover-hi' || content.type === 'login-req')) {
      const device = String(content.device ?? content.request?.device?.ref ?? '')
      // The nonce from the link, signed by the asking key. A peer that found the
      // topic some other way cannot produce this, because it never saw the link.
      if (!device || !checkProof(device, String(content.proof ?? ''), topic, o.nonce)) {
        console.log(`[login] ${topic.slice(0, 8)}: knock without the link's nonce — ignored`)
        return
      }
      if (Date.now() > o.expires) return this.#refuse(o, 'that invitation has expired')
      // Used once. The device that used it may still be retrying (a lost answer, an
      // app restarted mid-join), so it is answered again; anyone else is told plainly
      // that the invitation is spent rather than left hanging.
      if (o.used && o.used !== device) return this.#refuse(o, 'that invitation has already been used')

      if (content.type === 'handover-hi') {
        await this.app.core.messages.send(o.space, envelope('handover-hello', {
          action: o.room ? 'room' : 'login',
          root: this.app.root().ref,
          name: o.name,
          roomName: o.roomName
        }))
        return
      }

      // The host decides. A link is a bearer credential — whoever photographed the
      // screen holds it — so the only thing tying an invitation to the person it was
      // meant for is someone looking at this and saying yes.
      if (this.approve !== 'auto' && !o.granted) {
        if (!o.asked) {
          o.asked = { device, deviceName: content.request?.device?.name ?? 'a device', room: o.roomName, action: o.room ? 'room' : 'login', at: Date.now() }
          this.app.emit('login-ask', { ...o.asked, topic })
          console.log(`[login] ${o.asked.deviceName} (${device.slice(8, 20)}…) wants ${o.roomName ? `into "${o.roomName}"` : 'to log in'} — waiting for you`)
        }
        return // nothing is granted until the host grants it
      }
      const invites = []
      const owned = [...this.app.rooms.values()].filter(({ room }) => room.isOwner && (!o.room || room.topic === o.room))
      if (o.room && !owned.length) return this.#refuse(o, 'that room is gone')
      for (const { room } of owned) {
        try { await room.approve(content.request); invites.push(encodeInvite(room.cfg)) } catch (err) { console.error(`[login] ${room.cfg.name}:`, err.message) }
      }
      const first = !o.used
      o.used = device
      o.done = true
      await this.app.core.messages.send(o.space, envelope('login-ok', { invites, name: o.name }))
      if (first) {
        const who = content.request?.device?.name ?? 'a device'
        console.log(o.room ? `[login] ${who} was let into ${o.roomName}` : `[login] ${who} logged in to ${invites.length} room(s)`)
        this.app.emit('login', { device: who, rooms: invites.length, room: o.roomName ?? null })
      }
      // A short grace for the same device to re-ask, then the space is gone for good.
      clearTimeout(o.linger)
      o.linger = setTimeout(() => this.#close(topic), 30_000)
      o.linger.unref?.()
      return
    }

    // ---- joining side
    if (!c) return
    if (content.type === 'handover-hello') {
      if (c.sent) return
      // The link names the key that made this space. Anyone else on it offering to be
      // the host is trying to get us to consent to *their* root, so they are ignored.
      if (String(message.publicKey ?? '').toLowerCase() !== String(c.host ?? '').toLowerCase()) {
        console.log(`[login] hello from ${String(message.publicKey).slice(0, 8)} but the link says ${String(c.host).slice(0, 8)} — ignored`)
        return
      }
      c.sent = true
      await this.#becomeIfLogin(c.action, content.name)
      const request = await joinRequest({
        root: content.root,
        deviceName: this.app.cfg.deviceName,
        device: this.app.device,
        participants: this.app.participants
      })
      this.app.core.messages.send(this.offers.get(topic)?.space ?? message.space ?? await this.#spaceFor(topic),
        envelope('login-req', { proof: c.proof, device: this.app.device.ref, request })).catch(() => {})
      return
    }
    if (content.type === 'login-refused') {
      clearTimeout(c.timer); this.claims.delete(topic)
      c.reject(new Error(String(content.reason ?? 'the other device refused')))
      return
    }
    if (content.type === 'login-ok') {
      clearTimeout(c.timer); this.claims.delete(topic)
      c.resolve({ invites: content.invites ?? [], name: content.name })
    }
  }

  async #spaceFor (topic) {
    return (await this.app.core.space.list()).find((s) => s.topicHash === topic)
  }

  // Say no out loud. Silence looks identical to "still connecting", and leaves the
  // other side knocking for three minutes before giving up.
  async #refuse (o, reason) {
    try { await this.app.core.messages.send(o.space, envelope('login-refused', { reason })) } catch {}
  }

  async #close (topic) {
    const o = this.offers.get(topic)
    if (!o) return
    this.offers.delete(topic)
    clearTimeout(o.linger)
    try { await this.app.core.space.leave(o.space) } catch {}
  }

  claiming () {
    return this.progress
  }
}
