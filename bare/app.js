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
const PORT = Number(args[2]) || 4455 // argv[2]: only for testing on a Mac that already runs rKeyChat

const data = path.join(docs, 'rkeychat')
const assetDir = path.join(docs, 'assets')
process.env.RKEYCHAT_DATA = data
process.env.DEFAULT_ACCOUNT_DIR = path.join(docs, 'pearcore')
process.env.HOME ??= docs

// write out what the code reads from disk
const write = (rel, text) => { const p = path.join(assetDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
write('ui/index.html', assets.ui)
for (const [rel, text] of Object.entries(assets.migrations)) write(path.join('migrations', rel), text)
process.env.RKEYCHAT_UI = path.join(assetDir, 'ui', 'index.html')
process.env.PEARCORE_MIGRATIONS_PATH = path.join(assetDir, 'migrations')

const ipc = typeof BareKit !== 'undefined' ? BareKit.IPC : null
const tell = (msg) => { try { ipc?.write(Buffer.from(JSON.stringify(msg) + '\n')) } catch {} ; console.log('[rkeychat]', JSON.stringify(msg)) }

try {
  const { loadConfig, newConfig, addParticipant, saveConfig } = await import('./core/config.js')
  if (!loadConfig()) {
    const cfg = newConfig({ name: `${name}-phone`, port: PORT })
    addParticipant(cfg, name, { role: 'human' })
    saveConfig(cfg)
    tell({ event: 'created', device: cfg.deviceName, human: name })
  }
  const { runDaemon } = await import('./core/daemon.js')
  await runDaemon({})
  tell({ event: 'ready', url: `http://127.0.0.1:${loadConfig().port}` })
} catch (err) {
  tell({ event: 'error', message: String(err?.stack ?? err) })
}
