// rKeyChat wire format. Everything rides inside pearcore SpaceMessage payloads
// as { app: 'rkeychat', v: 0, type, ... }. pearcore signs each envelope with
// the sending *device* key; chat messages and controls are additionally signed
// by their *author's* rKey-enrolled key, so they stay verifiable when relayed
// or replayed from history by any peer.

import { randomBytes } from 'node:crypto'
import { bytesToHex } from '@noble/hashes/utils.js'
import { digest, verifySig } from 'rkey'

export const APP = 'rkeychat'
export const V = 0

// Scopes rKeyChat defines on top of rKey core.
export const SCOPES = {
  host: 'host', // a device allowed to carry room traffic (pearcore whitelist)
  chat: 'chat', // may post
  admin: 'admin', // a human: can steer budget/pause, un-addressed messages go to everyone
  agent: 'agent' // an AI participant
}

export const envelope = (type, body) => JSON.parse(JSON.stringify({ app: APP, v: V, type, ...body }))
export const isOurs = (payload) => payload && typeof payload === 'object' && payload.app === APP && payload.v === V

const newId = () => randomBytes(12).toString('hex')

// Conversations: a room holds many. A record's `conv` names the one it belongs to; records
// without one (everything before 2026-11-18) belong to the default conversation, MAIN. The
// field is signed like any other, and old daemons verify and store it unchanged (verifyBody
// covers every field), they just show every conversation as one.
export const MAIN = 'main'
export const isConvId = (s) => s === MAIN || /^[0-9a-f]{8,32}$/.test(String(s ?? ''))
export const newConvId = () => randomBytes(8).toString('hex')
// what goes into a signed body: nothing for the default conversation, so old records and new ones agree
const convField = (conv) => conv && conv !== MAIN ? String(conv) : undefined

// Strip undefined fields: pearcore's canonicalStringify writes them as a bare
// `undefined` (invalid JSON), and the receiver then silently drops the whole
// message. rKey's canonical() already ignores them, so signatures don't change.
export const clean = (obj) => JSON.parse(JSON.stringify(obj))

async function signBody (domain, signer, body) {
  const full = clean({ ...body, author: signer.ref })
  return { ...full, sig: bytesToHex(await signer.sign(digest(domain, full))) }
}

function verifyBody (domain, obj) {
  if (!obj || typeof obj.sig !== 'string' || typeof obj.author !== 'string') return false
  const { sig, ...body } = obj
  return verifySig(obj.author, sig, digest(domain, body))
}

// A chat message. `re` lists the messages this one answers; `depth` is how
// many agent hops it is from the last human message (humans are always 0).
// `via: 'voice'` marks a dictated message (signed, so agents can trust the flag).
// `att` lists attachments by content hash: [{ hash, mime, size, duration, peaks, transcript }].
export async function makeMessage (signer, { room, text, mentions = [], re = [], depth = 0, via, att, conv, ts = Date.now() }) {
  return signBody('rkeychat-msg', signer, { kind: 'msg', id: newId(), room, ts, text, mentions, re, depth, via, att, conv: convField(conv) })
}

// A control: budget and pause changes. Only admins' controls count.
//   action: 'extend' (n) | 'unlimited' | 'until' (until: ms epoch) | 'pause' | 'resume' | 'reset'
//   with agent set: 'pause' | 'resume' | 'limit' (n) for that one agent
// Besides the round controls: 'charter' (text = the room's purpose, order = which
// agent answers an open-floor message first, agents = per-agent rules for THIS room:
// { [name]: { role, wake, backupFor } } where wake is 'order' (in the turn order),
// 'mention' (only when named or replied to) or 'backup' (silent until backupFor is
// quiet past its window or offline, then plays its part)) and 'rename'.
// Conversations and apps: 'conv' (conv = its id; text = title; archived; runtime) describes one
// conversation of the room, latest record per field wins; 'app' (app = which app made this
// room, role = what the room is to it: 'chat' | 'project', name, icon) is the signed note
// PearDrive's "My Apps" asks for, so a space can say which app it belongs to. 'project' (name, home, text, org)
// asks one of the owner's devices to make a project; the answering room's 'app' note carries `request` (that
// record's id). 'close' (owner only) says the room is finished: every device drops it.
// Permissions (docs/project-agents.md "Asking a person"): an agent's 'ask' record (kind 'ask', below) is answered
// by an 'answer' control { ask: <the ask's id>, choice } from one of the owner's own keys only (account-gated).
export const ASK_CHOICES = ['allow_once', 'allow_always', 'reject_once', 'reject_always']
export const APP_ROLES = ['chat', 'project']
export const WAKE_MODES = ['order', 'mention', 'backup']
export function cleanAgentRules (agents) {
  if (!agents || typeof agents !== 'object') return undefined
  const out = {}
  for (const [name, r] of Object.entries(agents).slice(0, 32)) {
    if (!r || typeof r !== 'object') continue
    const rule = {}
    if (r.role) rule.role = String(r.role).slice(0, 4000)
    if (WAKE_MODES.includes(r.wake) && r.wake !== 'order') rule.wake = r.wake
    if (rule.wake === 'backup' && r.backupFor) rule.backupFor = String(r.backupFor).slice(0, 80)
    if (Number(r.tokensPerDay) > 0) rule.tokensPerDay = Math.round(Number(r.tokensPerDay))
    if (rule.wake === 'backup' && !rule.backupFor) delete rule.wake
    if (Object.keys(rule).length) out[String(name).slice(0, 80)] = rule
  }
  return out
}
// A 'seat' control's payload: the settings asked for (a request from any of the owner's devices), or how the seat
// now runs (`applied: true`, written by the device that hosts it; it carries the providers that host has, names only).
const SEAT_STR = ['permissionMode', 'model', 'provider', 'via', 'dir']
function cleanSeat (seat) {
  if (seat === undefined) return undefined
  if (!seat || typeof seat !== 'object') return {}
  const out = {}
  for (const k of SEAT_STR) if (seat[k] !== undefined) out[k] = seat[k] === null ? null : String(seat[k]).slice(0, 200)
  if (seat.askMinutes !== undefined) out.askMinutes = seat.askMinutes === null ? null : Number(seat.askMinutes)
  if (seat.applied) out.applied = true
  if (Array.isArray(seat.providers)) out.providers = seat.providers.slice(0, 16).map((p) => ({ name: String(p?.name ?? '').slice(0, 24), hasToken: !!p?.hasToken }))
  if (seat.auto !== undefined) out.auto = seat.auto === null ? null : cleanAuto(seat.auto, { grant: true })
  return out
}

