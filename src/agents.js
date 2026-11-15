// Waking agents. For every agent hosted on this device the daemon watches the
// room; when something is addressed to it and the round budget allows a reply,
// it builds one turn from everything new since the agent last spoke and hands
// it to the agent's bridge:
//
//   hermes — calls the local Hermes Agent API server and posts the reply.
//   stream — delivers the turn to whoever is listening on /api/wait (Claude
//            Code via `rkeychat wait`), who replies with `rkeychat send`.
//   claude — a *project agent*: the daemon owns a headless Claude Code process
//            (`claude -p` with stream-json on both ends) started in the project
//            folder, one conversation per room, resumed across restarts. The
//            daemon sees it start, answer and die, so no turn is ever stranded
//            on a listener that went away. (What Buzz gets right, done here.)

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { replyDepth } from './turns.js'
import { TURN_WINDOW } from './room.js'
import { agentSession } from './config.js'
import { resolveTools } from './tools.js'

// A turn already handed to a listener isn't handed over again for this long: one
// turn per process means a listener reconnects immediately, and it must not be
// given the same work twice. Past it, we assume whoever took it is gone.
//
// Ten minutes, not two: an agent given real work is away for a while, and a short
// window just re-offers the same turn to it over and over. The cost of being wrong
// is that a crashed agent's turn waits this long before another listener gets it,
// which is the lesser problem. A person's new message preempts regardless (poke),
// so this never delays anyone.
const REOFFER = 10 * 60_000

const PASS = /^\s*PASS\s*$/i
const fmtTime = (ts) => new Date(ts).toTimeString().slice(0, 5)

const fmtSize = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`

export function renderTurn (room, name, { intro = false } = {}) {
  const log = room.log()
  const triggers = room.triggersFor(name)
  let lastOwn = -1
  log.forEach((r, i) => { if (r.kind === 'msg' && r.name === name) lastOwn = i })
  const fresh = log.slice(lastOwn + 1).filter((r) => r.kind === 'msg' && !r.redacted).slice(-40)
  const others = room.participantsList().filter((p) => p.name !== name && p.status === 'active')
  const b = room.budget()
  const depth = replyDepth(triggers)
  const left = b.remaining === Infinity ? 'unlimited' : Math.max(0, b.limit - depth)

  const lines = []
  if (intro) {
    lines.push(
      `You are @${name}, a participant in rKeyChat room "${room.cfg.name}" — a live group chat between Guy (the human who runs these projects) and his AI agents, working together on PearDrive/pearcore.`,
      'Whatever you reply is posted to the room verbatim under your name. Keep it conversational and concise; put long material in files and reference paths.',
      'Agents only get woken when @mentioned (or when Guy posts without mentioning anyone). To hand someone the floor, @mention them. To stay silent, reply exactly PASS.',
      'Files: share one with rkeychat send --file PATH (it becomes available to everyone in the room by hash); read one someone shared with rkeychat get ROOT, which prints its local path.',
      'Agent-to-agent exchanges are limited by a round budget that Guy controls; when it runs out, everyone waits for Guy.',
      'Messages marked (dictated) were spoken and transcribed. Expect misheard words, especially project names (pearcore, PearDrive, Kimi, Hermes, Hyperbee, rKey). Read by context and meaning, not spelling. A dictated message can also catch a stray sentence that was said to someone else in the room; if part of it clearly isn\'t addressed to this conversation, ignore that part rather than act on it.',
      ''
    )
  }
  const charter = room.charter()
  if (charter.text) lines.push(`Room purpose (set by the room's owner):\n${charter.text}`, '')
  if (charter.order.length > 1) lines.push(`Turn order for messages that name nobody: ${charter.order.map((n) => '@' + n).join(' → ')}. The first in line answers; the next steps in only if the one before stays silent for ${Math.round(TURN_WINDOW / 1000)}s.`)
  const rule = room.ruleFor(name)
  if (rule.role) lines.push(`Your role in this room (set by the owner): ${rule.role}`)
  if (rule.wake === 'mention') lines.push('You are woken only when @mentioned or replied to; the open floor is not yours here.')
  if (rule.wake === 'backup' && rule.backupFor) lines.push(`You are the backup for @${rule.backupFor}: you are woken when named, or when @${rule.backupFor} has left something unanswered or is offline; then you cover for them until they are back.`)
  lines.push(room.style() === 'verbose'
    ? '(This room is set to verbose: full detail is welcome here.)'
    : '(This room is set to concise: keep messages short and put detail behind files or Thinking. Other agents pay for every token you post.)')
  lines.push(`[room ${room.cfg.name} · you are @${name} · others: ${others.map((p) => `@${p.name}${p.role === 'human' ? ' (human)' : ''}${p.online ? '' : ' (offline)'}`).join(', ')} · rounds left after your reply: ${left}]`)
  lines.push('')
  // reactions since this agent last spoke, compact: they're cheap context, never a wake-up
  const reacts = log.slice(lastOwn + 1).filter((r) => r.kind === 'react' && r.on && r.name !== name)
  for (const r of fresh) {
    const to = r.mentions.length ? ` → ${r.mentions.map((m) => '@' + m).join(' ')}` : ''
    const memos = (r.att ?? []).filter((a) => a.mime?.startsWith('audio/')).map((a) => {
      const sec = a.ms ? a.ms / 1000 : 0
      const len = sec ? ` ${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : ''
      return a.transcript ? ` [voice memo${len}, transcript: ${a.transcript}]` : ` [voice memo${len}, no transcript available]`
    }).join('')
    const files = (r.att ?? []).filter((a) => a.kind === 'file').map((a) => ` [file: ${a.name}, ${fmtSize(a.size)}, root ${a.hash.slice(0, 12)}… — read it with: rkeychat get --room "${room.cfg.name}" ${a.hash.slice(0, 12)}]`).join('')
    lines.push(`[${fmtTime(r.ts)}] ${r.name}${r.via === 'voice' || memos ? ' (dictated)' : ''}${to}: ${r.text}${memos}${files}`)
  }
  if (reacts.length) {
    const byId = new Map(log.map((r) => [r.id, r]))
    lines.push('', 'Reactions: ' + reacts.map((r) => {
      const t = byId.get(r.target)
      const whose = !t ? 'a message' : t.name === name ? 'your message' : `${t.name}'s message`
      return `${r.name} ${r.emoji} ${whose}${t?.text ? ` ("${t.text.slice(0, 40)}${t.text.length > 40 ? '…' : ''}")` : ''}`
    }).join('; '))
    lines.push('(You can react too, without replying: rkeychat react. Reactions never wake anyone.)')
  }
  return { text: lines.join('\n'), triggers, depth }
}

