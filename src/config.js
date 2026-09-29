// Device config at $RKEYCHAT_DATA (default ~/.rkeychat)/config.json.
// v0 keeps secret keys here in plaintext (chmod 600). The root key only
// exists on the owner device; it moves to a signer app / NFC card later.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
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

export function addParticipant (cfg, name, { role = 'agent', bridge = { kind: 'stream' } } = {}) {
  name = String(name).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error('names are lowercase letters, digits, - and _')
  if (cfg.participants[name]) throw new Error(`participant ${name} already exists on this device`)
  const k = generate('ed25519')
  cfg.participants[name] = { suite: 'ed25519', secretKey: k.secretKey, ref: k.ref, role, bridge }
  return cfg.participants[name]
}

export function participantSigners (cfg) {
  return Object.fromEntries(Object.entries(cfg.participants).map(([name, p]) => [
    name, { signer: signerFromSecret(p.suite, p.secretKey), role: p.role, bridge: p.bridge }
  ]))
}

export function rootSigner (cfg) {
  return cfg.root ? signerFromSecret(cfg.root.suite, cfg.root.secretKey) : null
}

// pearcore's account secret is Hyperswarm's 64-byte (seed || publicKey); the
// rKey ed25519 signer wants the 32-byte seed.
export function deviceSigner (pearcoreSecretHex) {
  return signerFromSecret('ed25519', pearcoreSecretHex.slice(0, 64))
}
