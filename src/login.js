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
export function decodeLogin (code) {
  const s = String(code ?? '').trim()
  if (!s.startsWith('rkl1.')) throw new Error('that isn\'t a login code (they start with rkl1.)')
  const { r: root, n: name, s: sharelink, t: topic, k: token } = unb64(s.slice(5))
  if (!root || !name || !sharelink || !topic || !token) throw new Error('login code is incomplete')
  return { root, name, sharelink, topic, token }
}

export class Login {
  constructor (app) {
    this.app = app
    this.offers = new Map() // topic -> { token, space, expires, name, done }
    this.claims = new Map() // topic -> { resolve, reject, timer }
    app.core.emitter.on('SpaceMessage', (e) => this.#onMessage(e).catch((err) => console.error('[login]', err.message)))
  }

  // A: make an offer. Returns the code to show as a QR and as text.
  async offer () {
    const cfg = this.app.cfg
    const [name] = Object.entries(cfg.participants).find(([, p]) => p.role === 'human') ?? []
    if (!name) throw new Error('this device has no account to log another device into')
    if (!cfg.root) throw new Error('only the device that holds the account root can log other devices in')
    const root = this.app.root().ref
    const token = randomBytes(16).toString('base64url')
    const space = await this.app.core.space.create({ spaceName: `rkeychat-login:${token.slice(0, 6)}`, permissionRead: true, permissionBroadcast: true })
    const expires = Date.now() + TTL
    this.offers.set(space.topicHash, { token, space, expires, name, done: false })
    const timer = setTimeout(() => this.#close(space.topicHash), TTL)
    timer.unref?.()
    return { code: encodeLogin({ r: root, n: name, s: space.sharelink, t: space.topicHash, k: token }), expires, name }
  }

  // B: claim an offer. Resolves with the rooms joined once A has answered.
  async claim (code) {
    const { root, name, sharelink, topic, token } = decodeLogin(code)
    const app = this.app
    const { addParticipant, saveConfig } = await import('./config.js')
    if (!app.cfg.participants[name]) {
      // this device takes the account's name; its own root stays unused for a person
      for (const [n, p] of Object.entries(app.cfg.participants)) if (p.role === 'human') delete app.cfg.participants[n]
      addParticipant(app.cfg, name, { role: 'human' })
      saveConfig(app.cfg)
    }
    const list = await app.core.space.list()
    const space = list.find((s) => s.topicHash === topic) ?? (await app.core.space.join(sharelink), (await app.core.space.list()).find((s) => s.topicHash === topic))
    if (!space) throw new Error('couldn\'t join the login space')
    const request = await joinRequest({ root, deviceName: app.cfg.deviceName, device: app.device, participants: app.participants })
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.claims.delete(topic); reject(new Error('no answer from the other device (is it still showing the code?)')) }, 90_000)
      this.claims.set(topic, { resolve, reject, timer })
    })
    // keep sending until answered: the connection may still be forming
    const send = () => app.core.messages.send(space, envelope('login-req', { token, request })).catch(() => {})
    const every = setInterval(send, 3000); send()
    try {
      const { invites } = await answer
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
    } finally {
      clearInterval(every)
      try { await app.core.space.leave(space) } catch {}
    }
  }

  async #onMessage ({ message, content }) {
    if (!isOurs(content)) return
    const topic = message.topic
    if (content.type === 'login-req') {
      const o = this.offers.get(topic)
      if (!o || o.done) return
      const given = Buffer.from(String(content.token ?? '')); const want = Buffer.from(o.token)
      if (given.length !== want.length || !timingSafeEqual(given, want)) return
      if (Date.now() > o.expires) return this.#close(topic)
      o.done = true
      const invites = []
      for (const { room } of this.app.rooms.values()) {
        if (!room.isOwner) continue // rooms owned by others: their owner must approve the new device (later: forward the request)
        try { await room.approve(content.request); invites.push(encodeInvite(room.cfg)) } catch (err) { console.error(`[login] ${room.cfg.name}:`, err.message) }
      }
      await this.app.core.messages.send(o.space, envelope('login-ok', { invites, name: o.name }))
      setTimeout(() => this.#close(topic), 15_000).unref?.()
      this.app.emit('login', { device: content.request?.device?.name, rooms: invites.length })
    }
    if (content.type === 'login-ok') {
      const c = this.claims.get(topic)
      if (!c) return
      clearTimeout(c.timer); this.claims.delete(topic)
      c.resolve({ invites: content.invites ?? [] })
    }
  }

  async #close (topic) {
    const o = this.offers.get(topic)
    if (!o) return
    this.offers.delete(topic)
    try { await this.app.core.space.leave(o.space) } catch {}
  }

  pending () {
    return [...this.offers.values()].filter((o) => !o.done && o.expires > Date.now()).map((o) => ({ expires: o.expires }))
  }
}
