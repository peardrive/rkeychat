// What a project agent may do without asking.
//
// A project agent runs Claude Code headless. Headless, a permission prompt has nobody to
// answer it, so "ask" means "no": the agent's turn stalls on the first `npm test` or
// `git log`, and the room sees "thinking" for twenty minutes. On the night of the
// 2026-11-08 PearDrive audit every seat started like that, and Guy fixed each one by hand
// with a `.claude/settings.local.json` allowlist in the repo. This is that allowlist, as
// the default, so a new seat can work from its first turn.
//
// Spelling, in the agent's bridge config (`tools`):
//   'lab'  (default)  the preset below
//   'none'            allow nothing extra: every tool outside acceptEdits asks, and is refused
//   [rule, …]         an explicit Claude Code allow list, e.g. ['Bash(git:*)', 'Read']
//
// The rules are Claude Code permission rules (settings.json `permissions.allow` syntax),
// passed on the command line as --allowedTools / --disallowedTools.
import { dirname } from 'node:path'

// The lab preset: read anything that lives beside the project, run the project's own
// toolchain and rKeyChat, look at processes and logs. Nothing that reaches outside the
// machine except curl, which the lab uses against its own local nodes.
export const LAB = [
  'Read', 'Grep', 'Glob',
  'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(rkeychat:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(diff:*)', 'Bash(du:*)', 'Bash(which:*)',
  'Bash(ps:*)', 'Bash(pgrep:*)', 'Bash(lsof:*)', 'Bash(curl:*)', 'Bash(mkdir:*)'
]

export const PRESETS = ['lab', 'none']

// What `--tools` on the command line (or `tools` in the API) means. undefined → the default.
export function parseTools (input) {
  if (input == null || input === '') return undefined
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean)
  const s = String(input).trim()
  if (PRESETS.includes(s)) return s
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

// The flags for one spawn: { allow: [...], deny: [...] }. `dir` is the project folder.
export function resolveTools (spec = 'lab', dir = null) {
  if (Array.isArray(spec)) return { allow: spec, deny: [] }
  if (spec === 'none') return { allow: [], deny: [] }
  if (spec !== 'lab') throw new Error(`unknown tools preset "${spec}" (lab, none, or a comma-separated list of rules)`)
  if (!dir) return { allow: LAB, deny: [] }
  // Everything beside the project is readable (the other repos it works with), except
  // the business folders: by ~/Anjou/ORGANIZATION.md those start with `_` (_keys,
  // _deliveries, …) and hold things no agent should read on its own.
  const beside = dirname(dir)
  return { allow: [...LAB, `Read(/${beside}/**)`], deny: [`Read(/${beside}/_*/**)`] }
}

// One line for `rkeychat agent list`.
export function describeTools (spec = 'lab') {
  if (Array.isArray(spec)) return `tools: ${spec.join(', ')}`
  if (spec === 'none') return 'tools: none (asks for everything; headless, that is a refusal)'
  return 'tools: lab preset (git, npm, node, rkeychat, read-only shell; reads the folders beside the project)'
}