export class AgentRunner {
  constructor (room, name, bridge) {
    this.room = room
    this.name = name
    this.bridge = bridge // { kind: 'hermes', url, key } | { kind: 'stream' }
    this.busy = false
    this.introduced = false
    this.listeners = new Set() // for stream bridges
    this.room.on('record', () => this.poke())
    this.room.on('changed', () => this.poke())
    // a stream agent isn't listening until something connects to /api/wait
    if (bridge.kind === 'stream') this.room.agentState.set(name, 'offline')
  }

  due () { return this.why().triggers }

  // Why this agent would or wouldn't be woken right now (rkeychat debug agent NAME).
  why () {
    const p = this.room.local[this.name]
    const me = p?.signer.ref
    if (!me) return { triggers: null, reason: 'no local signer for this name' }
    if (!this.room.state) return { triggers: null, reason: 'room chain not loaded (not admitted yet)' }
    if (!this.room.state.isActive(me)) {
      const st = this.room.state.status(me)
      // "unknown" usually just means this agent was never in this room, which is not a
      // fault — `debug agent` walks every room on the device. Only say something is wrong
      // when the key was enrolled here and no longer is.
      const fix = st === 'unknown'
        ? 'never enrolled here (if it should be: rkeychat request --room, then the owner approves)'
        : 'the config key isn\'t the enrolled one; approve a new request, or rkeychat readopt'
      return { triggers: null, reason: `this device's key for ${this.name} (${me.slice(0, 24)}…) is ${st} in this room: ${fix}`, key: me }
    }
    const triggers = this.room.triggersFor(this.name)
    if (!triggers.length) return { triggers: null, reason: 'nothing addressed to me that I haven\'t answered or passed on', key: me }
    const depth = replyDepth(triggers)
    if (!this.room.budget().allows(depth, this.name)) return { triggers: null, reason: `budget refuses depth ${depth} (paused, per-agent limit, or out of rounds)`, key: me, waiting: triggers.map((t) => t.id) }
    return { triggers, reason: 'due', key: me }
  }

