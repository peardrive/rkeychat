// First-run setup (2026-11-24): the provider presets, a key-less local provider, and the Claude login driven from
// the app (src/claude-login.js), as the daemon reads the CLI's output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_PRESETS, LOCAL_TOKEN, presetOf, describeProviders, providerEnv } from '../src/seat-settings.js'
import { parseLoginOutput, parseStatus, ClaudeLogin } from '../src/claude-login.js'
import { nodeEnv } from '../src/acp.js'

test('the presets are PPQ, OpenRouter and llama.cpp, each a root URL Claude Code is pointed at', () => {
  assert.deepEqual(Object.keys(PROVIDER_PRESETS), ['ppq', 'openrouter', 'llamacpp'])
  for (const p of Object.values(PROVIDER_PRESETS)) {
    assert.ok(/^https?:\/\//.test(p.baseUrl) && !p.baseUrl.endsWith('/') && !p.baseUrl.endsWith('/v1'), `${p.label}: ${p.baseUrl}`)
    assert.ok(['required', 'none'].includes(p.key))
  }
  assert.equal(PROVIDER_PRESETS.llamacpp.key, 'none')
})

test('a stored provider is recognised as a preset by name, or by its URL under another name', () => {
  assert.equal(presetOf('ppq', { baseUrl: 'https://api.ppq.ai' }), 'ppq')
  assert.equal(presetOf('pay', { baseUrl: 'https://api.ppq.ai' }), 'ppq')
  assert.equal(presetOf('gw', { baseUrl: 'https://gateway.example.com' }), null)
  const d = describeProviders({ ppq: { baseUrl: 'https://api.ppq.ai', token: 'sk-x' }, openrouter: { baseUrl: 'https://openrouter.ai/api' }, llamacpp: { baseUrl: 'http://127.0.0.1:8080' } })
  assert.deepEqual(d.map((p) => [p.name, p.label, p.ready]), [['ppq', 'PPQ', true], ['openrouter', 'OpenRouter', false], ['llamacpp', 'llama.cpp', true]])
  assert.ok(d.every((p) => !('token' in p)), 'the token never travels')
})

test('llama.cpp needs no key: its seat gets a placeholder token and an emptied ANTHROPIC_API_KEY; a keyed preset still needs its key', () => {
  const providers = { llamacpp: { baseUrl: 'http://127.0.0.1:8080' }, openrouter: { baseUrl: 'https://openrouter.ai/api' } }
  assert.deepEqual(providerEnv({ provider: 'llamacpp' }, providers), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN, ANTHROPIC_API_KEY: '' })
  assert.throws(() => providerEnv({ provider: 'openrouter' }, providers), /no token/)
})

test('the login output: the URL to show, the moment a code is wanted, success and failure', () => {
  const start = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\n'
  let p = parseLoginOutput(start)
  assert.equal(p.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz')
  assert.equal(p.waitingForCode, false)
  p = parseLoginOutput(start + 'Paste code here if prompted > ')
  assert.equal(p.waitingForCode, true)
  assert.equal(parseLoginOutput('Logged in as someone@example.com').success, true)
  assert.equal(parseLoginOutput('Error: invalid code').error, 'Error: invalid code')
  assert.equal(parseLoginOutput('').url, null)
})

test('auth status --json becomes what the app shows: logged in, by which method, as whom', () => {
  assert.deepEqual(parseStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max","loginExpiresAt":"2026-12-18T14:37:53.165Z"}'), { loggedIn: true, method: 'claude.ai', email: 'a@b.c', plan: 'max', expires: '2026-12-18T14:37:53.165Z' })
  assert.deepEqual(parseStatus('{"loggedIn":false,"authMethod":"none"}'), { loggedIn: false, method: 'none', email: null, plan: null, expires: null })
  assert.deepEqual(parseStatus('not json'), { loggedIn: false })
})

test('a login driven through a fake CLI: the URL and the code prompt are reported, the pasted code reaches stdin, exit 0 is done', async () => {
  // the "CLI": prints what the real one prints, waits for a line on stdin, exits 0 on the right code
  const script = `
    process.stdout.write('Opening browser to sign in…\\n');
    process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\\n");
    setTimeout(() => process.stdout.write('Paste code here if prompted > '), 30);
    process.stdin.on('data', (d) => { if (String(d).trim() === 'good-code') { console.log('Logged in as test@example.com'); process.exit(0) } else { console.error('Error: invalid code'); process.exit(1) } });
  `
  const login = new ClaudeLogin({ command: process.execPath, args: ['-e', script] })
  const seen = []
  login.on('change', (s) => seen.push({ ...s }))
  login.start()
  assert.equal(login.state.running, true)
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(login.state.url, 'https://claude.com/cai/oauth/authorize?code=true&state=s1')
  assert.equal(login.state.waitingForCode, true)
  login.code('good-code')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(login.state.running, false)
  assert.equal(login.state.done, true)
  assert.equal(login.state.error, null)
  assert.ok(seen.length >= 3, 'each step was announced')
  // a wrong code is a failure the app can show, and a second login can start
  const again = new ClaudeLogin({ command: process.execPath, args: ['-e', script] })
  again.start()
  await new Promise((r) => setTimeout(r, 200))
  again.code('bad')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(again.state.done, false)
  assert.match(again.state.error, /invalid code/)
  assert.throws(() => again.code('x'), /no login is in progress/)
})

test('a disabled login (a phone) reports no login and refuses to start', async () => {
  const l = new ClaudeLogin({ disabled: true })
  assert.deepEqual(await l.status(), { loggedIn: false, available: false })
  assert.throws(() => l.start(), /run on a computer/)
})

test('inside Electron a child that must be plain node gets ELECTRON_RUN_AS_NODE; under node nothing is added', () => {
  const env = nodeEnv({ A: '1' })
  if (process.versions.electron) assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  else assert.deepEqual(env, { A: '1' })
})
