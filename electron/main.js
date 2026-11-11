/**
 * rKeyChat desktop — the daemon and its UI in a window of their own.
 *
 * Same shape as PearDrive's electron/main.js: nothing forks, the web UI is the page
 * src/ui/index.html served by src/server.js, and the window is a view on
 * http://127.0.0.1:<port>. Three ways the daemon can be there, tried in order:
 *
 *   1. one is already running (`rkeychat start` in a terminal, or a second copy of
 *      this app) — attach to it. Closing the window never touches it. This is the
 *      everyday case on the MacBook, where Claude's `rkeychat wait` depends on the
 *      daemon staying up whatever the window does.
 *   2. none is running — boot it inside this process (src/daemon.js bootDaemon). The
 *      packaged app does this; native modules were rebuilt for Electron's Node ABI
 *      by scripts/build-app.sh.
 *   3. the in-process boot fails on a native module compiled for plain Node (the dev
 *      tree, `npm run app` without a rebuild) — spawn `node bin/rkeychat.js start` as
 *      a child instead and attach to that. The child is stopped with the app.
 *
 * On macOS closing the window leaves rKeyChat in the dock, daemon still up; the dock
 * icon reopens it. Quit stops a daemon this process owns (2 or 3), never one it only
 * attached to (1).
 */
import { app, BrowserWindow, dialog, session, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, migrate, dataDir } from '../src/config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
let win = null
let port = 4455
let owned = null // { kind: 'inproc', stop } | { kind: 'child', proc } — a daemon this app started
let quitting = false

const origin = () => `http://127.0.0.1:${port}`

async function daemonUp (timeoutMs = 800) {
  try { return (await fetch(`${origin()}/api/rooms`, { signal: AbortSignal.timeout(timeoutMs) })).ok } catch { return false }
}

async function waitForDaemon (ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await daemonUp()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

function createWindow () {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    title: 'rKeyChat',
    backgroundColor: '#0f1115', // close to the UI's own background: no white flash
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows/Linux: no File · Edit · View · Window bar over the app. Alt still shows it, and its shortcuts
    // (Ctrl+R to reload, zoom, dev tools) keep working. (macOS keeps its menu in the screen's top bar.)
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(HERE, 'preload.cjs')
    }
  })
  win.loadURL(origin())
  // sharelinks and web URLs belong in the system browser, not in new rKeyChat windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin())) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url) }
  })
  win.on('closed', () => { win = null })
}

// The UI records dictation and debug notes through getUserMedia. In a browser the page asks;
// in the app the request comes to us, and the only origin that ever asks is our own daemon.
// Copy buttons use navigator.clipboard.writeText, which Chromium gates behind
// 'clipboard-sanitized-write' — denied by the first cut of this handler, which is why
// "Copy the notes link" copied nothing on Oct 28. Everything the page needs is listed.
const ALLOWED = new Set(['media', 'microphone', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen'])
function allowMicrophone () {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ours = (details?.requestingUrl || wc.getURL() || '').startsWith(origin())
    const ok = ours && ALLOWED.has(permission)
    if (!ok) console.warn(`[desktop] denied permission "${permission}" for ${details?.requestingUrl || wc.getURL()}`)
    cb(ok)
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    String(requestingOrigin || '').startsWith(origin()) && ALLOWED.has(permission))
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone')
      .then((granted) => { if (!granted) console.warn('[desktop] macOS denied the microphone: System Settings → Privacy & Security → Microphone') })
      .catch((err) => console.warn('[desktop] microphone access check failed:', err?.message))
  }
}

// 2: boot the daemon here. A native module built for plain Node throws on import with
// NODE_MODULE_VERSION in the message — that is the signal to fall back to 3.
async function bootInProcess (cfg) {
  const { bootDaemon } = await import('../src/daemon.js')
  const d = await bootDaemon()
  owned = { kind: 'inproc', stop: d.stop }
  console.log(`rkeychat ${cfg.deviceName} (desktop, in-process) → ${origin()}`)
}

// 3: the dev tree. Plain `node` runs the daemon exactly as `rkeychat start` would.
async function bootChild (cfg) {
  const proc = spawn('node', [path.join(ROOT, 'bin', 'rkeychat.js'), 'start'], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  })
  owned = { kind: 'child', proc }
  proc.on('exit', (code) => {
    if (owned?.kind === 'child' && owned.proc === proc) owned = null
    if (!quitting) console.error(`[desktop] the daemon exited (${code}); reopen the window to start it again`)
  })
  if (!(await waitForDaemon(20000))) throw new Error('the daemon did not come up on ' + origin() + ' (see this terminal for its log)')
  console.log(`rkeychat ${cfg.deviceName} (desktop, child node) → ${origin()}`)
}

async function ensureDaemon () {
  const loaded = loadConfig()
  if (!loaded) {
    dialog.showErrorBox('rKeyChat is not set up on this device', `No config in ${dataDir()}.\n\nIn a terminal, run:\n  rkeychat init --human <your name>\n  rkeychat add claude\nthen open rKeyChat again.`)
    app.quit()
    return false
  }
  const cfg = migrate(loaded)
  port = cfg.port || 4455
  if (await daemonUp()) { console.log(`rkeychat (desktop) attached to the running daemon → ${origin()}`); return true }
  try {
    await bootInProcess(cfg)
    return true
  } catch (err) {
    const abi = /NODE_MODULE_VERSION|compiled against a different Node\.js version|not a valid Win32 application|dlopen/.test(String(err?.message))
    if (!abi) {
      // the daemon itself refused (no rooms, bad config, port taken by something else): say what it said
      dialog.showErrorBox('rKeyChat could not start', String(err?.stack || err))
      app.quit()
      return false
    }
    console.warn('[desktop] native modules are built for plain Node; running the daemon under node instead:', err.message.split('\n')[0])
  }
  try {
    await bootChild(cfg)
    return true
  } catch (err) {
    dialog.showErrorBox('rKeyChat could not start', `${err.message}\n\nStart it in a terminal with: rkeychat start --background`)
    app.quit()
    return false
  }
}

async function stopOwned () {
  if (!owned) return
  const o = owned; owned = null
  if (o.kind === 'inproc') await Promise.resolve(o.stop()).catch(() => {})
  else if (o.kind === 'child') {
    o.proc.kill('SIGTERM')
    await new Promise((r) => { o.proc.once('exit', r); setTimeout(r, 2500) })
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() } else createWindow()
  })

  app.whenReady().then(async () => {
    allowMicrophone()
    if (await ensureDaemon()) createWindow()
  })

  app.on('activate', async () => {
    if (win) return
    if (await daemonUp()) createWindow()
    else if (await ensureDaemon()) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Quit stops only a daemon this process started, capped so a hung swarm can't wedge
  // the app in the dock; a daemon we merely attached to keeps running for the agents.
  let stopping = false
  app.on('before-quit', (e) => {
    quitting = true
    if (stopping || !owned) return
    e.preventDefault(); stopping = true
    Promise.race([stopOwned(), new Promise((r) => setTimeout(r, 3000))]).finally(() => app.quit())
  })
}