  poke () {
    if (!this.due()) return
    // Busy means a turn is already out. An agent talking to itself can wait — but a
    // person cannot be made to. If a human has said something the outstanding turn
    // doesn't cover, supersede it: the turn is re-rendered (now carrying both) and
    // pushed again, so the agent answers once rather than twice. Without this, a
    // follow-up sits unseen until the agent happens to finish.
    const now = Date.now()
    const pending = this.bridge.kind === 'stream' ? this.room.triggersFor(this.name) : []
    const fresh = pending.filter((t) => !this.offered?.includes(t.id))
    if (this.busy) {
      if (this.bridge.kind !== 'stream' || !this.listeners.size) return
      // Only a person preempts. An agent answering an agent can wait its turn.
      if (!fresh.some((t) => t.human)) return
      this.room.setAgentState(this.name, 'idle')
      this.busy = false
    } else if (this.bridge.kind === 'stream' && !fresh.length && this.offered?.length && now - (this.offeredAt ?? 0) < REOFFER) {
      // This exact turn was handed over moments ago and is being worked on. A
      // listener that reconnects straight away (one turn per process, so it does)
      // must not be given it again, or it loops. After REOFFER we assume whoever
      // took it is gone and hand it to the next listener.
      return
    }
    if (this.bridge.kind === 'hermes') this.#runHermes().catch((err) => this.#fail(err))
    if (this.bridge.kind === 'claude') this.#runClaude().catch((err) => this.#fail(err))
    if (this.bridge.kind === 'stream') this.#offer()
  }

  // ---- claude bridge (a project agent) ----

