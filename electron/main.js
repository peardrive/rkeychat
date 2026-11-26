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
import { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdirSync, writeFileSync, createWriteStream, statSync, rmSync } from 'node:fs'
import { loadConfig, migrate, newConfig, addParticipant, saveConfig, dataDir } from '../src/config.js'
// the swap and the way back are pearkit's (pearkit/electron), the same for every Anjou desktop app
import { installUpdate, installedAt, previousAt, revertUpdate } from 'pearkit/electron'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
let win = null
let port = 4455
let owned = null // { kind: 'inproc', stop } | { kind: 'child', proc } — a daemon this app started
let quitting = false

const origin = () => `http://127.0.0.1:${port}`
const UPDATES_DIR = () => path.join(dataDir(), 'updates')
const RUNNING_VERSION = () => { try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { return '' } }
// which page the window opens: the projects shell at /app/ (default since 2026-11-24, the first build handed to
// someone else) or the classic room page at / (`RKEYCHAT_SHELL=room` or `--room`)
const SHELL = process.argv.includes('--room') || process.env.RKEYCHAT_SHELL === 'room' ? 'room' : 'app'

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

// `setup`: no config on this device yet. The window opens on electron/first-run.html, which
// asks for the person's name; `rkc.setup(name)` (below) writes the config, boots the daemon
// and then loads the room into the same window. Nobody installing the app has a terminal.
function createWindow ({ setup = false } = {}) {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 360, // narrow enough to be a phone: below 721 px the page takes its phone layout
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
  if (setup) win.loadFile(path.join(HERE, 'first-run.html'))
  else win.loadURL(origin() + (SHELL === 'app' ? '/app/' : ''))
  // sharelinks and web URLs belong in the system browser, not in new rKeyChat windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin()) && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url) }
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
  // the page asks this when a debug note or dictation gets no microphone, so it can say whether macOS is the one blocking
  ipcMain.handle('mic-status', () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown'))
  // projects: a native folder picker and "open in Finder" for the new shell
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose the project folder' })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('open-folder', (e, p) => { if (typeof p === 'string' && p.startsWith('/')) { shell.openPath(p); return true } return false })
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone')
      .then((granted) => { if (!granted) console.warn('[desktop] macOS denied the microphone: System Settings → Privacy & Security → Microphone') })
      .catch((err) => console.warn('[desktop] microphone access check failed:', err?.message))
  }
}

// 2: boot the daemon here. A native module built for plain Node throws on import with
// NODE_MODULE_VERSION in the message — that is the signal to fall back to 3.
// The installed app runs the daemon inside itself, and its console went nowhere: what the engine said about a file
// a phone could not fetch was lost (2026-11-25). Everything it prints also goes to ~/.rkeychat/daemon.log, the file
// `rkeychat start --background` writes, with a stamp, so the two read the same.
function teeDaemonLog () {
  try {
    mkdirSync(dataDir(), { recursive: true })
    const out = createWriteStream(path.join(dataDir(), 'daemon.log'), { flags: 'a' })
    const wrap = (orig) => (...args) => {
      orig(...args)
      try { out.write(`${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(' ')}\n`) } catch {}
    }
    console.log = wrap(console.log.bind(console)); console.error = wrap(console.error.bind(console)); console.warn = wrap(console.warn.bind(console))
    console.log(`[desktop] rKeyChat ${RUNNING_VERSION()} started; the daemon runs in-process`)
  } catch (err) { console.warn('[desktop] no daemon.log:', err.message) }
}

