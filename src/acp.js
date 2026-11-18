// A project agent over the Agent Client Protocol (ACP).
//
// The daemon owns the agent process: it spawns the Claude adapter (`claude-agent-acp`, which
// drives Claude Code through the Agent SDK under the Mac's own Claude login), opens one ACP
// session per room in the project folder, and for each due turn sends `session/prompt` with
// what renderTurn produced. The reply streams back as `session/update` notifications; the
// final text is posted by the runner. Compared with the stream-json bridge (ClaudeProcess):
// the agent's permission questions arrive here as JSON-RPC requests and are answered from
// the seat's tool list (src/tools.js) instead of being refused blind; a person's message
// during a turn can cancel it (`session/cancel`) and re-prompt; the session is resumed by id
// (`session/load`) after an idle stop or a daemon restart; and the same bridge can later
// drive any other ACP agent (Codex, Goose, a Hermes adapter) by changing the command.
//
// Never bypass: the session mode is the seat's permissionMode (default acceptEdits), and a
// request for `bypassPermissions` is turned into acceptEdits.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { client, ndJsonStream } from '@agentclientprotocol/sdk'
import { resolveTools } from './tools.js'
import { agentSession, sessionKeyOf } from './config.js'
import { MAIN } from './proto.js'

const IDLE_MS = 30 * 60_000
const TURN_TIMEOUT_MS = 20 * 60_000
const require = createRequire(import.meta.url)

// The adapter's entry point, run with this daemon's node (it needs Node 22+).
export function adapterPath () {
  return join(dirname(require.resolve('@agentclientprotocol/claude-agent-acp/package.json')), 'dist', 'index.js')
}

export class AcpProcess {
  constructor ({ name, room, conv = MAIN, participant, bridge, system, onActivity }) {
    this.name = name
    this.room = room
    this.conv = conv
    this.p = participant
    this.bridge = bridge // { kind: 'claude', via: 'acp', dir, permissionMode?, tools?, model?, command? }
    this.system = system
    this.onActivity = onActivity ?? (() => {})
    this.child = null
    this.cx = null // ClientContext once connected
    this.sessionId = null
    this.pending = null // { resolve, reject, timer, text, reply, usage, retried }
    this.loading = false // replaying history on session/load: ignore those updates
    this.failures = 0
    this.stderr = []
    this.retireAfterTurn = false
    this.rules = resolveTools(bridge.tools, bridge.dir)
  }

  get alive () { return !!this.child }
  get sessionKey () { return sessionKeyOf(this.room.topic, this.conv) }

  // ---- lifecycle ----

