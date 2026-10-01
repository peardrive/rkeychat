#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawn, execFile } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, newConfig, addParticipant, migrate, dataDir, newIdentity, accountSigner } from '../src/config.js'
import { decodeInvite } from '../src/server.js'

const USAGE = `rkeychat — a room for you and your agents, on pearcore + rKey

  rkeychat                     where am I, what's next
  rkeychat open                open the GUI in your browser

daemon
  rkeychat start [--background] [--create ROOM]
  rkeychat stop

rooms
  rkeychat rooms                       list rooms
  rkeychat room create NAME            new room (you own it)
  rkeychat room join INVITE            join someone's room; prints the request to send them
  rkeychat invite [--room R]           owner: invite code for a room
  rkeychat approve REQUEST [--room R]  owner: enroll a device + its participants
  rkeychat request [--room R]          print this device's join request again

talk                                   (--room R picks the room; default: the first)
  rkeychat send [--as NAME] TEXT...    post (agents: answers the turn they were given)
  rkeychat send --as NAME --pass       stay silent on the current turn
  rkeychat send --voice TEXT...        mark as dictated (applies the glossary fixes)
  rkeychat models install              download the speech model (Parakeet v3, ~490 MB)
  rkeychat glossary [add HEARD MEANT | rm HEARD]   dictation fixes, e.g. add "pair core" pearcore
  rkeychat log [N] | status
  rkeychat wait --as NAME              stream turns for a CLI agent (Claude Code: run under Monitor)
  rkeychat react [--as NAME] [TARGET|last] EMOJI [--off]   react to a message (never wakes anyone)
  rkeychat activity --as NAME TEXT     report what an agent is doing (people can watch; agents never read it)

agents
  rkeychat add NAME [--hermes URL --key KEY]   add an agent on this device
  rkeychat control pause|resume [AGENT]        everyone, or one agent
  rkeychat control limit AGENT N               max posts per human message (0 = no limit)
  rkeychat control extend N | until HOURS | unlimited | reset
  rkeychat send --file PATH [TEXT]         share a file by hash (any size); rkeychat files lists them, rkeychat get ROOT fetches one
  rkeychat identity [new NAME]                 show this device's accounts and keys; new re-mints NAME's root and session key
  rkeychat debug agent NAME                    why the daemon would or wouldn't wake an agent, per room
  rkeychat purpose --room ROOM [TEXT] [--order a,b]   the room's standing prompt for agents; order = who answers first
  rkeychat rename --room ROOM NAME             rename a room for everyone in it
  rkeychat revoke NAME [--key PREFIX]          remove (they can be invited back later); --key for one key
  rkeychat ban NAME [--key PREFIX]             keep them out until you lift it; rkeychat unban PREFIX lifts it
  rkeychat readopt --room ROOM PREFIX          bring back a removed account's orphaned keys`

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    port: { type: 'string' },
    human: { type: 'string' },
    hermes: { type: 'string' },
    key: { type: 'string' },
    model: { type: 'string' },
    create: { type: 'string' },
    as: { type: 'string' },
    room: { type: 'string' },
    order: { type: 'string' },
    key: { type: 'string' },
    file: { type: 'string' },
    pass: { type: 'boolean' },
    background: { type: 'boolean' },
    voice: { type: 'boolean' },
    off: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
})

const cmd = pos.shift()
const die = (msg) => { console.error(msg); process.exit(1) }
const cfgOrDie = () => { const c = loadConfig(); if (!c) die('not set up yet: rkeychat init --human YOURNAME'); return migrate(c) }
const port = () => opt.port ?? process.env.RKEYCHAT_PORT ?? cfgOrDie().port
const base = () => `http://127.0.0.1:${port()}`
const q = (params) => { const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString(); return s ? `?${s}` : '' }

async function running () {
  try { return (await fetch(base() + '/api/rooms', { signal: AbortSignal.timeout(800) })).ok } catch { return false }
}
async function api (method, path, payload) {
  let res
  try {
    res = await fetch(base() + path, { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined })
  } catch { die('the daemon isn\'t running. Start it: rkeychat start --background') }
  const out = await res.json()
  if (!res.ok) die(out.error ?? `HTTP ${res.status}`)
  return out
}

