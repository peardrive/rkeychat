// Which version of rKeyChat is RUNNING, from where, and which was last INSTALLED on this machine.
//
//   running   package.json's version; the build counter and commit from src/build.json, which scripts/ship-app.sh
//             writes at build time (git-ignored: a source tree has none and says so); where this copy lives (the
//             installed .app, an AppImage, or the source folder)
//   installed the machine ledger ~/.anjou/versions.json, one entry per app id, written only by ship scripts
//             (~/Anjou/_deliveries/AGENTS.md §7); each app reads its own entry to say "Installed … beside Running …"
//
// The app id is `rkeychat-desktop`, the name of the deliveries folder and of every installer (AGENTS.md §1, §2).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_ID = 'rkeychat-desktop'
export const APP_NAME = 'rKeyChat'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = () => process.env.HOME || process.env.USERPROFILE || ''
export const LEDGER = () => join(home(), '.anjou', 'versions.json')

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// { build: 'YYYY-MM-DD.N', commit: '7 hex' } from the ship, or nulls in a source tree
export function buildInfo (root = ROOT) {
  const b = readJson(join(root, 'src', 'build.json'))
  return { build: typeof b?.build === 'string' ? b.build : null, commit: typeof b?.commit === 'string' ? b.commit : null }
}

export function runningInfo (root = ROOT) {
  const pkg = readJson(join(root, 'package.json'))
  const { build, commit } = buildInfo(root)
  const m = root.match(/^(.*?\.app)\/Contents\//)
  const appImage = process.env.APPIMAGE || null
  return {
    version: pkg?.version ?? '0.0.0',
    build,
    commit,
    // the .app bundle, the AppImage, or the source folder this copy runs from
    from: m ? m[1] : appImage || root,
    source: !m && !appImage,
    desktop: !!process.versions?.electron
  }
}

// This machine's ledger entry for rKeyChat, or null when nothing was ever shipped here.
export function installedInfo () {
  const l = readJson(LEDGER())
  const e = l?.[APP_ID] ?? l?.rkeychat ?? null
  return e && typeof e === 'object' ? e : null
}

const seq = (b) => Number(String(b || '').split('.').pop()) || 0

// running, installed, and whether the running copy is behind what was installed here (a source tree started
// after a newer ship, or an old copy opened by hand)
export function versionInfo (root = ROOT) {
  const running = runningInfo(root)
  const installed = installedInfo()
  const behind = !!installed && (installed.version !== running.version || seq(installed.build) > seq(running.build)) && running.source
  return { app: APP_ID, running, installed, behind }
}
