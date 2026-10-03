#!/usr/bin/env node
// Claude Code Stop hook → report what this turn actually cost to rKeyChat.
//
// Claude Code records usage per assistant message in its transcript: input,
// output, cache read and cache write tokens, and the model. A wake of a CLI
// agent spends all of that (the context is re-read in full before a word is
// written), so this is the number the room's caps are measured against.
//
// Never blocks, never fails a turn: it gives up fast and exits 0.
//
//   RKEYCHAT_AS    which agent this session is (default claude)
//   RKEYCHAT_ROOM  which room to bill it to (default: the first room)

import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir = process.env.RKEYCHAT_DATA || join(homedir(), '.rkeychat')
let cfg = {}
try { cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) } catch {}
const port = process.env.RKEYCHAT_PORT || cfg.port || 4455
const as = process.env.RKEYCHAT_AS || 'claude'
const room = process.env.RKEYCHAT_ROOM || cfg.rooms?.[0]?.name
const trace = (...a) => { try { appendFileSync(join(dataDir, 'hooks.log'), `${new Date().toISOString()} [usage] ${a.join(' ')}\n`) } catch {} }

function tail (path, bytes = 2 * 1024 * 1024) {
  const fd = openSync(path, 'r')
  const size = fstatSync(fd).size
  const len = Math.min(size, bytes)
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, size - len)
  closeSync(fd)
  return buf.toString('utf8').split('\n').slice(1).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

// Report the DELTA since the last report, not "this turn": a session can stop
// several times between human prompts (background wake-ups), and counting from
// the last prompt each time would bill the same tokens repeatedly. The running
// total per transcript is kept beside the config.
function usageDelta (transcript) {
  const entries = tail(transcript).filter((e) => !e.isSidechain)
  const run = { model: '', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  const seen = new Set()
  for (const e of entries) {
    const u = e.message?.usage
    if (!u || e.type !== 'assistant') continue
    const id = e.uuid || e.message?.id
    if (id) { if (seen.has(id)) continue; seen.add(id) }
    run.model = e.message.model || run.model
    run.in += u.input_tokens || 0
    run.out += u.output_tokens || 0
    run.cacheRead += u.cache_read_input_tokens || 0
    run.cacheWrite += u.cache_creation_input_tokens || 0
  }

  // the tail window is bounded, so the running total is only a floor; keep the
  // high-water mark per transcript and report what is new above it
  const markPath = join(dataDir, `.usage-${Buffer.from(transcript).toString('base64url').slice(-40)}.json`)
  let prev = null
  try { prev = JSON.parse(readFileSync(markPath, 'utf8')) } catch {}
  if (!prev) { // first run for this session: start the meter here, don't bill the backlog
    try { writeFileSync(markPath, JSON.stringify(run)) } catch {}
    return null
  }
  const delta = {
    model: run.model,
    in: Math.max(0, run.in - (prev.in || 0)),
    out: Math.max(0, run.out - (prev.out || 0)),
    cacheRead: Math.max(0, run.cacheRead - (prev.cacheRead || 0)),
    cacheWrite: Math.max(0, run.cacheWrite - (prev.cacheWrite || 0))
  }
  try { writeFileSync(markPath, JSON.stringify(run)) } catch {}
  return (delta.in + delta.out + delta.cacheRead + delta.cacheWrite) > 0 ? delta : null
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
try {
  const ev = JSON.parse(raw)
  if (ev.hook_event_name !== 'Stop' || ev.stop_hook_active || !ev.transcript_path) process.exit(0)
  const usage = usageDelta(ev.transcript_path)
  if (!usage) process.exit(0)
  const res = await fetch(`http://127.0.0.1:${port}/api/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, as, usage, text: 'answered' }),
    signal: AbortSignal.timeout(1500)
  })
  const out = await res.json().catch(() => ({}))
  trace(`${usage.model} in=${usage.in} out=${usage.out} cacheRead=${usage.cacheRead}`, out.overBudget ? 'OVER BUDGET' : '')
} catch (err) { trace('error', err?.message) }
process.exit(0)
