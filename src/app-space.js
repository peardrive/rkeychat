// What a space says about the app that made it: the manifest `.pearmeta/app.json` and the app's icon beside
// it, written by the space owner into every space rKeyChat makes. The standard every app follows is
// ~/Anjou/_documents/wiki/app-spaces-standard.md: PearDrive files the space under the app by it (and, until it
// reads manifests, by the space's name), shows the icon, and lets a person pin the space to the sidebar.
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from './config.js'

export const APP_ID = 'rkeychat'
export const APP_NAME = 'rKeyChat'
export const KINDS = ['main', 'debug-notes', 'updates', 'project', 'chat', 'attached']

// the icon: 128×128 PNG. On the phone the bundle carries it and writes it out (RKEYCHAT_ICON).
export const iconPath = () => process.env.RKEYCHAT_ICON || join(dirname(fileURLToPath(import.meta.url)), 'assets', 'app-icon.png')

// The manifest for one space, as JSON. `home` names a device, never a folder.
export function manifest ({ kind, name, home = null, main = null, extra = {} }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  return {
    v: 1,
    app: APP_ID,
    appName: APP_NAME,
    kind,
    name: String(name ?? '').slice(0, 120),
    icon: existsSync(iconPath()) ? '.pearmeta/app-icon.png' : undefined,
    main: main ?? undefined,
    home: home ? { device: String(home.device), name: String(home.name ?? '') } : undefined,
    written: new Date().toISOString(),
    ...extra
  }
}

// Write the manifest (and the icon) into a space: on disk under the data folder, then registered with pearcore
// so every member syncs them. Re-registering an unchanged file is harmless; a changed manifest is a new version.
export async function writeManifest (core, space, fields) {
  const dir = join(dataDir(), 'pearmeta', String(space.topicHash).slice(0, 16))
  mkdirSync(dir, { recursive: true })
  const m = manifest(fields)
  const files = [['app.json', JSON.stringify(m, null, 2)]]
  writeFileSync(join(dir, 'app.json'), files[0][1])
  const icon = iconPath()
  if (existsSync(icon)) { copyFileSync(icon, join(dir, 'app-icon.png')); files.push(['app-icon.png', null]) }
  const drive = core.drives.get(space)
  for (const [name] of files) {
    const entry = await drive.addFile(`.pearmeta/${name}`, join(dir, name))
    await new Promise((resolve, reject) => { entry.onError(reject); entry.onComplete(resolve) })
  }
  return m
}

// Read the manifest a space carries, from the owner's copy when there is one: { ...manifest } or null.
// (For another app's space, or ours from another device.)
export async function readManifest (core, space, { owner = null } = {}) {
  const list = await core.managers.spaceFileList.get(space.topicHash).catch(() => null)
  const versions = list?.['/.pearmeta/app.json']
  if (!versions) return null
  const hashes = Object.keys(versions)
  const chosen = (owner && hashes.find((h) => Object.keys(versions[h].peers ?? {}).includes(owner))) ?? hashes[0]
  const dest = join(dataDir(), 'pearmeta', 'read', String(space.topicHash).slice(0, 16), 'app.json')
  mkdirSync(dirname(dest), { recursive: true })
  const e = await core.drives.get(space).getFile('.pearmeta/app.json')
  const task = await e.download(chosen, dest)
  await new Promise((resolve, reject) => { task.onError?.(reject); task.onComplete(resolve) })
  try { return JSON.parse(readFileSync(dest, 'utf8')) } catch { return null }
}
