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
export async function makeMessage (signer, { room, text, mentions = [], re = [], depth = 0, via, att, ts = Date.now() }) {
  return signBody('rkeychat-msg', signer, { kind: 'msg', id: newId(), room, ts, text, mentions, re, depth, via, att })
}

// A control: budget and pause changes. Only admins' controls count.
//   action: 'extend' (n) | 'unlimited' | 'until' (until: ms epoch) | 'pause' | 'resume' | 'reset'
//   with agent set: 'pause' | 'resume' | 'limit' (n) for that one agent
export async function makeControl (signer, { room, action, n, until, agent, style, ts = Date.now() }) {
  return signBody('rkeychat-control', signer, { kind: 'control', id: newId(), room, ts, action, n, until, agent, style })
}

// Activity: what an agent is doing right now (reading, running, editing).
// Shown to people on request; never part of the conversation agents read.
export async function makeActivity (signer, { room, text, ts = Date.now() }) {
  return signBody('rkeychat-activity', signer, { kind: 'activity', id: newId(), room, ts, text: String(text).slice(0, 2000) })
}

// A reaction: an emoji on a message, toggled on or off. Never wakes anyone.
export async function makeReaction (signer, { room, target, emoji, on = true, ts = Date.now() }) {
  return signBody('rkeychat-react', signer, { kind: 'react', id: newId(), room, ts, target: String(target), emoji: String(emoji).slice(0, 16), on: !!on })
}

// Moderation: an admin removes a message from the room. Its attachments'
// hashes are blocked here too, so they can't be served or re-posted in this
// room. (Copies people already downloaded stay theirs.)
export async function makeRedaction (signer, { room, target, hashes = [], reason, ts = Date.now() }) {
  return signBody('rkeychat-redact', signer, { kind: 'redact', id: newId(), room, ts, target: String(target), hashes, reason })
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