async function bootInProcess (cfg) {
  teeDaemonLog()
  const { bootDaemon } = await import('../src/daemon.js')
  const d = await bootDaemon()
  owned = { kind: 'inproc', stop: d.stop }
  // one build kept (~/Anjou/_publishing/disk.md): the copy the last update replaced is the way back from a build that
  // does not start; once this one has been starting for three days it goes (1 GB)
  try {
    const prev = previousAt(installedAt(), process.platform, UPDATES_DIR())
    if (prev && Date.now() - statSync(prev).mtimeMs > 3 * 864e5) { rmSync(prev, { recursive: true, force: true }); console.log('[updates] removed the previous version kept for the way back') }
  } catch {}
  // in-app updates (src/updates.js): the daemon fetched and checked the new build; put it in place and relaunch.
  // The previous bundle is kept under ~/.rkeychat/updates/previous.noindex (out of Spotlight's sight), the new
  // build is asked to load its native modules first, and a build that cannot is refused, not installed.
  d.app.on('update-install', ({ path: file, version, resolve, reject }) => {
    installUpdate({ file, version, identifier: 'com.rkeychat.app', keepDir: UPDATES_DIR(), preflightModules: ['better-sqlite3', 'sodium-native'] })
      .then(() => { resolve(); quitting = true; setTimeout(() => app.quit(), 500) })
      .catch((err) => { console.error('[updates] install:', err.message); reject(err) })
  })
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

// First run: the name typed into first-run.html becomes this device's config, the same
// thing `rkeychat init --human NAME` writes. Port from RKEYCHAT_PORT when set (a second
// copy on one machine, tests), else the default.
function firstRun (name) {
  if (loadConfig()) throw new Error('this device is already set up')
  const cfg = newConfig({ port: Number(process.env.RKEYCHAT_PORT) || undefined })
  addParticipant(cfg, name, { role: 'human' }) // validates the name
  saveConfig(cfg)
  console.log(`rkeychat (desktop) set up device "${cfg.deviceName}" with @${name}`)
}

// true: a daemon is there (attached or started); 'setup': no config yet, show first-run.html;
// false: could not start, the person has been told and the app is quitting.
async function ensureDaemon () {
  const loaded = loadConfig()
  if (!loaded) return 'setup'
  const cfg = migrate(loaded)
  port = cfg.port || 4455
  if (await daemonUp()) { console.log(`rkeychat (desktop) attached to the running daemon → ${origin()}`); return true }
  try {
    await bootInProcess(cfg)
    return true
  } catch (err) {
    const abi = /NODE_MODULE_VERSION|compiled against a different Node\.js version|not a valid Win32 application|dlopen/.test(String(err?.message))
    if (!abi) {
      // the daemon itself refused (no rooms, bad config, port taken by something else): say what it said. When this
      // copy came in through an update and the previous one is still kept, offer the way back (pearkit revertUpdate).
      const prev = previousAt(installedAt(), process.platform, UPDATES_DIR())
      if (prev) {
        const choice = dialog.showMessageBoxSync({ type: 'error', title: 'rKeyChat could not start', message: 'rKeyChat could not start', detail: `${String(err?.message || err)}\n\nThe version you had before is still here.`, buttons: ['Go back to the previous version', 'Quit'], defaultId: 0, cancelId: 1 })
        if (choice === 0) {
          try { mkdirSync(UPDATES_DIR(), { recursive: true }); writeFileSync(path.join(UPDATES_DIR(), 'failed-start.json'), JSON.stringify({ version: RUNNING_VERSION(), reason: String(err?.message || err).slice(0, 400), at: Date.now() })) } catch {}
          try { await revertUpdate({ keepDir: UPDATES_DIR() }); quitting = true; app.quit(); return false } catch (e) { console.error('[updates] going back:', e.message) }
        }
      } else dialog.showErrorBox('rKeyChat could not start', String(err?.stack || err))
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

  // first-run.html → rkc.setup(name): write the config, start the daemon, show the room
  ipcMain.handle('first-run', async (e, name) => {
    firstRun(String(name ?? ''))
    const up = await ensureDaemon()
    if (up !== true) throw new Error('the daemon could not start; see the terminal or the log')
    if (win) win.loadURL(origin() + (SHELL === 'app' ? '/app/?welcome=1' : '')) // the shell carries on with its own first-run steps, counted after this one
  })

  app.whenReady().then(async () => {
    allowMicrophone()
    const up = await ensureDaemon()
    if (up === 'setup') createWindow({ setup: true })
    else if (up) createWindow()
  })

  app.on('activate', async () => {
    if (win) return
    if (await daemonUp()) return createWindow()
    const up = await ensureDaemon()
    if (up === 'setup') createWindow({ setup: true })
    else if (up) createWindow()
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
