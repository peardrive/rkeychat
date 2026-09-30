#!/usr/bin/env node
// Claude Code hook → rKeyChat activity. Wire it as a PostToolUse hook; every
// tool Claude uses becomes one line in its activity feed (people can watch it;
// agents never read it). Always exits 0 and gives up fast: a hook must never
// slow down or break the session.
//
//   RKEYCHAT_AS   participant name (default: claude)
//   RKEYCHAT_PORT daemon port (default: from ~/.rkeychat/config.json, else 4455)

import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const as = process.env.RKEYCHAT_AS || 'claude'
let port = process.env.RKEYCHAT_PORT
if (!port) {
  try { port = JSON.parse(readFileSync(join(process.env.RKEYCHAT_DATA || join(homedir(), '.rkeychat'), 'config.json'), 'utf8')).port } catch {}
}
port = port || 4455

const short = (s, n = 140) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const file = (p) => { const s = String(p ?? ''); return s.replace(homedir(), '~') }

function describe ({ tool_name: t, tool_input: i = {} }) {
  switch (t) {
    case 'Bash': return `ran: ${short(i.description || i.command)}`
    case 'Read': return `read ${file(i.file_path)}`
    case 'Edit': return `edited ${file(i.file_path)}`
    case 'Write': return `wrote ${file(i.file_path)}`
    case 'Grep': return `searched for "${short(i.pattern, 60)}"${i.path ? ` in ${file(i.path)}` : ''}`
    case 'Glob': return `looked for files: ${short(i.pattern, 80)}`
    case 'Agent': return `started a sub-agent: ${short(i.description || i.prompt, 100)}`
    case 'WebSearch': return `searched the web: ${short(i.query, 100)}`
    case 'WebFetch': return `fetched ${short(i.url, 100)}`
    case 'Monitor': return `watching: ${short(i.description, 100)}`
    case 'Skill': return `used skill ${i.skill}`
    default: return t ? `used ${t}` : null
  }
}

// What Claude wrote since the last hook call (its narration between tool uses),
// read from the tail of the session transcript. Hidden reasoning isn't in there.
function newNarration (transcript) {
  if (!transcript) return []
  const statePath = join(process.env.RKEYCHAT_DATA || join(homedir(), '.rkeychat'), '.hook-state.json')
  let state = {}
  try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch {}
  const fd = openSync(transcript, 'r')
  const size = fstatSync(fd).size
  const len = Math.min(size, 256 * 1024)
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, size - len)
  closeSync(fd)
  const entries = []
  for (const line of buf.toString('utf8').split('\n').slice(1)) {
    try {
      const d = JSON.parse(line)
      if (d.type !== 'assistant' || d.isSidechain) continue
      const text = (d.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
      if (text && d.uuid) entries.push({ uuid: d.uuid, text })
    } catch {}
  }
  const seen = state[transcript]
  const start = seen ? entries.findIndex((e) => e.uuid === seen) + 1 : Math.max(0, entries.length - 1)
  const fresh = entries.slice(start > 0 || seen ? start : 0).slice(-3)
  if (entries.length) {
    state[transcript] = entries.at(-1).uuid
    try { writeFileSync(statePath, JSON.stringify(state)) } catch {}
  }
  return fresh.map((e) => `wrote: ${short(e.text, 1200)}`)
}

async function post (text) {
  await fetch(`http://127.0.0.1:${port}/api/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ as, text }),
    signal: AbortSignal.timeout(800)
  })
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
try {
  const ev = JSON.parse(raw)
  try { for (const t of newNarration(ev.transcript_path)) await post(t) } catch {}
  // don't echo the agent's own rkeychat traffic back into its feed
  if (ev.tool_name === 'Bash' && /rkeychat(\.js)? (send|activity|wait)/.test(ev.tool_input?.command ?? '')) process.exit(0)
  let text = describe(ev)
  // what a command printed, trimmed: the terminal's output, behind Thinking
  if (text && ev.tool_name === 'Bash') {
    const r = ev.tool_response
    const out = typeof r === 'string' ? r : [r?.stdout, r?.stderr].filter(Boolean).join('\n') || (r?.output ?? '')
    const lines = String(out ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean)
    if (lines.length) text += '\n' + lines.slice(0, 12).map((l) => '  ' + l.slice(0, 200)).join('\n') + (lines.length > 12 ? `\n  … ${lines.length - 12} more lines` : '')
  }
  if (text) await post(text)
} catch {}
process.exit(0)
