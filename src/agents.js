// Waking agents. For every agent hosted on this device the daemon watches the
// room; when something is addressed to it and the round budget allows a reply,
// it builds one turn from everything new since the agent last spoke and hands
// it to the agent's bridge:
//
//   hermes — calls the local Hermes Agent API server and posts the reply.
//   stream — delivers the turn to whoever is listening on /api/wait (Claude
//            Code via `rkeychat wait`), who replies with `rkeychat send`.

import { replyDepth } from './turns.js'
import { TURN_WINDOW } from './room.js'

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
    if (this.bridge.kind === 'stream') this.#offer()
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
