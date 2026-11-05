// Device config at $RKEYCHAT_DATA (default ~/.rkeychat)/config.json.
// v0 keeps secret keys here in plaintext (chmod 600). The root key only
// exists on the owner device; it moves to a signer app / NFC card later.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { generate, signerFromSecret } from 'rkey'

export const dataDir = () => process.env.RKEYCHAT_DATA || join(homedir(), '.rkeychat')
const path = () => join(dataDir(), 'config.json')

export function loadConfig () {
  if (!existsSync(path())) return null
  return JSON.parse(readFileSync(path(), 'utf8'))
}

export function saveConfig (cfg) {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(path(), JSON.stringify(cfg, null, 2))
  chmodSync(path(), 0o600)
}

export function newConfig ({ name = hostname().split('.')[0].toLowerCase(), port = 4455 } = {}) {
  return {
    deviceName: name,
    port,
    pearcore: { username: 'rkeychat', password: randomBytes(24).toString('hex') },
    root: null, // { suite, secretKey } — this person's identity root (created with the first room)
    rooms: [], // [{ name, topic, sharelink, root, dir }]
    participants: {} // name -> { secretKey, suite, role: 'human'|'agent', bridge: { kind, ... } }
  }
}

// v0.0.1 configs had a single `room`; move it into `rooms` in place.
export function migrate (cfg) {
  if (!cfg.rooms) cfg.rooms = []
  if (cfg.room) {
    cfg.rooms.push({ ...cfg.room, dir: 'room', ...(cfg.pendingJoin ? { pendingJoin: true } : {}) })
    delete cfg.room
    delete cfg.pendingJoin
    saveConfig(cfg)
  }
  return cfg
}

// A participant's secrets live in one of two places. Device agents and people keep them
// in config.json. A *project agent* (bridge kind `claude`) keeps them in the project
// folder — `<dir>/.rkeychat/agent.json` — so the folder is the identity: its key, its
// account root, and the Claude Code session id per room all travel with the project.
// config.json then holds only the pointer (`keyFile`) and the public ref.
const keyCache = new Map() // keyFile -> { mtimeMs, data }
export function readKeyFile (file) {
  const st = statSync(file)
  const hit = keyCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data
  const data = JSON.parse(readFileSync(file, 'utf8'))
  keyCache.set(file, { mtimeMs: st.mtimeMs, data })
  return data
}
export function writeKeyFile (file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  chmodSync(file, 0o600)
  keyCache.delete(file)
}
// The secret-bearing view of a participant, wherever the secrets are kept.
const secretsOf = (p) => p.keyFile ? { ...p, ...readKeyFile(p.keyFile), bridge: p.bridge, role: p.role, keyFile: p.keyFile } : p

export function addParticipant (cfg, name, { role = 'agent', bridge = { kind: 'stream' }, keyFile = null } = {}) {
  name = String(name).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error('names are lowercase letters, digits, - and _')
  if (cfg.participants[name]) throw new Error(`participant ${name} already exists on this device`)
  const k = generate('ed25519')
  if (keyFile) {
    // a project agent is an account of its own from day one, so it can be enrolled on
    // any device with its own consent and revoked without touching anything else
    const r = generate('ed25519')
    writeKeyFile(keyFile, { name, suite: 'ed25519', secretKey: k.secretKey, ref: k.ref, root: { suite: 'ed25519', secretKey: r.secretKey, ref: r.ref }, sessions: {}, created: new Date().toISOString() })
    cfg.participants[name] = { suite: 'ed25519', ref: k.ref, role, bridge, keyFile }
  } else {
    cfg.participants[name] = { suite: 'ed25519', secretKey: k.secretKey, ref: k.ref, role, bridge }
  }
  return cfg.participants[name]
}

export function participantSigners (cfg) {
  return Object.fromEntries(Object.entries(cfg.participants).map(([name, raw]) => {
    const p = secretsOf(raw)
    return [name, { signer: signerFromSecret(p.suite, p.secretKey), previous: p.previous ? signerFromSecret(p.previous.suite, p.previous.secretKey) : null, role: p.role, bridge: p.bridge, keyFile: p.keyFile ?? null, account: accountSigner(cfg, name) }]
  }))
}

// Every participant is an account: a person's account is this device's root
// (one root, many devices); an agent's account is its own root, minted on the
// device that hosts it. The participant key is the session key under it.
export function accountSigner (cfg, name) {
  const raw = cfg.participants[name]
  if (!raw) return null
  if (raw.role === 'human') return rootSigner(cfg)
  const p = secretsOf(raw)
  return p.root ? signerFromSecret(p.root.suite, p.root.secretKey) : null
}

// Mint (or re-mint) an identity: a fresh root for an agent, plus a fresh
// session key for the participant, so old keys can be revoked cleanly.
export function newIdentity (cfg, name) {
  const raw = cfg.participants[name]
  if (!raw) throw new Error(`no participant ${name} on this device`)
  const p = secretsOf(raw)
  if (p.role === 'human') {
    if (!cfg.root) { const r = generate('bip340'); cfg.root = { suite: 'bip340', secretKey: r.secretKey } }
  } else {
    const r = generate('ed25519')
    p.root = { suite: 'ed25519', secretKey: r.secretKey, ref: r.ref }
  }
  const k = generate('ed25519')
  // the old session key stays usable in rooms that haven't enrolled the new one yet
  p.previous = { suite: p.suite, secretKey: p.secretKey, ref: p.ref }
  Object.assign(p, { suite: 'ed25519', secretKey: k.secretKey, ref: k.ref })
  if (raw.keyFile) {
    const { bridge, role, keyFile, ...secrets } = p
    writeKeyFile(raw.keyFile, secrets)
    raw.ref = k.ref
  } else Object.assign(raw, p)
  return { account: accountSigner(cfg, name).ref, session: k.ref }
}

// The per-room Claude Code session of a project agent, remembered in its key file so a
// daemon restart resumes the same conversation (and `claude --resume <id>` from the
// project folder opens it by hand).
export function agentSession (p, topic, sessionId) {
  if (!p.keyFile) return null
  const data = readKeyFile(p.keyFile)
  if (sessionId === undefined) return data.sessions?.[topic] ?? null
  data.sessions = { ...(data.sessions ?? {}), [topic]: sessionId }
  writeKeyFile(p.keyFile, data)
  return sessionId
}

export function rootSigner (cfg) {
  return cfg.root ? signerFromSecret(cfg.root.suite, cfg.root.secretKey) : null
}

// pearcore's account secret is Hyperswarm's 64-byte (seed || publicKey); the
// rKey ed25519 signer wants the 32-byte seed.
export function deviceSigner (pearcoreSecretHex) {
  return signerFromSecret('ed25519', pearcoreSecretHex.slice(0, 64))
}