  async #connect () {
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_SESSION')) delete env[k]
    const command = this.bridge.command ?? process.execPath
    const args = this.bridge.command ? (this.bridge.args ?? []) : [adapterPath()]
    const child = spawn(command, args, { cwd: this.bridge.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.stderr = []
    child.stderr.on('data', (d) => { this.stderr.push(String(d)); if (this.stderr.length > 40) this.stderr.shift() })
    child.on('error', (err) => this.#gone(`could not start the agent: ${err.message}`))
    child.on('exit', (code, sig) => this.#gone(code === 0 || sig === 'SIGTERM' ? null : `agent exited (${code ?? sig}): ${this.stderr.join('').trim().split('\n').slice(-3).join(' | ') || 'no stderr'}`))

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    const app = client({ name: `rkeychat:${this.name}` })
      .onRequest('session/request_permission', ({ params }) => this.#permission(params))
      .onNotification('session/update', ({ params }) => this.#update(params))
      .onNotification('*', () => {}) // auth status and other extension notices
    const ready = new Promise((resolve, reject) => {
      app.connectWith(stream, async (cx) => {
        this.cx = cx
        resolve()
        await new Promise((r) => { this.release = r }) // hold the connection until stop()
      }).catch(reject)
    })
    await ready
    await this.cx.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {}, // no fs/terminal here: the agent uses its own tools, we only answer permissions
      clientInfo: { name: 'rkeychat', version: '0' }
    })
  }

  async #open () {
    await this.#connect()
    const cwd = this.bridge.dir
    const systemPrompt = this.system ? { mode: 'append', content: [{ type: 'text', text: this.system }] } : undefined
    const saved = agentSession(this.p, this.sessionKey)
    let sessionId = null
    if (saved) {
      try {
        this.loading = true
        await this.cx.request('session/load', { sessionId: saved, cwd, mcpServers: [], ...(systemPrompt ? { systemPrompt } : {}) })
        sessionId = saved
      } catch (err) {
        this.onActivity(`the saved session could not be resumed (${String(err?.message ?? err).slice(0, 80)}); starting a fresh one`)
        agentSession(this.p, this.sessionKey, null)
      } finally { this.loading = false }
    }
    if (!sessionId) {
      const res = await this.cx.request('session/new', { cwd, mcpServers: [], ...(systemPrompt ? { systemPrompt } : {}) })
      sessionId = res.sessionId
      agentSession(this.p, this.sessionKey, sessionId)
    }
    this.sessionId = sessionId
    let mode = this.bridge.permissionMode ?? 'acceptEdits'
    if (mode === 'bypassPermissions') mode = 'acceptEdits'
    try { await this.cx.request('session/set_mode', { sessionId, modeId: mode }) } catch (err) { this.onActivity(`could not set mode ${mode}: ${err?.message ?? err}`) }
    this.onActivity(`${saved && sessionId === saved ? 'resumed' : 'started'} Claude Code over ACP in ${cwd} (session ${sessionId.slice(0, 8)}, ${mode})`)
  }

  // One turn in, one reply out: { reply, usage, cancelled }. Rejects if the agent dies or the
  // turn times out; the runner marks the seat as errored and the next poke tries again.
  prompt (text) {
    if (this.pending) return Promise.reject(new Error('a turn is already in flight'))
    if (this.failures >= 3 && Date.now() - (this.lastFailAt ?? 0) < 5 * 60_000) return Promise.reject(new Error('the agent keeps failing; backing off for five minutes'))
    return new Promise((resolve, reject) => {
      const pend = { resolve, reject: (e) => { this.lastFailAt = Date.now(); reject(e) }, timer: null, text, reply: '', usage: null, retried: false }
      this.#send(pend).catch((err) => { if (this.pending === pend) this.pending = null; pend.reject(err) })
    })
  }

  async #send (pend) {
    this.pending = pend
    clearTimeout(this.idleTimer)
    if (!this.child) await this.#open()
    if (this.pending !== pend) return // stopped while opening
    pend.timer = setTimeout(() => this.stop('turn timed out'), TURN_TIMEOUT_MS)
    const res = await this.cx.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: pend.text }] })
    if (this.pending !== pend) return
    this.pending = null
    clearTimeout(pend.timer)
    const u = res.usage
    const usage = u || pend.usage
      ? { model: pend.usage?.model ?? this.bridge.model ?? 'claude', in: u?.inputTokens, out: u?.outputTokens, cacheRead: u?.cachedReadTokens, cacheWrite: u?.cachedWriteTokens, costUsd: pend.usage?.costUsd }
      : null
    this.failures = 0
    if (this.retireAfterTurn) { this.retireAfterTurn = false; this.stop('idle') } else this.#armIdle()
    pend.resolve({ reply: pend.reply, usage, cancelled: res.stopReason === 'cancelled', stopReason: res.stopReason })
  }

  // A person spoke while a turn was running: stop the turn now. The prompt resolves with
  // cancelled: true and the runner renders a new turn that carries both messages.
  cancel () {
    if (!this.pending || !this.cx || !this.sessionId) return false
    this.cx.notify('session/cancel', { sessionId: this.sessionId }).catch(() => {})
    this.onActivity('interrupted: a person spoke; answering the newer message instead')
    return true
  }

  stop (why = 'stopped') {
    const c = this.child
    if (!c) return
    this.child = null
    clearTimeout(this.idleTimer)
    try { this.release?.() } catch {}
    try { c.stdin.end() } catch {}
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 3000); t.unref?.()
    try { c.kill('SIGTERM') } catch {}
    this.cx = null
    if (why !== 'idle') this.onActivity(`Claude Code (ACP) ${why}`)
    if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.reject(new Error(why)) }
  }

  #gone (error) {
    const pend = this.pending; this.pending = null
    this.child = null; this.cx = null
    clearTimeout(this.idleTimer)
    try { this.release?.() } catch {}
    if (!pend) return
    clearTimeout(pend.timer)
    this.failures++
    pend.reject(new Error(error ?? 'the agent stopped before answering'))
  }

  #armIdle () {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { if (!this.pending) this.stop('idle') }, IDLE_MS)
    this.idleTimer.unref?.()
  }

  // ---- what comes back ----

  #update ({ sessionId, update: u }) {
    if (this.loading || sessionId !== this.sessionId || !u) return
    const pend = this.pending
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (pend && u.content?.type === 'text') pend.reply += u.content.text
        break
      case 'tool_call': {
        const tool = u._meta?.claudeCode?.toolName ?? u.name ?? u.kind
        const what = summarize(u.rawInput) || (u.title && u.title !== 'Terminal' ? u.title : '')
        if (what) this.onActivity(`${tool}: ${what}`)
        break
      }
      case 'tool_call_update':
        if (u.status === 'failed') this.onActivity(`a tool call failed: ${String(firstText(u.content) ?? u.rawOutput ?? '').slice(0, 100)}`)
        break
      case 'usage_update':
        if (pend) {
          pend.usage ??= {}
          if (u._meta?.['_claude/model']) pend.usage.model = u._meta['_claude/model']
          if (u.cost?.amount != null) pend.usage.costUsd = u.cost.amount
        }
        break
      default:
    }
  }

  // The agent asks whether it may use a tool. Claude Code has already allowed what the
  // mode covers (edits inside the folder under acceptEdits, read-only commands); what
  // reaches here is the rest, and the seat's tool list decides. No person is asked.
  #permission ({ toolCall, options }) {
    const tool = toolCall?._meta?.claudeCode?.toolName ?? toolCall?.name ?? ''
    const input = toolCall?.rawInput ?? {}
    const what = summarize(input) || toolCall?.title || tool
    const allowed = permitted(this.rules, tool, input, this.bridge.dir)
    const pick = (kinds) => options?.find((o) => kinds.includes(o.kind)) ?? null
    const choice = allowed ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always'])
    this.onActivity(`${allowed ? 'allowed' : 'refused'} ${tool}: ${what}`)
    if (!choice) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId: choice.optionId } }
  }
}

