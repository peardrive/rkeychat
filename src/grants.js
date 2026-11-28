// What a project's agents may read and run beyond the seat's tool list, as the owner granted it (Guy, 2026-11-27:
// "permissions inside this app and for access on the macbook that is approved by me safely but within the chat
// session").
//
// Three things live here:
//   - the places no grant ever opens: the business folders (`_` folders beside the project or one level under a
//     home folder, ~/Anjou/_keys among them), ssh/gpg/cloud keys and rKeyChat's own config (secret keys);
//   - what counts as a read-only shell command, so `sed -n`, `head` or a `for` loop over files is judged as a read
//     of the paths it names rather than as an unknown program;
//   - the rule an ask offers as "Allow for this project": a folder for a read, a program for a command, never a
//     shell, a delete or the home folder itself.
//
// A grant is a signed control in the project's room ({ action: 'grant', rule, revoke? }) or an ask answered
// `allow_always` (the ask carries the rule the card showed). Both come only from the owner's own keys.
import * as os from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
// namespace imports: the phone's runtime (bare-fs, bare-os) has no globSync, and a named import would stop the module
import * as fs from 'node:fs'

const HOME = () => { try { return os.homedir() } catch { return '/nonexistent-home' } }

// Under home, never readable by an agent and never grantable.
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.rkeychat', '.anjou', '.config/gh', '.docker', '.kube', '.netrc', '.npmrc', 'Library/Keychains', 'Library/Cookies', 'Library/Application Support/Google/Chrome', 'Library/Messages', 'Library/Mail']

const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

// A business folder: a `_` folder one level under a folder in home (~/Anjou/_keys), or beside the project.
function businessSegment (p, dir) {
  const home = HOME()
  if (within(p, home)) {
    const segs = relative(home, p).split(sep)
    if (segs.length >= 2 && segs[1].startsWith('_')) return true
  }
  if (dir) {
    const beside = dirname(dir)
    if (within(p, beside) && p !== beside) {
      const first = relative(beside, p).split(sep)[0]
      if (first.startsWith('_')) return true
    }
  }
  return false
}

// No agent reads this, whatever the rules say.
export function isForbidden (p, dir = null) {
  if (!p) return false
  const abs = resolve(p)
  const home = HOME()
  if (SECRET_DIRS.some((d) => within(abs, join(home, d)))) return true
  return businessSegment(abs, dir)
}

// A folder that holds a forbidden one: reading it file by file is fine, walking it (grep -r, find, Glob) is not
// without asking, because the walk would go through the forbidden part.
export function holdsForbidden (p, dir = null) {
  const abs = resolve(p)
  const home = HOME()
  if (within(home, abs)) return true // home, or above it
  if (dir && within(dirname(dir), abs)) return true // the folder beside the project, or above it
  if (within(abs, home) && relative(home, abs).split(sep).length === 1) {
    try { return fs.readdirSync(abs).some((n) => n.startsWith('_')) } catch { return false }
  }
  return false
}

// ---- grants: the folder or program "Allow for this project" opens ----

const NEVER_ALWAYS = new Set(['rm', 'rmdir', 'sudo', 'su', 'sh', 'bash', 'zsh', 'fish', 'eval', 'exec', 'source', '.', 'python', 'python3', 'perl', 'ruby', 'osascript', 'security', 'dd', 'chmod', 'chown', 'kill', 'killall', 'pkill', 'launchctl', 'defaults', 'xargs', 'env', 'ssh', 'scp', 'sftp', 'rsync', 'open', 'shutdown', 'reboot', 'diskutil', 'mv', 'cp', 'ln', 'tee', 'crontab', 'nohup', 'time', 'command', 'builtin'])

// The folder a grant for this path opens: the path itself when it is a folder, else its folder; under home at
// most two levels deep (~/Anjou/pearkit, not ~/Anjou/pearkit/src/components). Null when that would be home, the
// disk, or a place no grant opens.
export function folderFor (p, dir = null) {
  let f = resolve(p)
  try { if (!fs.statSync(f).isDirectory()) f = dirname(f) } catch { f = dirname(f) }
  const home = HOME()
  if (within(f, home)) {
    const segs = relative(home, f).split(sep).filter(Boolean)
    if (!segs.length) return null
    f = join(home, ...segs.slice(0, 2))
  }
  if (f === '/' || within(home, f) || isForbidden(f, dir)) return null
  if (dir && within(dir, f)) return null // the project itself or a folder above it: too wide
  return f
}

const tilde = (p) => { const h = HOME(); return within(p, h) ? '~' + p.slice(h.length) : p }

// A rule as people read it.
export function describeRule (rule) {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(String(rule ?? '').trim())
  if (!m) return String(rule)
  const [, tool, arg] = m
  const path = arg?.startsWith('//') ? tilde(arg.slice(1).replace(/\/\*\*$/, '')) : arg
  if (tool === 'Read' && arg) return `read anything in ${path}`
  if (tool === 'Edit' && arg) return `change files in ${path}`
  if (tool === 'Bash' && arg?.endsWith(':*')) return `run ${arg.slice(0, -2)} commands`
  if (tool === 'Bash' && arg) return `run \`${arg}\``
  return arg ? `use ${tool} on ${arg}` : `use ${tool}`
}