// An Auto grant or cap: { minutes, turns } (null = no limit); a host's echo of a seat's grant also says since when,
// how many turns it has used and which mode it goes back to.
const num = (v) => (v == null || v === '' ? null : Number(v))
function cleanAuto (auto, { grant = false } = {}) {
  if (!auto || typeof auto !== 'object') return { minutes: null, turns: null }
  const out = { minutes: num(auto.minutes), turns: num(auto.turns) }
  if (grant) {
    if (auto.since !== undefined) out.since = Number(auto.since)
    if (auto.used !== undefined) out.used = Number(auto.used)
    if (auto.back !== undefined) out.back = String(auto.back).slice(0, 24)
  }
  return out
}

export async function makeControl (signer, { room, action, n, until, agent, style, text, order, agents, name, conv, archived, runtime, app, role, icon, home, org, request, ask, choice, seat, auto, rule, revoke, ts = Date.now() }) {
  return signBody('rkeychat-control', signer, {
    kind: 'control', id: newId(), room, ts, action, n, until, agent, style,
    text: text === undefined ? undefined : String(text).slice(0, 8000),
    order: Array.isArray(order) ? order.map(String).slice(0, 32) : undefined,
    agents: cleanAgentRules(agents),
    name: name === undefined ? undefined : String(name).trim().slice(0, 80),
    // a 'conv' control names its conversation outright (MAIN included: the default one can be renamed)
    conv: conv === undefined ? undefined : String(conv).slice(0, 32),
    archived: archived === undefined ? undefined : !!archived,
    runtime: runtime === undefined ? undefined : runtime === null ? null : String(runtime).slice(0, 80),
    app: app === undefined ? undefined : String(app).slice(0, 40),
    role: role === undefined ? undefined : String(role).slice(0, 20),
    icon: icon === undefined ? undefined : String(icon).slice(0, 20000),
    // the device a project lives on: { device: <device key ref>, name: 'macbook' } (app and project controls)
    home: home === undefined ? undefined : home === null ? null : { device: String(home.device).slice(0, 140), name: String(home.name ?? '').slice(0, 80) },
    // the organization a project belongs to (a name people use: 'Bitcoin Audible'); null takes it out of one
    org: org === undefined ? undefined : org === null ? null : String(org).trim().slice(0, 80),
    // the 'project' request (its record id) an 'app' note answers: the device that asked matches the room by it
    request: request === undefined ? undefined : String(request).slice(0, 32),
    // an 'answer': which ask, and what was chosen (one of ASK_CHOICES)
    ask: ask === undefined ? undefined : String(ask).slice(0, 32),
    choice: choice === undefined ? undefined : String(choice).slice(0, 16),
    // a 'seat' control (`agent` names the seat): the settings asked for, or how it now runs (seat-settings.js)
    seat: cleanSeat(seat),
    // an 'auto' control: the room's cap on Auto grants
    auto: auto === undefined ? undefined : cleanAuto(auto),
    // a 'grant' control: a rule the project's agents may use without asking (src/grants.js), or its withdrawal
    rule: rule === undefined ? undefined : String(rule).slice(0, 600),
    revoke: revoke ? true : undefined
  })
}

