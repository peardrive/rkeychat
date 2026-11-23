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
import { MAIN } from './proto.js'
import { agentSession, sessionKeyOf } from './config.js'
import { AcpProcess } from './acp.js'
import { resolveTools } from './tools.js'
import { providerEnv, autoState } from './seat-settings.js'

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
// How long an agent's ask waits for a person before it counts as refused: the device default (config.json
// askMinutes, set at boot and by `rkeychat agent ask-minutes all N`); a seat's bridge.askMinutes overrides it.
export const askSettings = { minutes: 10 }
export const askMinutesOf = (bridge) => (Number(bridge?.askMinutes) >= 1 ? Number(bridge.askMinutes) : askSettings.minutes)

const PASS = /^\s*PASS\s*$/i
const fmtTime = (ts) => new Date(ts).toTimeString().slice(0, 5)

const fmtSize = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`

// One turn's text for an agent: the standing rules (intro), the room's purpose, and the messages since it
// last spoke. Scoped to one conversation (`conv`, default the room's main one): what it said in another
// conversation is not "having answered" here, and it only reads this conversation's messages.
export function renderTurn (room, name, { intro = false, conv = MAIN } = {}) {
  const log = room.log(conv)
  const triggers = room.triggersFor(name, conv)
  let lastOwn = -1
  log.forEach((r, i) => { if (r.kind === 'msg' && r.name === name) lastOwn = i })
  const fresh = log.slice(lastOwn + 1).filter((r) => r.kind === 'msg' && !r.redacted).slice(-40)
  const others = room.participantsList().filter((p) => p.name !== name && p.status === 'active')
  const b = room.budget(conv)
  const convo = conv === MAIN ? null : room.conversation(conv)
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
    if (room.cfg.folder) lines.push(`This room is a project: its folder is ${room.cfg.folder}. The project's files, code and notes live there; that is where work happens.`, '')
    lines.push('A room holds several conversations. You are in one of them; its messages are all you see here, and what you say lands in it. People start a new conversation for each new piece of work so that contexts stay separate.', '')
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
  lines.push(`[room ${room.cfg.name}${convo ? ` · conversation: ${convo.title}` : ''} · you are @${name} · others: ${others.map((p) => `@${p.name}${p.role === 'human' ? ' (human)' : ''}${p.online ? '' : ' (offline)'}`).join(', ')} · rounds left after your reply: ${left}]`)
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
    this.bridge = bridge // { kind: 'hermes', url, key } | { kind: 'stream' } | { kind: 'claude', dir, via?, … }
    this.introduced = false
    this.listeners = new Set() // for stream bridges
    // One turn at a time per conversation: conv -> { busy, offered, offeredAt, offerTimer, proc }.
    // A claude seat holds one process (one Claude Code session) per conversation it has been
    // woken in; a stream seat (one listener) takes one turn at a time across the room.
    this.turns = new Map()
    this.room.on('record', () => this.poke())
    this.room.on('changed', () => this.poke())
    // a stream agent isn't listening until something connects to /api/wait
    if (bridge.kind === 'stream') this.room.agentState.set(name, 'offline')
  }

  #turn (conv) {
    let t = this.turns.get(conv)
    if (!t) { t = { conv, busy: false, offered: null, offeredAt: 0, offerTimer: null, proc: null }; this.turns.set(conv, t) }
    return t
  }

  // A turn is out somewhere in this room (the server routes an agent's reply to the room it is busy in).
  get busy () { return [...this.turns.values()].some((t) => t.busy) }
  #busyTurn () { return [...this.turns.values()].find((t) => t.busy) ?? null }
  // The ids the newest outstanding turn covers: what a stream agent's reply answers when it names none.
  get offered () { return this.#latestOffered()?.offered ?? null }
  #latestOffered () {
    let best = null
    for (const t of this.turns.values()) if (t.offered && (!best || t.offeredAt > best.offeredAt)) best = t
    return best
  }

  // the conversations this agent can be woken in: the open ones
  #convs () { return this.room.conversations().filter((c) => !c.archived).map((c) => c.conv) }

  due () { return this.dueTurns()[0]?.triggers ?? null }

  // Every conversation with something for this agent to answer: [{ conv, triggers }].
  dueTurns () {
    const out = []
    for (const conv of this.#convs()) {
      const { triggers } = this.why(conv)
      if (triggers) out.push({ conv, triggers })
    }
    return out
  }

  // Why this agent would or wouldn't be woken right now in one conversation (rkeychat debug agent NAME).
  why (conv = MAIN) {
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
    const triggers = this.room.triggersFor(this.name, conv)
    if (!triggers.length) return { triggers: null, reason: 'nothing addressed to me that I haven\'t answered or passed on', key: me, conv }
    const depth = replyDepth(triggers)
    if (!this.room.budget(conv).allows(depth, this.name)) return { triggers: null, reason: `budget refuses depth ${depth} (paused, per-agent limit, or out of rounds)`, key: me, conv, waiting: triggers.map((t) => t.id) }
    return { triggers, reason: 'due', key: me, conv }
  }

  poke () {
    for (const { conv, triggers } of this.dueTurns()) this.#pokeConv(conv, triggers)
  }

  #pokeConv (conv, triggers) {
    const t = this.#turn(conv)
    const now = Date.now()
    // Busy means a turn is already out. An agent talking to itself can wait — but a
    // person cannot be made to. If a human has said something the outstanding turn
    // doesn't cover, supersede it: the turn is re-rendered (now carrying both) and
    // pushed again, so the agent answers once rather than twice. Without this, a
    // follow-up sits unseen until the agent happens to finish.
    const fresh = triggers.filter((x) => !t.offered?.includes(x.id))
    if (this.bridge.kind === 'stream') {
      // one listener: one turn at a time across the whole room
      if (this.busy) {
        if (!this.listeners.size || !fresh.some((x) => x.human)) return
        const cur = this.#busyTurn()
        clearTimeout(cur.offerTimer); cur.busy = false
        this.room.setAgentState(this.name, 'idle', cur.conv)
      } else if (!fresh.length && t.offered?.length && now - t.offeredAt < REOFFER) {
        // This exact turn was handed over moments ago and is being worked on. A
        // listener that reconnects straight away (one turn per process, so it does)
        // must not be given it again, or it loops. After REOFFER we assume whoever
        // took it is gone and hand it to the next listener.
        return
      }
      return this.#offer(t)
    }
    if (t.busy) {
      // Only a person preempts. An agent answering an agent can wait its turn.
      if (!fresh.some((x) => x.human)) return
      // ACP: the running turn is cancelled; when it comes back cancelled, #runClaude renders a
      // turn carrying both messages and asks again. The cli path takes the message as the next turn.
      if (this.bridge.kind === 'claude' && this.bridge.via === 'acp') t.proc?.cancel()
      return
    }
    if (this.bridge.kind === 'hermes') this.#runHermes(t).catch((err) => this.#fail(err, t))
    if (this.bridge.kind === 'claude') this.#runClaude(t).catch((err) => this.#fail(err, t))
  }

  // ---- claude bridge (a project agent) ----

  // The agent needs a permission its tool list does not settle: put the question in the conversation as a signed
  // 'ask' and wait for one of the owner's devices to answer it (room.answer, account-gated). The seat shows as
  // waiting meanwhile. Null when nobody answers in time: the process refuses the call.
  async #ask (ask, t) {
    const ms = askMinutesOf(this.bridge) * 60_000
    const rec = await this.room.ask(this.name, { ...ask, conv: t.conv, expires: Date.now() + ms })
    if (!rec) return null
    this.room.setAgentState(this.name, 'waiting', t.conv)
    try {
      const a = await this.room.awaitAnswer(rec.id, ms)
      return a ? { choice: a.choice, by: a.name, device: a.device } : null
    } finally {
      if (t.busy) this.room.setAgentState(this.name, 'thinking', t.conv)
    }
  }

  async #runClaude (t) {
    t.busy = true
    this.room.setAgentState(this.name, 'thinking', t.conv)
    // Auto counts its turns here; a grant that has run out puts the seat back in its old mode before this turn
    // (the daemon hears 'auto-over' and changes the shared bridge object now; the room hears why)
    if (this.bridge.permissionMode === 'auto') {
      const st = autoState(this.bridge.auto ?? { since: Date.now(), used: 0 }, this.room.autoCap?.() ?? null)
      if (st.over) this.room.emit('auto-over', { name: this.name, why: st.over })
      else if (this.bridge.auto) { this.bridge.auto.used = (this.bridge.auto.used ?? 0) + 1; this.room.emit('auto-turn', { name: this.name }) }
    }
    const turn = renderTurn(this.room, this.name, { intro: false, conv: t.conv })
    this.room.activity(this.name, `woken by ${turn.triggers.map((x) => x.name).join(', ')}`, { claim: turn.triggers.map((x) => x.id), conv: t.conv }).catch(() => {})
    t.offered = turn.triggers.map((x) => x.id); t.offeredAt = Date.now() // what this turn covers; a newer human message preempts it (ACP)
    if (!t.proc) {
      const Proc = this.bridge.via === 'acp' ? AcpProcess : ClaudeProcess
      t.proc = new Proc({
        name: this.name,
        room: this.room,
        conv: t.conv,
        participant: this.room.local[this.name],
        bridge: this.bridge,
        // the standing rules go in once, as system prompt; turns arrive as messages
        system: renderTurn(this.room, this.name, { intro: true, conv: t.conv }).text.split('\n[room ')[0],
        onActivity: (text, extra) => this.room.activity(this.name, text, { ...extra, conv: t.conv }).catch(() => {}),
        onAsk: (ask) => this.#ask(ask, t),
        askMinutes: () => askMinutesOf(this.bridge),
        env: () => providerEnv(this.bridge)
      })
    }
    const { reply, usage, cancelled } = await t.proc.prompt(turn.text)
    if (usage) await this.room.activity(this.name, cancelled ? 'interrupted' : 'answered', { usage, conv: t.conv }).catch(() => {})
    if (cancelled) {
      // a person spoke mid-turn: nothing is posted; the next poke renders a turn with both
      t.busy = false
      this.room.setAgentState(this.name, 'idle', t.conv)
      setImmediate(() => this.poke())
      return
    }
    await this.#deliver(reply, turn.triggers.map((x) => x.id), t)
  }

  stop () { for (const t of this.turns.values()) t.proc?.stop() }

  // The bridge's tool list (or how it is driven) changed: the flags are fixed at spawn, so each
  // process is retired — now if it is idle, after its turn if one is in flight.
  reconfigured () {
    for (const t of this.turns.values()) {
      if (!t.proc) continue
      if (t.busy) t.proc.retireAfterTurn = true
      else { t.proc.stop('idle'); t.proc = null }
    }
  }

  // The seat's permission mode changed. Over ACP the open sessions take it now (`session/set_mode`); a cli process
  // was started with the old flag, so it is retired like a tools change. The bridge object is shared with the
  // daemon's config, so it already carries the new mode.
  applyMode (mode) {
    for (const t of this.turns.values()) {
      if (!t.proc) continue
      if (t.proc instanceof AcpProcess) t.proc.setMode(mode).catch(() => {})
      else if (t.busy) t.proc.retireAfterTurn = true
      else { t.proc.stop('idle'); t.proc = null }
    }
  }

  // The seat's model changed: ACP sessions switch in place; cli processes are retired.
  applyModel (model) {
    for (const t of this.turns.values()) {
      if (!t.proc) continue
      if (t.proc instanceof AcpProcess) t.proc.setModel(model).catch(() => {})
      else if (t.busy) t.proc.retireAfterTurn = true
      else { t.proc.stop('idle'); t.proc = null }
    }
  }

  // A conversation's runtime changed: that one process goes, the next turn starts the new kind.
  retire (conv) {
    const t = this.turns.get(conv)
    if (!t?.proc) return
    if (t.busy) t.proc.retireAfterTurn = true
    else { t.proc.stop('idle'); t.proc = null }
  }

  #fail (err, t) {
    if (t) t.busy = false
    this.room.setAgentState(this.name, 'error', t?.conv)
    this.room.emit('agent-error', { name: this.name, error: String(err?.message ?? err), conv: t?.conv })
  }

  // ---- stream bridge (Claude Code) ----

  #offer (t) {
    if (!this.listeners.size) {
      this.room.setAgentState(this.name, 'waiting', t.conv)
      return
    }
    const turn = renderTurn(this.room, this.name, { intro: !this.introduced, conv: t.conv })
    this.introduced = true
    t.busy = true
    this.room.setAgentState(this.name, 'thinking', t.conv)
    t.offered = turn.triggers.map((x) => x.id)
    t.offeredAt = Date.now()
    this.room.activity(this.name, `got a turn: ${turn.triggers.map((x) => `${x.name}'s message`).join(', ')}`, { claim: t.offered, conv: t.conv }).catch(() => {})
    for (const fn of this.listeners) fn({ name: this.name, re: t.offered, conv: t.conv, prompt: turn.text })
    // if nobody answers within the window, free the slot so newer turns flow
    clearTimeout(t.offerTimer)
    t.offerTimer = setTimeout(() => { t.busy = false; this.room.setAgentState(this.name, 'idle', t.conv); this.poke() }, 15 * 60_000)
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
      for (const t of this.turns.values()) if (t.busy) { clearTimeout(t.offerTimer); t.busy = false } // `offered` stays: it suppresses an instant re-offer
    }
  }

  // called after the stream agent posts (or passes); `conv` says which turn, else the newest one offered
  answered ({ passed = false, conv } = {}) {
    const t = (conv && this.turns.get(conv)) || this.#latestOffered() || this.#busyTurn()
    if (!t) return
    if (passed && t.offered) this.room.markPassed(this.name, t.offered)
    clearTimeout(t.offerTimer)
    t.offered = null; t.offeredAt = 0
    t.busy = false
    this.room.setAgentState(this.name, 'idle', t.conv)
    setImmediate(() => this.poke())
  }

  // ---- hermes bridge ----

  async #runHermes (t) {
    t.busy = true
    this.room.setAgentState(this.name, 'thinking', t.conv)
    const turn = renderTurn(this.room, this.name, { intro: !this.introduced, conv: t.conv })
    this.room.activity(this.name, `woken by ${turn.triggers.map((x) => x.name).join(', ')}; asking Hermes`, { claim: turn.triggers.map((x) => x.id), conv: t.conv }).catch(() => {})
    const { url = 'http://127.0.0.1:8642', key, model = 'hermes-agent' } = this.bridge
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        'x-hermes-session-id': `rkeychat-${this.room.topic.slice(0, 12)}-${this.name}${t.conv === MAIN ? '' : '-' + t.conv}`
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
        conv: t.conv,
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
    await this.#deliver(reply, turn.triggers.map((x) => x.id), t)
  }

  async #deliver (reply, re, t) {
    try {
      if (reply && !PASS.test(reply)) await this.room.post(this.name, reply, { re, conv: t.conv })
      else { this.room.markPassed(this.name, re); this.room.activity(this.name, 'decided to stay quiet (PASS)', { conv: t.conv }).catch(() => {}) }
    } finally {
      t.busy = false
      this.room.setAgentState(this.name, 'idle', t.conv)
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
  constructor ({ name, room, conv = MAIN, participant, bridge, system, onActivity }) {
    this.name = name
    this.room = room
    this.conv = conv
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

  // the saved session id is kept per room, and per conversation beyond the default one
  get sessionKey () { return sessionKeyOf(this.room.topic, this.conv) }

  #spawn () {
    let sessionId = agentSession(this.p, this.sessionKey)
    const fresh = !sessionId
    if (fresh) { sessionId = randomUUID(); agentSession(this.p, this.sessionKey, sessionId) }
    this.sessionId = sessionId
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      // the cli names Ask "manual"; our Auto has no ask path here (-p asks nobody), so it runs as Edits
      '--permission-mode', ({ default: 'manual', auto: 'acceptEdits' })[this.bridge.permissionMode] ?? this.bridge.permissionMode ?? 'acceptEdits',
      fresh ? '--session-id' : '--resume', sessionId]
    if (this.bridge.model) args.push('--model', this.bridge.model)
    const { allow, deny } = resolveTools(this.bridge.tools, this.bridge.dir)
    if (allow.length) args.push('--allowedTools', ...allow)
    if (deny.length) args.push('--disallowedTools', ...deny)
    if (this.system) args.push('--append-system-prompt', this.system)
    // never inherit a parent Claude Code's session markers: this is its own process
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_SESSION')) delete env[k]
    Object.assign(env, providerEnv(this.bridge)) // the seat's provider, or nothing: the login
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
        this.sessionId = ev.session_id; agentSession(this.p, this.sessionKey, ev.session_id)
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
      agentSession(this.p, this.sessionKey, null)
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