  async #runClaude () {
    this.busy = true
    this.room.setAgentState(this.name, 'thinking')
    const turn = renderTurn(this.room, this.name, { intro: false })
    this.room.activity(this.name, `woken by ${turn.triggers.map((t) => t.name).join(', ')}`, { claim: turn.triggers.map((t) => t.id) }).catch(() => {})
    if (!this.proc) {
      this.proc = new ClaudeProcess({
        name: this.name,
        room: this.room,
        participant: this.room.local[this.name],
        bridge: this.bridge,
        // the standing rules go in once, as system prompt; turns arrive as messages
        system: renderTurn(this.room, this.name, { intro: true }).text.split('\n[room ')[0],
        onActivity: (text, extra) => this.room.activity(this.name, text, extra).catch(() => {})
      })
    }
    const { reply, usage } = await this.proc.prompt(turn.text)
    if (usage) await this.room.activity(this.name, 'answered', { usage }).catch(() => {})
    await this.#deliver(reply, turn.triggers.map((t) => t.id))
  }

  stop () { this.proc?.stop() }

  // The bridge's tool list changed (rkeychat agent tools): the flags are fixed at spawn,
  // so the process is retired — now if it is idle, after its turn if one is in flight.
  reconfigured () {
    if (!this.proc) return
    if (this.busy) this.proc.retireAfterTurn = true
    else this.proc.stop('idle')
  }

  #fail (err) {
    this.busy = false
    this.room.setAgentState(this.name, 'error')
    this.room.emit('agent-error', { name: this.name, error: String(err?.message ?? err) })
  }

  // ---- stream bridge (Claude Code) ----

  #offer () {
    if (!this.listeners.size) {
      this.room.setAgentState(this.name, 'waiting')
      return
    }
    const turn = renderTurn(this.room, this.name, { intro: !this.introduced })
    this.introduced = true
    this.busy = true
    this.room.setAgentState(this.name, 'thinking')
    this.offered = turn.triggers.map((t) => t.id)
    this.offeredAt = Date.now()
    this.room.activity(this.name, `got a turn: ${turn.triggers.map((t) => `${t.name}'s message`).join(', ')}`, { claim: this.offered }).catch(() => {})
    for (const fn of this.listeners) fn({ name: this.name, re: this.offered, prompt: turn.text })
    // if nobody answers within the window, free the slot so newer turns flow
    clearTimeout(this.offerTimer)
    this.offerTimer = setTimeout(() => { this.busy = false; this.room.setAgentState(this.name, 'idle'); this.poke() }, 15 * 60_000)
  }

  listen (fn) {
    this.listeners.add(fn)
    this.introduced = false
    this.room.setAgentState(this.name, 'idle')
    setImmediate(() => this.poke())
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size) return
      this.room.setAgentState(this.name, 'offline')
      // A listener that goes away while holding an unanswered turn must hand it
      // back now, not in fifteen minutes: until the slot is free nothing newer is
      // offered, so the agent looks alive and ignores everything said to it. The
      // triggers are still unanswered in the log, so the next listener gets them.
      if (this.busy) { clearTimeout(this.offerTimer); this.busy = false } // `offered` stays: it suppresses an instant re-offer
    }
  }

  // called after the stream agent posts (or passes)
  answered ({ passed = false } = {}) {
    if (passed && this.offered) this.room.markPassed(this.name, this.offered)
    clearTimeout(this.offerTimer)
    this.offered = null; this.offeredAt = 0
    this.busy = false
    this.room.setAgentState(this.name, 'idle')
    setImmediate(() => this.poke())
  }

  // ---- hermes bridge ----

  async #runHermes () {
    this.busy = true
    this.room.setAgentState(this.name, 'thinking')
    const turn = renderTurn(this.room, this.name, { intro: !this.introduced })
    this.room.activity(this.name, `woken by ${turn.triggers.map((t) => t.name).join(', ')}; asking Hermes`, { claim: turn.triggers.map((t) => t.id) }).catch(() => {})
    const { url = 'http://127.0.0.1:8642', key, model = 'hermes-agent' } = this.bridge
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        'x-hermes-session-id': `rkeychat-${this.room.topic.slice(0, 12)}-${this.name}`
      },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: turn.text }] }),
      signal: AbortSignal.timeout(20 * 60_000)
    })
    if (!res.ok) throw new Error(`hermes ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = await res.json()
    this.introduced = true
    const u = body?.usage
    if (u) {
      await this.room.activity(this.name, 'answered', {
        usage: {
          model: body.model ?? model,
          in: u.prompt_tokens ?? u.input_tokens,
          out: u.completion_tokens ?? u.output_tokens,
          cacheRead: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens
        }
      }).catch(() => {})
    }
    const reply = body?.choices?.[0]?.message?.content ?? ''
    await this.#deliver(reply, turn.triggers.map((t) => t.id))
  }

  async #deliver (reply, re) {
    try {
      if (reply && !PASS.test(reply)) await this.room.post(this.name, reply, { re })
      else { this.room.markPassed(this.name, re); this.room.activity(this.name, 'decided to stay quiet (PASS)').catch(() => {}) }
    } finally {
      this.busy = false
      this.room.setAgentState(this.name, 'idle')
      setImmediate(() => this.poke())
    }
  }
}

// One headless Claude Code process for one agent in one room, owned by the daemon.
//
// `claude -p --input-format stream-json --output-format stream-json` reads user messages
// as JSON lines on stdin and writes events on stdout: `system/init` (with the session id),
// `assistant` (text and tool_use blocks as they happen), and one `result` per prompt.
// The process stays up between turns so the conversation is warm; after IDLE_MS it is
// stopped and the next turn resumes the same session by id. The id lives in the agent's
// key file, per room, so a daemon restart (or a move to another machine, with the folder)
// picks the conversation back up — and `claude --resume <id>` from the project folder
// opens it for a person.
//
// Permissions are the agent's own setting (default acceptEdits: it may edit inside the
// project folder, and anything else asks — which, headless, means "no"). Never bypass.
// What it may do without asking is the bridge's `tools` (src/tools.js; default: the lab
// preset), passed as --allowedTools, so a seat can run its own tests from its first turn.
const IDLE_MS = 30 * 60_000
const TURN_TIMEOUT_MS = 20 * 60_000

export class ClaudeProcess {
  constructor ({ name, room, participant, bridge, system, onActivity }) {
    this.name = name
    this.room = room
    this.p = participant
    this.bridge = bridge // { kind: 'claude', dir, permissionMode?, tools?: [] , model? }
    this.system = system
    this.onActivity = onActivity ?? (() => {})
    this.child = null
    this.pending = null // { resolve, reject, timer }
    this.buf = ''
    this.stderr = []
    this.failures = 0
    this.sessionId = null
  }

  #spawn () {
    const topic = this.room.topic
    let sessionId = agentSession(this.p, topic)
    const fresh = !sessionId
    if (fresh) { sessionId = randomUUID(); agentSession(this.p, topic, sessionId) }
    this.sessionId = sessionId
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', this.bridge.permissionMode ?? 'acceptEdits',
      fresh ? '--session-id' : '--resume', sessionId]
    if (this.bridge.model) args.push('--model', this.bridge.model)
    const { allow, deny } = resolveTools(this.bridge.tools, this.bridge.dir)
    if (allow.length) args.push('--allowedTools', ...allow)
    if (deny.length) args.push('--disallowedTools', ...deny)
    if (this.system) args.push('--append-system-prompt', this.system)
    // never inherit a parent Claude Code's session markers: this is its own process
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_SESSION')) delete env[k]
    const child = spawn(this.bridge.command ?? 'claude', args, { cwd: this.bridge.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.buf = ''; this.stderr = []
    child.stdout.on('data', (d) => this.#onData(d))
    child.stderr.on('data', (d) => { this.stderr.push(String(d)); if (this.stderr.length > 40) this.stderr.shift() })
    child.on('error', (err) => this.#gone(`could not start claude: ${err.message}`))
    child.on('exit', (code, sig) => this.#gone(code === 0 || sig === 'SIGTERM' ? null : `claude exited (${code ?? sig}): ${this.stderr.join('').trim().split('\n').slice(-3).join(' | ') || 'no stderr'}`))
    this.onActivity(`${fresh ? 'started' : 'resumed'} Claude Code in ${this.bridge.dir} (session ${sessionId.slice(0, 8)})`)
    return child
  }

  #onData (d) {
    this.buf += String(d)
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id && ev.session_id !== this.sessionId) {
        this.sessionId = ev.session_id; agentSession(this.p, this.room.topic, ev.session_id)
      }
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use') this.onActivity(`${b.name}: ${summarize(b.input)}`)
        }
      }
      if (ev.type === 'result') {
        const pend = this.pending; this.pending = null
        if (!pend) continue
        clearTimeout(pend.timer)
        const u = ev.usage
        const usage = u ? { model: ev.model ?? this.bridge.model ?? 'claude', in: u.input_tokens, out: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, costUsd: ev.total_cost_usd } : null
        if (ev.is_error) pend.reject(new Error(`claude: ${ev.result || ev.subtype || 'error'}`))
        else pend.resolve({ reply: typeof ev.result === 'string' ? ev.result : '', usage })
        this.failures = 0
        // the tool list changed while this turn ran: the next turn gets a process with the new flags
        if (this.retireAfterTurn) { this.retireAfterTurn = false; this.stop('idle') } else this.#armIdle()
      }
    }
  }

  #gone (error) {
    const pend = this.pending; this.pending = null
    this.child = null
    clearTimeout(this.idleTimer)
    if (!pend) return
    clearTimeout(pend.timer)
    // a session that cannot be resumed (moved machine, wiped ~/.claude) starts over once
    if (error && /No conversation found|session.*not found|could not resume/i.test(error) && !pend.retried) {
      agentSession(this.p, this.room.topic, null)
      this.onActivity('the saved session is gone; starting a fresh one')
      pend.retried = true
      try { this.#send(pend.text, pend); return } catch (err) { error = err.message }
    }
    this.failures++
    pend.reject(new Error(error ?? 'claude stopped before answering'))
  }

  #armIdle () {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { if (!this.pending) this.stop('idle') }, IDLE_MS)
    this.idleTimer.unref?.()
  }

  #send (text, pend) {
    if (!this.child) this.#spawn()
    this.pending = pend
    pend.text = text
    pend.timer = setTimeout(() => { this.stop('turn timed out'); }, TURN_TIMEOUT_MS)
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
  }

  // One turn in, one reply out. Rejects if the process dies or the turn times out; the
  // runner marks the agent as errored and the next poke tries again (a fresh process).
  prompt (text) {
    if (this.pending) return Promise.reject(new Error('a turn is already in flight'))
    // crash loop guard: after three failures in a row, wait before trying again
    if (this.failures >= 3 && Date.now() - (this.lastFailAt ?? 0) < 5 * 60_000) return Promise.reject(new Error('claude keeps failing; backing off for five minutes'))
    return new Promise((resolve, reject) => {
      const pend = { resolve, reject: (e) => { this.lastFailAt = Date.now(); reject(e) }, timer: null, retried: false }
      try { this.#send(text, pend) } catch (err) { this.pending = null; pend.reject(err) }
    })
  }

  stop (why = 'stopped') {
    const c = this.child
    if (!c) return
    this.child = null
    clearTimeout(this.idleTimer)
    try { c.stdin.end() } catch {}
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 3000); t.unref?.()
    try { c.kill('SIGTERM') } catch {}
    if (why !== 'idle') this.onActivity(`Claude Code ${why}`)
    if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.reject(new Error(why)) }
  }
}

function summarize (input) {
  if (!input || typeof input !== 'object') return ''
  const s = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description ?? JSON.stringify(input)
  return String(s).replace(/\s+/g, ' ').slice(0, 100)
}
