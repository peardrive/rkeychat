// Dictation fixes: what the transcriber writes → what Guy means. Applied to
// dictated messages before they're signed and sent, whole phrases only, case
// insensitive. It grows as we notice mishearings (GUI, or `rkeychat glossary add`).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './config.js'

const path = () => join(dataDir(), 'glossary.json')

export const SEED = {
  'pair core': 'pearcore', paircore: 'pearcore', 'para core': 'pearcore', paracore: 'pearcore', 'pear core': 'pearcore',
  'pair drive': 'PearDrive', pairdrive: 'PearDrive', 'para drive': 'PearDrive', paradrive: 'PearDrive', 'pear drive': 'PearDrive', 'peer drive': 'PearDrive',
  'pair cast': 'Pearcast', paracast: 'Pearcast', 'pair sync': 'PearSync',
  'hyper-v': 'Hyperbee', 'hyper v': 'Hyperbee', 'hyper-b': 'Hyperbee', 'hyper b': 'Hyperbee',
  noster: 'Nostr', kimmy: 'Kimi', 'r key chat': 'rKeyChat', 'arky chat': 'rKeyChat', 'our key chat': 'rKeyChat', 'r key': 'rKey', 'arky': 'rKey',
  herms: 'Hermes', 'sato chip': 'Satochip', 'tap signer': 'Tapsigner', anju: 'Anjou', 'white noise': 'White Noise'
}

// Settings live beside the glossary: { autofix: true }.
const settingsPath = () => join(dataDir(), 'settings.json')
export function loadSettings () {
  try { return { autofix: true, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) } } catch { return { autofix: true } }
}
export function saveSettings (patch) {
  const next = { ...loadSettings(), ...patch }
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  return next
}

// Learning from corrections: when someone dictates and then retypes a short
// phrase before sending, the transcriber's version → theirs becomes a fix.
// Guards keep noise out: 1–3 words each side, not just case or punctuation,
// and nothing that would rewrite common words.
const COMMON = new Set('a an the and or but to of in on at for with from by is are was were be been it this that i you he she we they my your our me us them not no yes so if as do did done have has had can could will would should just like'.split(' '))
export function learn (pairs) {
  const g = loadGlossary()
  const learned = []
  for (const [heardRaw, meantRaw] of pairs ?? []) {
    const heard = String(heardRaw ?? '').trim().replace(/[.,!?;:]+$/, '')
    const meant = String(meantRaw ?? '').trim().replace(/[.,!?;:]+$/, '')
    const hw = heard.split(/\s+/); const mw = meant.split(/\s+/)
    if (!heard || !meant || hw.length > 3 || mw.length > 3 || heard.length > 40 || meant.length > 40) continue
    if (heard.toLowerCase() === meant.toLowerCase()) continue
    if (hw.every((w) => COMMON.has(w.toLowerCase()))) continue
    if (heard.length < 3) continue
    const key = heard.toLowerCase()
    if (g[key] === meant) continue
    g[key] = meant
    learned.push([key, meant])
  }
  if (learned.length) saveGlossary(g)
  return learned
}

export function loadGlossary () {
  if (!existsSync(path())) { saveGlossary(SEED); return { ...SEED } }
  try { return JSON.parse(readFileSync(path(), 'utf8')) } catch { return { ...SEED } }
}

export function saveGlossary (g) { writeFileSync(path(), JSON.stringify(g, null, 2)) }

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Returns { text, fixes: [[from, to]] }. Longest phrases first so "r key chat" beats "r key".
export function applyGlossary (text, g = loadSettings().autofix ? loadGlossary() : {}) {
  const fixes = []
  let out = String(text)
  for (const from of Object.keys(g).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\w-])${escape(from).replace(/\\ /g, '[\\s-]+')}(?![\\w-])`, 'gi')
    out = out.replace(re, (m) => { if (m !== g[from]) fixes.push([m, g[from]]); return g[from] })
  }
  return { text: out, fixes }
}
