// Copy rKeyChat's source (../src) into ./core so it resolves this package's
// Bare dependencies. core/ is generated: edit ../src, then re-run.
import fs from 'fs'
import path from 'path'
const from = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'src')
const to = path.join(path.dirname(new URL(import.meta.url).pathname), 'core')
fs.rmSync(to, { recursive: true, force: true })
const copy = (a, b) => {
  fs.mkdirSync(b, { recursive: true })
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    const s = path.join(a, e.name); const d = path.join(b, e.name)
    e.isDirectory() ? copy(s, d) : fs.copyFileSync(s, d)
  }
}
copy(from, to)
console.log('synced', from, '->', to)