// An agent asks a person for a permission its seat's tool list does not settle (src/acp.js): which tool, what it
// would do (one line), the input in full (trimmed), the choices the agent offered, and when the question lapses.
// Signed by the agent; shown in the conversation; answered by an 'answer' control from the owner's keys.
export async function makeAsk (signer, { room, conv, tool, what, input, options = [], expires, rule, ruleLabel, ts = Date.now() }) {
  return signBody('rkeychat-ask', signer, {
    kind: 'ask', id: newId(), room, ts, conv: convField(conv),
    tool: String(tool ?? '').slice(0, 40),
    what: String(what ?? '').replace(/\s+/g, ' ').slice(0, 200),
    input: input === undefined ? undefined : String(input).slice(0, 2000),
    options: (Array.isArray(options) ? options : []).slice(0, 8).map((o) => ({ id: String(o.id ?? o.optionId ?? '').slice(0, 64), kind: String(o.kind ?? '').slice(0, 16), name: o.name === undefined ? undefined : String(o.name).slice(0, 80) })),
    expires: Number(expires) || ts + 10 * 60_000,
    // what "Allow for this project" would grant (src/grants.js grantFor): the rule, and how the card words it
    rule: rule ? String(rule).slice(0, 600) : undefined,
    ruleLabel: rule && ruleLabel ? String(ruleLabel).slice(0, 200) : undefined
  })
}

// Activity: what an agent is doing right now (reading, running, editing).
// Shown to people on request; never part of the conversation agents read.
// `claim` lists the message ids this agent is now answering (turn order: the
// next agent in line stands down when it sees an earlier one's claim).
// `usage` is what one wake of this agent actually cost, as reported by the runtime
// that spent it: { model, in, out, cacheRead, cacheWrite }. A wake is the unit of
// spend (an agent pays for its whole context before it writes a word), so this is
// what the caps in the room's charter are measured against.
export const cleanUsage = (u) => {
  if (!u || typeof u !== 'object') return undefined
  const n = (x) => Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x)) : 0
  const out = { model: String(u.model ?? '').slice(0, 60), in: n(u.in), out: n(u.out), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite) }
  return (out.in + out.out + out.cacheRead + out.cacheWrite) > 0 ? out : undefined
}
export async function makeActivity (signer, { room, text, claim, usage, conv, ts = Date.now() }) {
  return signBody('rkeychat-activity', signer, { kind: 'activity', id: newId(), room, ts, text: String(text).slice(0, 2000), claim: Array.isArray(claim) && claim.length ? claim.map(String).slice(0, 64) : undefined, usage: cleanUsage(usage), conv: convField(conv) })
}

// A reaction: an emoji on a message, toggled on or off. Never wakes anyone.
export async function makeReaction (signer, { room, target, emoji, on = true, ts = Date.now() }) {
  return signBody('rkeychat-react', signer, { kind: 'react', id: newId(), room, ts, target: String(target), emoji: String(emoji).slice(0, 16), on: !!on })
}

// Moderation: an admin removes a message from the room. Its attachments'
// hashes are blocked here too, so they can't be served or re-posted in this
// room. (Copies people already downloaded stay theirs.)
// `hashes` blocks those files in this room. `unblock` lifts a block applied earlier
// — banning a file by accident has to be recoverable, or it is a footgun. An old
// peer that doesn't know `unblock` simply keeps the block, which fails closed.
export async function makeRedaction (signer, { room, target, hashes = [], unblock, reason, ts = Date.now() }) {
  return signBody('rkeychat-redact', signer, {
    kind: 'redact', id: newId(), room, ts, target: String(target), hashes, reason,
    unblock: Array.isArray(unblock) && unblock.length ? unblock.map(String).slice(0, 64) : undefined
  })
}

// An invite delivered through a room both sides already share: "your device
// has been signed into room X; here is how to reach it". Admin-only.
export async function makeInvite (signer, { room, to, code, name, ts = Date.now() }) {
  return signBody('rkeychat-invite', signer, { kind: 'invite', id: newId(), room, ts, to, code, name })
}

export function verifyRecord (rec) {
  if (rec?.kind === 'invite') return verifyBody('rkeychat-invite', rec)
  if (rec?.kind === 'redact') return verifyBody('rkeychat-redact', rec)
  if (rec?.kind === 'react') return verifyBody('rkeychat-react', rec)
  if (rec?.kind === 'msg') return verifyBody('rkeychat-msg', rec)
  if (rec?.kind === 'control') return verifyBody('rkeychat-control', rec)
  if (rec?.kind === 'activity') return verifyBody('rkeychat-activity', rec)
  if (rec?.kind === 'ask') return verifyBody('rkeychat-ask', rec)
  return false
}

export function parseMentions (text, names) {
  const found = new Set()
  for (const m of String(text).matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)) {
    const n = m[1].toLowerCase()
    if (names.includes(n)) found.add(n)
    if (n === 'all' || n === 'everyone') names.forEach((x) => found.add(x))
  }
  return [...found]
}