// Whether a rule may stand as a grant: the shapes this file makes, and no forbidden folder.
export function cleanGrantRule (rule, dir = null) {
  const s = String(rule ?? '').trim().slice(0, 600)
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(s)
  if (!m) return null
  const [, tool, arg] = m
  if (tool === 'Read' || tool === 'Edit') {
    if (!arg?.startsWith('//') || !arg.endsWith('/**')) return null
    const f = arg.slice(1, -3)
    if (!isAbsolute(f) || f.includes('*') || folderFor(f, dir) !== f) return null
    return s
  }
  if (tool === 'Bash') {
    if (!arg?.endsWith(':*')) return null
    const prog = arg.slice(0, -2)
    if (!/^[A-Za-z0-9._+-]+$/.test(prog) || NEVER_ALWAYS.has(prog)) return null
    return s
  }
  if (arg) return null
  if (tool === 'Bash' || tool === 'Task' || tool === 'Agent') return null
  return s
}

// The rule an ask offers as "Allow for this project", or null (allow once only). `unreadable` are the paths a
// read-only command named that the rules do not open (src/acp.js verdict).
export function grantFor (tool, input = {}, dir = null, { unreadable = [], blockers = [] } = {}) {
  const one = (r) => { const c = r && cleanGrantRule(r, dir); return c ? { rule: c, label: describeRule(c) } : null }
  const folderRule = (fam, paths) => {
    const fs = [...new Set(paths.map((p) => folderFor(p, dir)))]
    return fs.length === 1 && fs[0] ? one(`${fam}(/${fs[0]}/**)`) : null
  }
  if (['Read', 'Grep', 'Glob', 'LS'].includes(tool)) return folderRule('Read', pathsIn(input, dir))
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return folderRule('Edit', pathsIn(input, dir))
  if (tool === 'Bash') {
    if (unreadable.length) return folderRule('Read', unreadable)
    const progs = [...new Set(blockers.map((part) => words(part)[0]).filter(Boolean))]
    return progs.length === 1 ? one(`Bash(${progs[0]}:*)`) : null
  }
  return one(tool)
}

export function pathsIn (input, dir) {
  const out = []
  for (const k of ['file_path', 'path', 'notebook_path', 'directory']) if (typeof input?.[k] === 'string') out.push(expand(input[k], dir))
  return out
}

function expand (p, dir) {
  const h = HOME()
  if (p === '~') return h
  if (p.startsWith('~/')) return join(h, p.slice(2))
  if (p.startsWith('$HOME/')) return join(h, p.slice(6))
  return resolve(dir ?? process.cwd(), p)
}

// ---- read-only shell commands ----

// Programs that only read (with the flags that would make them write refused below).
const READERS = new Set(['cat', 'head', 'tail', 'ls', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'sed', 'sort', 'uniq', 'cut', 'tr', 'nl', 'echo', 'printf', 'file', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'test', '[', 'true', 'false', 'diff', 'cmp', 'comm', 'tree', 'jq', 'xxd', 'od', 'strings', 'md5', 'shasum', 'column', 'fold', 'fmt', 'rev', 'tac', 'date', 'which', 'whoami', 'uname', 'paste', 'expand', 'look', 'mdls', 'plutil'])
const RECURSIVE = { grep: ['-r', '-R', '--recursive', '-d'], egrep: ['-r', '-R'], fgrep: ['-r', '-R'], rg: true, find: true, du: true, tree: true, ls: ['-R'] }
const KEYWORDS = new Set(['do', 'then', 'else', 'if', 'while', 'until', 'elif', '!', '{'])
const ENDERS = new Set(['done', 'fi', '}'])

// Shell words with quotes resolved, and the operators between them. Null for anything this reader will not judge
// (command substitution, a background `&`, a here-doc).
export function lex (cmd) {
  const toks = []; let cur = null; let i = 0
  const s = String(cmd ?? '')
  const push = () => { if (cur !== null) { toks.push(cur); cur = null } }
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) { cur = (cur ?? '') + s[i + 1]; i += 2; continue }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return null; cur = (cur ?? '') + s.slice(i + 1, j); i = j + 1; continue }
    if (c === '"') {
      let j = i + 1; let v = ''
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { v += s[j + 1]; j += 2; continue } if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return null; v += s[j++] }
      if (j >= s.length) return null
      cur = (cur ?? '') + v; i = j + 1; continue
    }
    if (c === '`' || (c === '$' && s[i + 1] === '(') || (c === '<' && s[i + 1] === '(') || (c === '<' && s[i + 1] === '<')) return null
    if (c === ' ' || c === '\t') { push(); i++; continue }
    if (c === '\n' || c === ';') { push(); toks.push({ op: ';' }); i++; continue }
    if (c === '&' && s[i + 1] === '&') { push(); toks.push({ op: '&&' }); i += 2; continue }
    if (c === '|' && s[i + 1] === '|') { push(); toks.push({ op: '||' }); i += 2; continue }
    if (c === '|') { push(); toks.push({ op: '|' }); i++; continue }
    if (c === '>' || c === '<' || (c === '&' && s[i + 1] === '>')) {
      // only throwing output away is a read: 2>/dev/null, >/dev/null, &>/dev/null, 2>&1; `<file` reads a file
      const fd = cur !== null && /^\d$/.test(cur) ? cur : null
      if (fd !== null) cur = null
      push()
      const m = /^(&?>>?|<)\s*(&\d|\S+)/.exec(s.slice(i))
      if (!m) return null
      const [all, kind, target] = m
      if (kind === '<') toks.push({ op: '<', path: target })
      else if (!(target === '/dev/null' || /^&[12]$/.test(target))) return null
      i += all.length; continue
    }
    if (c === '&') return null
    cur = (cur ?? '') + c; i++
  }
  push()
  return toks
}

