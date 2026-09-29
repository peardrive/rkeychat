// Phone / remote access. The GUI stays open to this Mac (loopback); any other
// device must be paired once by scanning a QR code shown on the Mac. Pairing
// sets a long-lived, HttpOnly session cookie. Transport is Tailscale: either
// `tailscale serve` (HTTPS, needed for the phone's microphone) or the daemon
// also listening on this Mac's Tailscale IP (plain HTTP over WireGuard).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dataDir } from './config.js'

const sessionsPath = () => join(dataDir(), 'sessions.json')
const COOKIE = 'rkc_session'
const pairTokens = new Map() // token -> expiry

function loadSessions () {
  try { return JSON.parse(readFileSync(sessionsPath(), 'utf8')) } catch { return [] }
}
function saveSessions (list) { writeFileSync(sessionsPath(), JSON.stringify(list, null, 2), { mode: 0o600 }) }

export function sessions () {
  return loadSessions().map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }))
}
export function revokeSession (id) { saveSessions(loadSessions().filter((s) => s.id !== id)) }

// Is this request from someone other than the person sitting at this Mac?
// `tailscale serve` proxies from 127.0.0.1 but adds identity headers.
export function isRemote (req) {
  const a = req.socket.remoteAddress ?? ''
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  return !loopback || !!req.headers['tailscale-user-login'] || !!req.headers['x-forwarded-for']
}

function cookie (req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')
  return m ? decodeURIComponent(m[1]) : null
}

export function authorized (req) {
  if (!isRemote(req)) return true
  const secret = cookie(req, COOKIE)
  if (!secret) return false
  const list = loadSessions()
  const s = list.find((x) => x.secret.length === secret.length && timingSafeEqual(Buffer.from(x.secret), Buffer.from(secret)))
  if (!s) return false
  if (Date.now() - (s.lastSeen ?? 0) > 60_000) { s.lastSeen = Date.now(); saveSessions(list) }
  return true
}

export function newPairToken () {
  const t = randomBytes(18).toString('base64url')
  pairTokens.set(t, Date.now() + 10 * 60_000)
  return t
}

// Redeem a one-time pairing token: returns Set-Cookie header value, or null.
export function redeem (token, req) {
  const exp = pairTokens.get(token)
  if (!exp || exp < Date.now()) return null
  pairTokens.delete(token)
  const secret = randomBytes(32).toString('base64url')
  const ua = String(req.headers['user-agent'] ?? '')
  const name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'browser'
  const list = loadSessions()
  list.push({ id: randomBytes(6).toString('hex'), name: `${name} · ${req.headers['tailscale-user-login'] ?? 'tailnet'}`, secret, created: Date.now(), lastSeen: Date.now() })
  saveSessions(list)
  const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['tailscale-user-login']
  return `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`
}

// What Tailscale can offer this Mac: its name, IP, and whether HTTPS serving is possible.
export function tailscaleInfo () {
  try {
    const d = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }))
    const dns = String(d.Self?.DNSName ?? '').replace(/\.$/, '')
    return { running: d.BackendState === 'Running', dns, ip: d.Self?.TailscaleIPs?.find((x) => x.includes('.')), https: Array.isArray(d.CertDomains) && d.CertDomains.length > 0 }
  } catch { return { running: false } }
}

export function serveStatus () {
  try { return execFileSync('tailscale', ['serve', 'status'], { encoding: 'utf8', timeout: 3000 }) } catch { return '' }
}

// Turn on `tailscale serve` (HTTPS on the tailnet only, never public).
export function enableServe (port) {
  execFileSync('tailscale', ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], { encoding: 'utf8', timeout: 15000 })
}

export function remoteURL (cfg) {
  const ts = tailscaleInfo()
  if (!ts.running) return null
  if (ts.https && serveStatus().includes(`127.0.0.1:${cfg.port}`)) return { url: `https://${ts.dns}`, secure: true }
  if (cfg.remote?.enabled && ts.ip) return { url: `http://${ts.dns}:${cfg.port}`, secure: false }
  return null
}