// ---- the seat's tool list, applied to one tool call ----

// Claude Code permission-rule syntax, as src/tools.js spells it: `Tool`, `Tool(prefix:*)`
// (Bash: the command starts with `prefix`), `Tool(path glob)` (Read/Grep/Glob/Edit/Write: the
// path matches; `//x` is absolute, `~/x` is under home, `/x` is under the project folder,
// anything else is relative to it). A command joined with && || ; | must have every part
// allowed. Deny rules win.
export function permitted ({ allow = [], deny = [] } = {}, tool, input = {}, dir = process.cwd()) {
  if (!tool) return false
  const paths = pathsOf(input, dir)
  if (deny.some((r) => ruleHits(r, tool, input, paths, dir))) return false
  if (tool === 'Bash') {
    const parts = String(input.command ?? '').split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean)
    if (!parts.length) return false
    return parts.every((part) => allow.some((r) => ruleHits(r, tool, { command: part }, [], dir)))
  }
  return allow.some((r) => ruleHits(r, tool, input, paths, dir))
}

// As in Claude Code: a `Read` rule covers every built-in tool that reads files, an `Edit`
// rule every one that edits them.
const FAMILY = { Read: ['Read', 'Grep', 'Glob', 'LS'], Edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }

function ruleHits (rule, tool, input, paths, dir) {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(String(rule).trim())
  if (!m) return false
  if (m[1] !== tool && !(FAMILY[m[1]] ?? []).includes(tool)) return false
  const arg = m[2]
  if (arg == null || arg === '') return true // bare tool name: any use
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '').trim()
    if (arg.endsWith(':*')) { const prefix = arg.slice(0, -2); return cmd === prefix || cmd.startsWith(prefix + ' ') }
    return cmd === arg
  }
  const re = globRe(rulePath(arg, dir))
  return paths.some((p) => re.test(p))
}

function rulePath (arg, dir) {
  if (arg.startsWith('//')) return arg.slice(1)
  if (arg.startsWith('~/')) return join(homedir(), arg.slice(2))
  if (arg.startsWith('/')) return join(dir, arg)
  return join(dir, arg)
}

function pathsOf (input, dir) {
  const out = []
  for (const k of ['file_path', 'path', 'notebook_path', 'directory']) if (typeof input?.[k] === 'string') out.push(resolve(dir, input[k]))
  return out
}

// `*` within a segment, `?` one character, `**` any run of segments: `a/**` covers `a` itself
// and everything under it, `**/b` covers `b` at any depth.
function globRe (glob) {
  let s = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '/' && glob.startsWith('**', i + 1) && (i + 3 === glob.length || glob[i + 3] === '/')) {
      s += i + 3 === glob.length ? '(?:/.*)?' : '(?:/.*)?'; i += 2; if (glob[i + 1] === '/') i++
    } else if (c === '*' && glob[i + 1] === '*') {
      s += '.*'; i++; if (glob[i + 1] === '/') { s += '(?:/)?'; i++ }
    } else if (c === '*') s += '[^/]*'
    else if (c === '?') s += '[^/]'
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${s}$`)
}

function summarize (input) {
  if (!input || typeof input !== 'object') return ''
  const s = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description ?? (Object.keys(input).length ? JSON.stringify(input) : '')
  return String(s).replace(/\s+/g, ' ').slice(0, 100)
}

function firstText (content) {
  for (const c of content ?? []) {
    const t = c?.content?.text ?? c?.text
    if (typeof t === 'string') return t
  }
  return null
}