function words (part) { const t = lex(part); return t ? t.filter((x) => typeof x === 'string') : String(part).trim().split(/\s+/) }

// A command that only reads: the paths it reads ({ paths, walks } with `walks` the ones read recursively), or null
// when any part of it might write, run something else, or cannot be judged.
export function readOnlyCommand (cmd, dir) {
  const toks = lex(cmd)
  if (!toks?.length) return null
  const paths = []; const walks = []
  const loopVars = new Set()
  let part = []
  const flush = () => {
    let w = part; part = []
    while (w.length && KEYWORDS.has(w[0])) w = w.slice(1)
    if (!w.length || (w.length === 1 && ENDERS.has(w[0]))) return true
    if (w[0] === 'for' && w[2] === 'in') { loopVars.add(w[1]); for (const x of w.slice(3)) if (!arg(x, false)) return false; return true }
    const prog = w[0]
    if (!READERS.has(prog)) return false
    const args = w.slice(1)
    if (prog === 'find' && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return false
    // sed writes with -i, a `w` command or the `w`/`e` flags of an s command
    if (prog === 'sed' && args.some((a) => /^(-i|--in-place)/.test(a) || /(^|[;{}\s])[wWe](\s|$)|\/[gpIiM0-9]*[we][gpIiM0-9]*(\s|;|}|$)/.test(a))) return false
    if (prog === 'sort' && args.some((a) => /^(-o|--output)/.test(a))) return false
    if (prog === 'uniq' && args.filter((a) => !a.startsWith('-')).length > 1) return false
    if ((prog === 'date') && args.some((a) => /^-s|^--set/.test(a))) return false
    const rec = RECURSIVE[prog]
    const walking = rec === true || (Array.isArray(rec) && args.some((a) => rec.some((f) => a === f || (f.length === 2 && /^-[a-zA-Z]+$/.test(a) && a.includes(f[1])))))
    // grep's first word is its pattern, sed's its script: not paths (unless -e/-f gave them)
    let skip = (prog === 'grep' || prog === 'egrep' || prog === 'fgrep' || prog === 'rg') && !args.some((a) => a === '-e' || a === '-f') ? 1 : prog === 'sed' && !args.some((a) => a === '-e' || a === '-f') ? 1 : 0
    if (prog === 'echo' || prog === 'printf' || prog === 'test' || prog === '[' || prog === 'date' || prog === 'which' || prog === 'basename' || prog === 'dirname') skip = Infinity
    let nonflag = 0
    let any = false
    for (const a of args) {
      if (a.startsWith('-') && a !== '-') continue
      if (nonflag++ < skip) { if (!okWord(a)) return false; continue }
      if (!arg(a, walking)) return false
      any = true
    }
    if (!any && (walking || prog === 'ls')) { paths.push(resolve(dir)); if (walking) walks.push(resolve(dir)) }
    return true
  }
  // a word that is not a path still may not smuggle a variable
  const okWord = (a) => !/\$(?!HOME\b)/.test(a) || [...a.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].every((m) => loopVars.has(m[1]) || m[1] === 'HOME')
  const arg = (a, walking) => {
    if (!okWord(a)) return false
    if (/\$\{?([A-Za-z_][A-Za-z0-9_]*)/.test(a) && !/^\$\{?HOME\b/.test(a)) return true // a loop variable: its values were checked in the list
    const p = expand(a.replace(/^\$\{HOME\}/, '$HOME'), dir)
    const glob = p.search(/[*?[]/)
    if (glob >= 0) {
      // a pattern reads what it matches; one that reaches a forbidden folder is a walk through it
      const base = dirname(p.slice(0, glob) + 'x')
      let hits = null
      try { hits = fs.globSync?.(p) ?? null } catch {}
      if (!hits) { paths.push(base); walks.push(base); return true }
      paths.push(base)
      for (const h of hits) { const abs = resolve(h); if (isForbidden(abs, dir)) { walks.push(base); break } if (walking) walks.push(abs) }
      return true
    }
    paths.push(p); if (walking) walks.push(p)
    return true
  }
  for (const t of toks) {
    if (typeof t === 'string') { part.push(t); continue }
    if (t.op === '<') { if (!arg(t.path, false)) return null; continue }
    if (!flush()) return null
  }
  if (!flush()) return null
  return { paths, walks }
}
