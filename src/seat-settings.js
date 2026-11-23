// A seat's settings a person changes from the bot's profile (2026-11-22, Guy's memo): which permission mode Claude
// Code runs in, which model answers, and which provider the model is bought from. Shared by the daemon (writes
// them), the ACP process (applies them) and the CLI (words for them). Pure: no config reads here; the daemon sets
// `providerSettings` at boot and on every change, the way `askSettings` works in agents.js.

// Claude Code's permission modes as the ACP adapter offers them. `bypassPermissions` is never one of ours: a seat
// that asks nobody is not a seat anyone on the team should be able to make from a phone.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto']
export const MODE_WORDS = {
  default: { name: 'Ask', hint: 'asks before every change; the tool list still answers what it covers' },
  acceptEdits: { name: 'Edits', hint: 'edits inside its folder without asking; everything else asks' },
  plan: { name: 'Plan', hint: 'reads and plans only; no change until the mode is switched' },
  auto: { name: 'Auto', hint: 'Claude Code decides most permissions itself; the deny rules still win' }
}

export function checkPermissionMode (mode) {
  const m = String(mode ?? '').trim()
  if (m === 'bypassPermissions' || m === 'bypass') throw new Error('bypassPermissions is never used for a seat (docs/project-agents.md); pick default, acceptEdits, plan or auto')
  if (!PERMISSION_MODES.includes(m)) throw new Error(`unknown permission mode "${m}": default (ask), acceptEdits, plan or auto`)
  return m
}

// The models offered as choices (a seat may name any id by hand). `null` means the login's own default.
export const MODELS = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }
]
export const modelName = (id) => MODELS.find((m) => m.id === id)?.name ?? id ?? 'default'

export function checkModel (model) {
  if (model == null || model === '' || model === 'default') return null
  const m = String(model).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(m)) throw new Error('a model id is letters, digits, . _ : / and -')
  return m
}

// Providers: where the Anthropic-shaped API is answered from. Without one a seat runs under this computer's own
// Claude login. A provider is a device setting (config.json `providers`: { name: { baseUrl, token } }); a seat
// names one (`bridge.provider`). The token is a secret: it is written, never read back over the API or printed.
export const providerSettings = { providers: {} }

export function checkProviderName (name) {
  const n = String(name ?? '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(n)) throw new Error('a provider name is 1-24 characters: letters, digits and -')
  if (n === 'claude') throw new Error('"claude" is the login itself, not a provider')
  return n
}

export function checkBaseUrl (url) {
  let u
  try { u = new URL(String(url ?? '').trim()) } catch { throw new Error('the base URL must be a full http(s) URL, e.g. https://api.ppq.ai') }
  if (!/^https?:$/.test(u.protocol)) throw new Error('the base URL must be http or https')
  // Claude Code wants the root, not /v1: it adds the path itself
  return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
}

// What the API answers for `GET /api/providers`: names and URLs, and whether a token is held. Never the token.
export function describeProviders (providers = providerSettings.providers) {
  return Object.entries(providers ?? {}).map(([name, p]) => ({ name, baseUrl: p.baseUrl ?? null, hasToken: !!p.token }))
}

// The environment a seat's Claude Code gets for its provider: nothing for the login, or the base URL and the token
// as Claude Code reads them (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN). A seat naming a provider this device does
// not hold is a fault, not a silent fall-back to the login (and its bill).
export function providerEnv (bridge, providers = providerSettings.providers) {
  const name = bridge?.provider
  if (!name) return {}
  const p = providers?.[name]
  if (!p?.baseUrl) throw new Error(`the seat runs on provider "${name}", which this device does not have (rkeychat provider set ${name} URL)`)
  if (!p.token) throw new Error(`provider "${name}" has no token on this device (rkeychat provider set ${name} URL with the token on stdin)`)
  return { ANTHROPIC_BASE_URL: p.baseUrl, ANTHROPIC_AUTH_TOKEN: p.token }
}

// One line for `rkeychat agent list`.
export function describeRun (bridge) {
  const mode = bridge?.permissionMode ?? 'acceptEdits'
  return `mode: ${MODE_WORDS[mode]?.name ?? mode} · model: ${modelName(bridge?.model ?? null)} · ${bridge?.provider ? `provider: ${bridge.provider}` : 'this computer\'s Claude login'}`
}
