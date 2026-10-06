#!/usr/bin/env node
// A picture of the running UI, so a change to it can be looked at instead of reasoned about.
//
//   node scripts/shot.mjs out.png                      the app as it opens
//   node scripts/shot.mjs out.png --run "openPage('room')"   after doing something
//   node scripts/shot.mjs out.png --clip ".order-list"       just that element
//   node scripts/shot.mjs out.png --w 420                    phone width
//
// Headless Chrome over the DevTools protocol, pointed at the daemon on 127.0.0.1.
// Nothing is installed and nothing is left running.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1] }
const out = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? 'shot.png'
const url = flag('url', 'http://127.0.0.1:4455/')
const run = flag('run', '')
const clip = flag('clip', '')
const width = Number(flag('w', 1280))
const height = Number(flag('h', 900))
const settle = Number(flag('settle', 1500))

const profile = mkdtempSync(join(tmpdir(), 'rkshot-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--force-device-scale-factor=2', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never reported a debugger address')), 15_000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/\S+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
  chrome.on('exit', (code) => { clearTimeout(t); reject(new Error(`Chrome exited (${code})`)) })
})

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
const sessions = new Map()
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
  if (m.method === 'Target.attachedToTarget') sessions.set(m.params.targetInfo.targetId, m.params.sessionId)
})
await new Promise((r) => ws.on('open', r))
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const n = ++id
  pending.set(n, { resolve, reject })
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const page = (method, params) => send(method, params, sessionId)

await page('Page.enable')
await page('Runtime.enable')
const errors = []
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
})
await page('Page.navigate', { url })
await new Promise((r) => setTimeout(r, settle))
if (run) {
  const r = await page('Runtime.evaluate', { expression: run, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`--run threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  await new Promise((r2) => setTimeout(r2, 600))
}

let params = { format: 'png', captureBeyondViewport: true }
if (clip) {
  const r = await page('Runtime.evaluate', {
    expression: `(() => { const e = document.querySelector(${JSON.stringify(clip)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()`,
    returnByValue: true
  })
  if (!r.result.value) throw new Error(`nothing matches ${clip}`)
  params.clip = { ...r.result.value, scale: 2 }
}
const { data } = await page('Page.captureScreenshot', params)
writeFileSync(out, Buffer.from(data, 'base64'))

ws.close(); chrome.kill()
try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch {} // Chrome may still be letting go of its profile
console.log(`${out}${clip ? ` (${clip})` : ''}`)
if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].join('\n  '))