const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5)
const fmt = (r) => r.kind === 'control'
  ? `  · ${r.name} ${r.action}${r.agent ? ' @' + r.agent : ''}${r.n ? ' ' + r.n : ''}${r.until ? ' until ' + new Date(r.until).toLocaleTimeString() : ''}`
  : `[${hhmm(r.ts)}] ${r.name}${r.human ? '' : ` (r${r.depth})`}: ${r.text}`

async function nextStep () {
  const cfg = loadConfig() && cfgOrDie()
  if (!cfg) return 'next: rkeychat init --human YOURNAME   (on an agent-only machine: rkeychat init)'
  const up = await running()
  const lines = [`device "${cfg.deviceName}" · ${Object.keys(cfg.participants).map((n) => '@' + n).join(' ') || 'no participants'} · daemon ${up ? `running → http://127.0.0.1:${cfg.port}` : 'not running'}`]
  if (!up) lines.push('start it:            rkeychat start --background')
  if (!cfg.rooms.length) {
    lines.push('create a room:       rkeychat room create lab          (or in the GUI)')
    lines.push('join someone\'s:     rkeychat room join INVITE')
  } else {
    lines.push(`rooms: ${cfg.rooms.map((r) => r.name).join(', ')}`)
  }
  return lines.join('\n')
}

switch (cmd) {
  case undefined:
    console.log(await nextStep())
    break
  case 'help':
    console.log(USAGE)
    break
  case 'init': {
    if (loadConfig()) die('already set up. Run rkeychat to see where you are')
    const cfg = newConfig({ name: opt.name, port: opt.port ? Number(opt.port) : undefined })
    if (opt.human) addParticipant(cfg, opt.human, { role: 'human' })
    saveConfig(cfg)
    console.log(`set up device "${cfg.deviceName}"${opt.human ? ` with you as @${opt.human}` : ''}.`)
    console.log(await nextStep())
    break
  }
  case 'add': {
    const cfg = cfgOrDie()
    const name = pos[0] ?? die('usage: rkeychat add NAME [--hermes URL --key KEY]')
    const bridge = opt.hermes ? { kind: 'hermes', url: opt.hermes, key: opt.key, model: opt.model } : { kind: 'stream' }
    addParticipant(cfg, name, { role: 'agent', bridge })
    saveConfig(cfg)
    console.log(`added @${name} (${bridge.kind === 'hermes' ? 'Hermes' : 'CLI agent'}).`)
    if (await running()) console.log('restart the daemon to bring it online: rkeychat stop && rkeychat start --background')
    if (cfg.rooms.length) console.log('existing rooms need it enrolled: the room owner approves `rkeychat request --room ROOM` from this device')
    break
  }
  case 'start': {
    if (await running()) {
      if (opt.create) { const r = await api('POST', '/api/rooms', { name: opt.create }); console.log(`created room "${r.name}"`) }
      console.log(`already running → http://127.0.0.1:${port()}`)
      break
    }
    if (opt.background) {
      mkdirSync(dataDir(), { recursive: true })
      const log = join(dataDir(), 'daemon.log')
      const out = openSync(log, 'a')
      const args = [fileURLToPath(import.meta.url), 'start', ...(opt.create ? ['--create', opt.create] : [])]
      spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env: process.env }).unref()
      for (let i = 0; i < 60 && !(await running()); i++) await new Promise((r) => setTimeout(r, 250))
      console.log((await running()) ? `running in the background → http://127.0.0.1:${port()}   (log: ${log}, stop: rkeychat stop)` : `didn't come up. See ${log}`)
      break
    }
    const { runDaemon } = await import('../src/daemon.js')
    await runDaemon({ createRoomName: opt.create })
    break
  }
  case 'stop': {
    if (!(await running())) { console.log('not running'); break }
    try { await fetch(base() + '/api/stop', { method: 'POST' }) } catch {}
    console.log('stopped')
    break
  }
  case 'open': {
    if (!(await running())) die('the daemon isn\'t running. Start it: rkeychat start --background')
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [base()])
    break
  }
  case 'rooms': {
    const rooms = await api('GET', '/api/rooms')
    if (!rooms.length) console.log('no rooms yet: rkeychat room create NAME')
    for (const r of rooms) console.log(`${r.name.padEnd(16)} ${r.owner ? 'owner ' : 'member'} ${r.admitted ? `${r.members} people` : 'waiting for approval'}${r.last ? `  · ${r.last.name}: ${r.last.text?.slice(0, 50) ?? r.last.action}` : ''}`)
    break
  }
  case 'room': {
    const sub = pos.shift()
    if (sub === 'create') {
      const r = await api('POST', '/api/rooms', { name: pos.join(' ') || die('usage: rkeychat room create NAME') })
      console.log(`created "${r.name}". Invite others: rkeychat invite --room "${r.name}"`)
    } else if (sub === 'join') {
      const invite = pos[0] ?? die('usage: rkeychat room join INVITE')
      if (!(await running())) {
        // daemon down: remember it; it joins on next start
        const cfg = cfgOrDie(); const inv = decodeInvite(invite)
        cfg.rooms.push({ ...inv, dir: `rooms/${inv.topic.slice(0, 16)}`, pendingJoin: true }); saveConfig(cfg)
        console.log(`saved. Start the daemon (rkeychat start --background), then send the owner: rkeychat request --room "${inv.name}"`)
        break
      }
      const r = await api('POST', '/api/rooms/join', { invite })
      console.log(`joined "${r.room.name}". Send this request to the owner; they approve it in the GUI (Keys → Approve) or with rkeychat approve:\n\n${r.request}\n`)
    } else die('usage: rkeychat room create NAME | rkeychat room join INVITE')
    break
  }
  case 'join': // old spelling
    die('use: rkeychat room join INVITE')
    break
  case 'invite': console.log((await api('GET', '/api/invite' + q({ room: opt.room }))).invite); break
  case 'request': console.log((await api('GET', '/api/request' + q({ room: opt.room }))).request); break
  case 'approve': console.log(`enrolled ${(await api('POST', '/api/approve', { room: opt.room, code: pos[0] })).enrolled} keys`); break
  case 'send': {
    // --file PATH shares a file from this device by hash (no copy; the original is the source)
    const att = opt.file ? [await api('POST', '/api/share', { room: opt.room, path: resolve(opt.file) })] : undefined
    const out = await api('POST', '/api/send', { room: opt.room, as: opt.as, text: pos.join(' '), pass: !!opt.pass, via: opt.voice ? 'voice' : undefined, att })
    console.log(out.passed ? `passed (${out.room})` : fmt(out))
    if (out.fixes?.length) console.log(`  fixed: ${out.fixes.map(([a, b]) => `${a} → ${b}`).join(', ')}`)
    break
  }
  case 'control': {
    const [action, a, b] = pos
    const payload = { room: opt.room, action }
    if (action === 'extend') payload.n = Number(a ?? 1)
    else if (action === 'until') payload.hours = Number(a ?? 8)
    else if (action === 'limit') { payload.agent = a ?? die('usage: rkeychat control limit AGENT N'); payload.n = Number(b ?? 0) }
    else if ((action === 'pause' || action === 'resume') && a) payload.agent = a
    console.log(fmt({ ...(await api('POST', '/api/control', payload)), name: 'you' }))
    break
  }
  case 'files': {
    const list = await api('GET', '/api/files' + q({ room: opt.room }))
    if (!list.length) { console.log('no files shared here yet'); break }
    for (const f of list) console.log(`${f.hash.slice(0, 12)}  ${String(f.size).padStart(11)}  ${f.local ? 'here   ' : `${f.providers} online`}  ${f.name}  (${f.by})`)
    break
  }
  case 'get': {
    // fetch a shared file by (a prefix of) its root; prints the local path
    const root = pos[0] ?? die('usage: rkeychat get --room ROOM ROOT')
    const out = await api('POST', '/api/fetch', { room: opt.room, root })
    console.log(out.path)
    break
  }
  case 'identity': {
    // who this device's participants are: account (root) and session key. `identity new NAME` re-mints NAME.
    const cfg = cfgOrDie()
    if (pos[0] === 'new') {
      const name = pos[1] ?? die('usage: rkeychat identity new NAME')
      const before = cfg.participants[name]?.ref
      const { account, session } = newIdentity(cfg, name); saveConfig(cfg)
      console.log(`new identity for @${name}\n  account: ${account}\n  session: ${session}\n  previous session: ${before} (kept; it keeps signing in every room until the new key is approved there)`)
      if (cfg.rooms.length) console.log(`rooms to re-enter with the new keys: ${cfg.rooms.map((r) => r.name).join(', ')}\n  for each: restart the daemon, rkeychat request --room ROOM > req.txt, the owner approves it; nothing to revoke unless you want the old key gone.`)
      break
    }
    for (const [name, p] of Object.entries(cfg.participants)) {
      const acct = accountSigner(cfg, name)
      console.log(`@${name} (${p.role})\n  account: ${acct ? acct.ref : '(none yet: rkeychat identity new ' + name + ')'}\n  session: ${p.ref}`)
    }
    break
  }
  case 'debug': {
    // rkeychat debug agent NAME: why the daemon would or wouldn't wake it, per room
    if (pos[0] !== 'agent' || !pos[1]) die('usage: rkeychat debug agent NAME')
    for (const r of await api('GET', '/api/debug/agent' + q({ name: pos[1] }))) {
      if (!r.hosted) { console.log(`${r.room}: ${pos[1]} isn't hosted on this device`); continue }
      console.log(`${r.room}: ${r.reason}\n  bridge ${r.bridge} · busy ${r.busy} · listeners ${r.listeners} · state ${r.state ?? 'idle'}${r.key ? ` · key ${r.key.slice(0, 24)}…` : ''}${r.triggers.length ? '\n  ' + r.triggers.map((t) => `${t.from}: ${t.text}`).join('\n  ') : ''}`)
    }
    break
  }
  case 'purpose': {
    // the room's standing prompt for agents, plus who answers first
    const text = pos.join(' ')
    if (!text && !opt.order) {
      const c = (await api('GET', '/api/state' + q({ room: opt.room }))).current?.charter
      console.log(c?.text ? c.text : '(no purpose set)'); if (c?.order?.length) console.log(`order: ${c.order.join(' → ')}`)
      break
    }
    const cur = (await api('GET', '/api/state' + q({ room: opt.room }))).current?.charter ?? {}
    await api('POST', '/api/control', { room: opt.room, action: 'charter', text: text || cur.text || '', order: opt.order ? String(opt.order).split(',').map((x) => x.trim()).filter(Boolean) : cur.order })
    console.log('purpose set; every agent gets it with its next turn')
    break
  }
  case 'rename': {
    const name = pos[0] ?? die('usage: rkeychat rename --room ROOM NEW-NAME')
    await api('POST', '/api/control', { room: opt.room, action: 'rename', name })
    console.log(`renamed to "${name}"`)
    break
  }
  case 'status': {
    const s = await api('GET', '/api/state' + q({ room: opt.room }))
    const c = s.current
    if (c && c.admitted && c.participants.some((p) => p.status === 'active' && !p.local) && c.connections === 0) console.log('DEAF: no live connections to anyone in this room (people may show online from stale state)')
    if (!c) { console.log(`device ${s.device.name}, no rooms yet`); break }
    const b = c.budget
    console.log(`room ${c.name}${c.owner ? ' (owner)' : ''}${c.admitted ? '' : ' — waiting for approval'}   [${s.rooms.map((r) => r.name).join(', ')}]`)
    console.log(`agents: ${b.paused ? 'PAUSED' : b.unlimited ? 'no round limit' : b.until && b.until > Date.now() ? 'open until ' + new Date(b.until).toLocaleTimeString() : `${b.remaining} of ${b.limit} rounds left`}`)
    for (const p of c.participants) {
      const extra = [b.agents.paused.includes(p.name) && 'paused', b.agents.limits[p.name] && `limit ${b.agents.limits[p.name]}`].filter(Boolean).join(', ')
      console.log(`  @${p.name.padEnd(14)} ${p.role.padEnd(6)} ${p.status.padEnd(8)} ${p.online ? 'online ' : 'offline'} ${p.state}${p.local ? ' (here)' : ''}${extra ? ` [${extra}]` : ''}`)
    }
    break
  }
  case 'log': {
    const s = await api('GET', '/api/state' + q({ room: opt.room }))
    for (const r of (s.current?.log ?? []).slice(-(Number(pos[0]) || 30))) console.log(fmt(r))
    break
  }
  case 'react': {
    const [a, b] = pos
    const [target, emoji] = b ? [a, b] : ['last', a]
    const r = await api('POST', '/api/react', { room: opt.room, as: opt.as, target, emoji, on: !opt.off })
    console.log(`${r.name} ${opt.off ? 'removed' : 'reacted'} ${r.emoji}`)
    break
  }
  case 'activity': {
    // made for hooks: never fails loudly, never blocks for long
    try {
      await fetch(base() + '/api/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: opt.room, as: opt.as, text: pos.join(' ') }), signal: AbortSignal.timeout(1500) })
    } catch {}
    break
  }
  case 'models': {
    const { installModel, MODELS, sttAvailable } = await import('../src/stt.js')
    if (pos[0] === 'install') await installModel(pos[1] ?? 'parakeet-v3')
    else console.log(`${sttAvailable() ? 'installed' : 'no model yet: rkeychat models install'}\n${MODELS.map((m) => `  ${m.id}  ${m.size}  ${m.credit}`).join('\n')}`)
    break
  }
  case 'glossary': {
    const [sub, from, to] = pos
    if (sub === 'add') await api('POST', '/api/glossary', { from, to })
    else if (sub === 'rm') await api('POST', '/api/glossary', { from, remove: true })
    const g = await api('GET', '/api/glossary')
    for (const [k, v] of Object.entries(g).sort()) console.log(`${k.padEnd(18)} → ${v}`)
    break
  }
  case 'readopt': { const r = await api('POST', '/api/readopt', { room: opt.room, ref: pos[0] ?? die('usage: rkeychat readopt --room ROOM KEYPREFIX') }); console.log(`re-adopted (${r.appended} entries)`); break }
  case 'ban': { const r = await api('POST', '/api/revoke', { room: opt.room, name: pos[0], ref: opt.key, reason: 'banned' }); console.log(`banned ${(r.revoked ?? []).map((x) => x.slice(0, 20)).join(', ') || pos[0]} (only you can lift it: rkeychat unban)`); break }
  case 'unban': { const r = await api('POST', '/api/unban', { room: opt.room, ref: pos[0] ?? die('usage: rkeychat unban --room ROOM KEYPREFIX') }); console.log(`ban lifted on ${r.unbanned.slice(0, 20)}; they come back through a fresh invite`); break }
  case 'revoke': { const r = await api('POST', '/api/revoke', { room: opt.room, name: pos[0], ref: opt.key }); console.log(`revoked ${(r.revoked ?? []).map((x) => x.slice(0, 20)).join(', ') || pos[0]}`); break }
  case 'wait': {
    // Stays up across daemon restarts: reconnects quietly and says so once.
    const as = opt.as ?? die('usage: rkeychat wait --as NAME')
    let announced = false
    for (;;) {
      try {
        const res = await fetch(`${base()}/api/wait${q({ as, room: opt.room })}`)
        if (!res.ok) die((await res.json()).error)
        let buf = ''
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString()
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1)
            const ev = JSON.parse(line)
            if (ev.type === 'ready' && !announced) { console.log(`[rkeychat] listening as @${ev.name} (streams forever: in Claude Code run this under the Monitor tool, not as a plain command)`); announced = true }
            if (ev.type === 'turn') {
              console.log(`=== rkeychat turn for @${ev.name} in "${ev.room}" — reply: rkeychat send --room "${ev.room}" --as ${ev.name} "..."  (or --pass) ===`)
              console.log(ev.prompt)
              console.log('=== end turn ===')
            }
          }
        }
      } catch {}
      if (announced) { console.log('[rkeychat] daemon went away, reconnecting…'); announced = false }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  default:
    console.log(USAGE)
}
