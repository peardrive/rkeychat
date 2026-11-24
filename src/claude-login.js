// Logging this computer into a Claude subscription from inside the app (2026-11-24).
//
// Until now a seat ran on whatever `claude` login the Mac already had, which only works on a computer where
// someone has run Claude Code in a terminal. The first build handed to someone else has no terminal anywhere, so
// the daemon drives the same login the adapter advertises as its auth method: the Claude CLI shipped inside the
// adapter's SDK, run as `<adapter> --cli auth login --claudeai`. It opens the browser itself; when the browser
// cannot reach back (another machine, a locked-down browser) the CLI prints the URL and waits for the code the
// page shows, which the person pastes into the app. `auth status --json` says whether a login is held and for whom.
//
// Nothing of the login is kept here: the CLI writes its own credentials where Claude Code reads them.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { adapterPath, nodeEnv } from './acp.js'

const LOGIN_TIMEOUT_MS = 10 * 60_000
const STATUS_TTL_MS = 20_000

// What the CLI's login output says so far. Pure, so it is tested without a browser.
export function parseLoginOutput (text) {
  const s = String(text ?? '')
  const url = s.match(/https:\/\/\S+oauth\S+/)?.[0]?.replace(/[),.]+$/, '') ?? null
  return {
    url,
    waitingForCode: /paste code here/i.test(s),
    success: /logged in|login successful|successfully/i.test(s) && !/not logged in/i.test(s),
    error: s.match(/(?:error|failed)[^\n]*/i)?.[0]?.trim() ?? null
  }
}

// `auth status --json` → what the app shows: logged in or not, and as whom.
export function parseStatus (json) {
  let o = null
  try { o = JSON.parse(String(json)) } catch { return { loggedIn: false } }
  if (!o || typeof o !== 'object') return { loggedIn: false }
  return {
    loggedIn: !!o.loggedIn,
    method: o.authMethod ?? null, // 'claude.ai' | 'console' | 'none'
    email: o.email ?? null,
    plan: o.subscriptionType ?? null,
    expires: o.loginExpiresAt ?? null
  }
}

export class ClaudeLogin extends EventEmitter {
  constructor ({ command = process.execPath, args = null, env = {}, disabled = false } = {}) {
    super()
    this.disabled = disabled // a phone: no agent runs there, so there is nothing to log in
    this.command = command
    this.args = args ?? [adapterPath(), '--cli']
    this.env = env
    this.child = null
    this.out = ''
    this.state = { running: false, url: null, waitingForCode: false, error: null, done: false }
    this.cached = null // { at, status }
  }

  #run (args, { input = null } = {}) {
    return new Promise((resolve) => {
      const child = spawn(this.command, [...this.args, ...args], { env: nodeEnv({ ...process.env, ...this.env }), stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''; let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', (e) => resolve({ code: -1, out, err: err + e.message }))
      child.on('exit', (code) => resolve({ code, out, err }))
      if (input != null) child.stdin.write(input)
      child.stdin.end()
    })
  }

  // Whether this computer holds a Claude login, as the CLI reports it. Cached for a few seconds: the home page
  // asks on every visit, and the CLI takes a moment to answer.
  async status ({ fresh = false } = {}) {
    if (this.disabled) return { loggedIn: false, available: false }
    if (!fresh && this.cached && Date.now() - this.cached.at < STATUS_TTL_MS) return this.cached.status
    const { code, out, err } = await this.#run(['auth', 'status', '--json'])
    const status = code === 0 || out.trim().startsWith('{') ? parseStatus(out) : { loggedIn: false, error: (err || out).trim().split('\n').pop() || `exit ${code}` }
    this.cached = { at: Date.now(), status }
    return status
  }

  // Everything the app shows about the login: the held login, and a login in progress if one is.
  async info () { return { ...(await this.status()), login: this.state } }

  #set (patch) {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.state)
  }

  // Start a login: the CLI opens the browser; the URL it prints is kept for a "didn't open?" link, and the
  // moment it asks for a code is reported so the app can show the field. One at a time.
  start () {
    if (this.disabled) throw new Error('agents run on a computer, not on this device; log in there')
    if (this.child) return this.state
    this.out = ''
    this.#set({ running: true, url: null, waitingForCode: false, error: null, done: false })
    const child = spawn(this.command, [...this.args, 'auth', 'login', '--claudeai'], { env: nodeEnv({ ...process.env, ...this.env }), stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const onData = (d) => {
      this.out += String(d)
      const p = parseLoginOutput(this.out)
      if (p.url !== this.state.url || p.waitingForCode !== this.state.waitingForCode) this.#set({ url: p.url, waitingForCode: p.waitingForCode })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => { if (this.child === child) { child.kill(); this.#set({ error: 'the login took too long; try again' }) } }, LOGIN_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', (e) => { clearTimeout(timer); this.child = null; this.#set({ running: false, error: `could not start the login: ${e.message}` }) })
    child.on('exit', (code, sig) => {
      clearTimeout(timer)
      if (this.child !== child) return
      this.child = null
      this.cached = null
      const p = parseLoginOutput(this.out)
      if (code === 0) this.#set({ running: false, waitingForCode: false, done: true, error: null })
      else if (sig === 'SIGTERM' && !this.state.error) this.#set({ running: false, waitingForCode: false })
      else this.#set({ running: false, waitingForCode: false, error: this.state.error ?? p.error ?? `the login did not finish (${code ?? sig})` })
    })
    return this.state
  }

  // The code the browser showed, when the CLI is waiting for one.
  code (text) {
    const c = String(text ?? '').trim()
    if (!c) throw new Error('paste the code the page shows')
    if (!this.child) throw new Error('no login is in progress; start one first')
    this.child.stdin.write(c + '\n')
    return this.state
  }

  cancel () {
    const c = this.child
    if (!c) return this.state
    this.child = null
    c.kill()
    this.#set({ running: false, waitingForCode: false, url: null })
    return this.state
  }

  async logout () {
    this.cancel()
    const { code, out, err } = await this.#run(['auth', 'logout'])
    this.cached = null
    if (code !== 0) throw new Error((err || out).trim().split('\n').pop() || `logout failed (${code})`)
    return this.status({ fresh: true })
  }

  stop () { this.cancel() }
}
