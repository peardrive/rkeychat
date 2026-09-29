#!/usr/bin/env node
// Claude Code hook → mirror the terminal conversation into rKeyChat, so the
// room holds the whole conversation and the terminal becomes optional.
//
//   UserPromptSubmit: what the human typed in the terminal → posted as them
//   Stop:             Claude's final reply for that turn  → posted as Claude,
//                     unless Claude already answered in the room that turn
//
// Mirrored messages are marked via 'mirror': a record of what was said. They
// never wake agents and never spend rounds. Always exits 0, gives up fast.
//
//   RKEYCHAT_AS / RKEYCHAT_HUMAN  names (default claude / the device's human)
//   RKEYCHAT_MIRROR_ROOM          room to mirror into (default: the first room)

import { readFileSync, openSync, readSync, fstatSync, closeSync, appendFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir = process.env.RKEYCHAT_DATA || join(homedir(), '.rkeychat')
let cfg = {}
try { cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) } catch {}
const port = process.env.RKEYCHAT_PORT || cfg.port || 4455
const agent = process.env.RKEYCHAT_AS || 'claude'
const humanName = process.env.RKEYCHAT_HUMAN || Object.entries(cfg.participants ?? {}).find(([, p]) => p.role === 'human')?.[0]
const room = process.env.RKEYCHAT_MIRROR_ROOM || cfg.rooms?.[0]?.name

async function post (as, text) {
  if (!as || !text?.trim()) return
  await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, as, text: text.trim().slice(0, 20000), via: 'mirror' }),
    signal: AbortSignal.timeout(1500)
  })
}

function tail (path, bytes = 512 * 1024) {
  const fd = openSync(path, 'r')
  const size = fstatSync(fd).size
  const len = Math.min(size, bytes)
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, size - len)
  closeSync(fd)
  return buf.toString('utf8').split('\n').slice(1).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

// The current turn = everything after the last real human prompt.
function finalReply (transcript) {
  const entries = tail(transcript).filter((e) => !e.isSidechain)
  let start = -1
  entries.forEach((e, i) => {
    const c = e.message?.content
    const isPrompt = e.type === 'user' && (typeof c === 'string' || (Array.isArray(c) && c.some((x) => x.type === 'text')))
    if (isPrompt) start = i
  })
  const turn = entries.slice(start + 1)
  const answeredInRoom = turn.some((e) => (e.message?.content ?? []).some?.((x) => x.type === 'tool_use' && /rkeychat(\.js)?\s+send\b/.test(x.input?.command ?? '')))
  if (answeredInRoom) return null
  const texts = turn.filter((e) => e.type === 'assistant').map((e) => (e.message?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim()).filter(Boolean)
  return texts.at(-1) ?? null
}

const trace = (...a) => { try { appendFileSync(join(dataDir, 'hooks.log'), `${new Date().toISOString()} ${a.join(' ')}\n`) } catch {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function answeredInRoomNow (transcript) {
  const entries = tail(transcript).filter((e) => !e.isSidechain)
  let start = -1
  entries.forEach((e, i) => { const c = e.message?.content; if (e.type === 'user' && (typeof c === 'string' || (Array.isArray(c) && c.some((x) => x.type === 'text')))) start = i })
  return entries.slice(start + 1).some((e) => (e.message?.content ?? []).some?.((x) => x.type === 'tool_use' && /rkeychat(\.js)?\s+send\b/.test(x.input?.command ?? '')))
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
try {
  const ev = JSON.parse(raw)
  trace('event', ev.hook_event_name, 'active', ev.stop_hook_active)
  // Only turns a person started get mirrored. Turns triggered by background
  // events (monitor wake-ups, task notices) are housekeeping, not conversation.
  const marker = join(dataDir, '.mirror-turn')
  if (ev.hook_event_name === 'UserPromptSubmit') {
    const p = String(ev.prompt ?? '')
    const human = p.trim() && !p.trim().startsWith('/') && !/<task-notification>|<system-reminder>/.test(p)
    if (human) { writeFileSync(marker, String(Date.now())); await post(humanName, p) } else rmSync(marker, { force: true })
  } else if (ev.hook_event_name === 'Stop' && !ev.stop_hook_active && ev.transcript_path) {
    if (!existsSync(marker)) { trace('stop skipped: not a human-started turn'); process.exit(0) }
    rmSync(marker, { force: true })
    // the transcript may not have the final text flushed yet; prefer the hook's own copy
    let reply = typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message : null
    if (!reply) { await sleep(400); reply = finalReply(ev.transcript_path) }
    else if (answeredInRoomNow(ev.transcript_path)) reply = null
    trace('stop reply', reply ? `${reply.length} chars` : 'none (answered in room or empty)')
    if (reply) await post(agent, reply)
  }
} catch (err) { trace('error', err?.message) }
process.exit(0)
