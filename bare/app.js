// The phone app's backend: runs inside the iOS/Android app as a Bare worklet.
// argv[0] = the app's private documents folder, argv[1] = your name on this device.
// It serves the same web UI the desktop app does on 127.0.0.1, and the native
// shell shows it in a WebView.
import './globals.js'
import fs from 'fs'
import path from 'path'
import assets from './assets.js'

// inside the app argv is just our args; from the command line it starts with bare and the script
const args = typeof BareKit !== 'undefined' ? Bare.argv : Bare.argv.slice(2)
const docs = String(args[0] ?? '').trim()
if (!docs) throw new Error('the app must pass its documents folder')
const name = String(args[1] ?? 'me').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'me'
// the iOS simulator shares the Mac's network, where the desktop app owns 4455: pick another port there
const sim = /CoreSimulator/.test(docs)
const PORT = Number(args[2]) || (sim ? 24455 : 4455)

// boot markers: when the app dies before it can talk, this file says how far it got
const bootLog = path.join(docs, 'boot.log')
const mark = (m) => { try { fs.appendFileSync(bootLog, `${new Date().toISOString()} ${m}\n`) } catch {} }
try { Bare.on('uncaughtException', (e) => mark(`UNCAUGHT ${e?.stack ?? e}`)); Bare.on('unhandledRejection', (e) => mark(`UNHANDLED ${e?.stack ?? e}`)) } catch (e) { mark('no Bare.on: ' + e?.message) }
try { process.on('uncaughtException', (e) => mark(`P-UNCAUGHT ${e?.stack ?? e}`)); process.on('unhandledRejection', (e) => mark(`P-UNHANDLED ${e?.stack ?? e}`)) } catch (e) { mark('no process.on: ' + e?.message) }
// everything the daemon prints lands in the boot log too (the system log isn't readable from the Mac over the cable)
for (const k of ['log', 'error', 'warn']) { const orig = console[k].bind(console); console[k] = (...a) => { mark(`[${k}] ` + a.map((x) => typeof x === 'string' ? x : (x?.stack ?? JSON.stringify(x))).join(' ').slice(0, 2000)); orig(...a) } }
process.env.RKEYCHAT_DEBUG = '1'
mark(`start docs=${docs} name=${name} sim=${sim} port=${PORT}`)
const data = path.join(docs, 'rkeychat')
const assetDir = path.join(docs, 'assets')
process.env.RKEYCHAT_DATA = data
process.env.DEFAULT_ACCOUNT_DIR = path.join(docs, 'pearcore')
process.env.HOME ??= docs

// write out what the code reads from disk
const write = (rel, text) => { const p = path.join(assetDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
write('ui/index.html', assets.ui)
if (assets.jsqr) write('ui/jsQR.js', assets.jsqr)
for (const [rel, text] of Object.entries(assets.migrations)) write(path.join('migrations', rel), text)
process.env.RKEYCHAT_UI = path.join(assetDir, 'ui', 'index.html')
process.env.PEARCORE_MIGRATIONS_PATH = path.join(assetDir, 'migrations')
mark('assets written')

const ipc = typeof BareKit !== 'undefined' ? BareKit.IPC : null
const tell = (msg) => { try { ipc?.write(Buffer.from(JSON.stringify(msg) + '\n')) } catch {} ; console.log('[rkeychat]', JSON.stringify(msg)) }

try {
  mark('loading config')
  const { loadConfig, newConfig, addParticipant, saveConfig } = await import('./core/config.js')
  const existing = loadConfig()
  if (existing && existing.port !== PORT) { existing.port = PORT; saveConfig(existing) }
  if (!existing) {
    const cfg = newConfig({ name: `${name}-phone`, port: PORT })
    addParticipant(cfg, name, { role: 'human' })
    saveConfig(cfg)
    tell({ event: 'created', device: cfg.deviceName, human: name })
  }
  mark('config ok; importing daemon')
  const { runDaemon } = await import('./core/daemon.js')
  mark('daemon imported; starting')
  await runDaemon({})
  mark('daemon up')
  tell({ event: 'ready', url: `http://127.0.0.1:${loadConfig().port}` })
} catch (err) {
  mark(`ERROR ${err?.stack ?? err}`)
  tell({ event: 'error', message: String(err?.stack ?? err) })
}
