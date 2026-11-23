// A seat's permission mode, model and provider (src/seat-settings.js), as the daemon checks and applies them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPermissionMode, checkModel, checkProviderName, checkBaseUrl, checkAutoLimit, autoState, describeAuto, providerEnv, describeProviders, describeRun, PERMISSION_MODES } from '../src/seat-settings.js'

test('the permission modes are Claude Code\'s four; bypass is refused by name and by alias', () => {
  for (const m of PERMISSION_MODES) assert.equal(checkPermissionMode(m), m)
  assert.throws(() => checkPermissionMode('bypassPermissions'), /never used/)
  assert.throws(() => checkPermissionMode('bypass'), /never used/)
  assert.throws(() => checkPermissionMode('yolo'), /unknown permission mode/)
  assert.throws(() => checkPermissionMode(''), /unknown permission mode/)
})

test('a model is an id or the default; a provider is a short name, never "claude"', () => {
  assert.equal(checkModel('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(checkModel('default'), null)
  assert.equal(checkModel(''), null)
  assert.equal(checkModel(null), null)
  assert.throws(() => checkModel('a model with spaces'), /letters, digits/)
  assert.equal(checkProviderName('PPQ'), 'ppq')
  assert.throws(() => checkProviderName('claude'), /login itself/)
  assert.throws(() => checkProviderName('_x'), /1-24 characters/)
})

test('the base URL is the root Claude Code is pointed at: no trailing slash, http(s) only', () => {
  assert.equal(checkBaseUrl('https://api.ppq.ai'), 'https://api.ppq.ai')
  assert.equal(checkBaseUrl('https://api.ppq.ai/'), 'https://api.ppq.ai')
  assert.equal(checkBaseUrl('https://gateway.example.com/anthropic/'), 'https://gateway.example.com/anthropic')
  assert.throws(() => checkBaseUrl('api.ppq.ai'), /full http/)
  assert.throws(() => checkBaseUrl('ftp://x'), /http or https/)
})

test('the environment a seat gets: nothing on the login; URL and token on a provider; a missing provider or token is a fault', () => {
  const providers = { ppq: { baseUrl: 'https://api.ppq.ai', token: 'sk-test' }, bare: { baseUrl: 'https://x.example' } }
  assert.deepEqual(providerEnv({ kind: 'claude' }, providers), {})
  assert.deepEqual(providerEnv({ kind: 'claude', provider: 'ppq' }, providers), { ANTHROPIC_BASE_URL: 'https://api.ppq.ai', ANTHROPIC_AUTH_TOKEN: 'sk-test' })
  assert.throws(() => providerEnv({ provider: 'gone' }, providers), /does not have/)
  assert.throws(() => providerEnv({ provider: 'bare' }, providers), /no token/)
})

test('what the API and the list say: never the token', () => {
  const providers = { ppq: { baseUrl: 'https://api.ppq.ai', token: 'sk-test' } }
  const d = describeProviders(providers)
  assert.deepEqual(d, [{ name: 'ppq', baseUrl: 'https://api.ppq.ai', hasToken: true }])
  assert.ok(!JSON.stringify(d).includes('sk-test'))
  assert.equal(describeRun({ kind: 'claude' }), 'mode: Edits · model: default · this computer\'s Claude login')
  assert.equal(describeRun({ kind: 'claude', permissionMode: 'default', model: 'claude-opus-5-5', provider: 'ppq' }), 'mode: Ask · model: Opus 5.5 · provider: ppq')
})

test('an Auto grant: minutes and turns from 1 up, nothing for no limit; where it stands is the tighter of the seat\'s and the room\'s', () => {
  assert.deepEqual(checkAutoLimit(undefined), { minutes: null, turns: null })
  assert.deepEqual(checkAutoLimit({ minutes: '30', turns: 0 }), { minutes: 30, turns: null })
  assert.deepEqual(checkAutoLimit({ minutes: '', turns: 5.7 }), { minutes: null, turns: 5 })
  assert.throws(() => checkAutoLimit({ minutes: -1 }), /minutes/)
  assert.throws(() => checkAutoLimit({ turns: 5000 }), /turns/)
  assert.throws(() => checkAutoLimit('30'), /minutes, turns/)

  const now = 10_000_000
  const grant = { since: now - 10 * 60_000, minutes: 30, turns: 5, used: 2 }
  assert.deepEqual(autoState(null, null, now), { on: false, until: null, turnsLeft: null, over: null })
  assert.deepEqual(autoState(grant, null, now), { on: true, until: now + 20 * 60_000, turnsLeft: 3, over: null })
  assert.deepEqual(autoState({ since: now, minutes: null, turns: null, used: 9 }, null, now), { on: true, until: null, turnsLeft: null, over: null }, 'no limit')
  // the room's cap is tighter: 15 minutes from since, 2 turns
  assert.deepEqual(autoState(grant, { minutes: 15, turns: 2 }, now), { on: true, until: now + 5 * 60_000, turnsLeft: 0, over: '2 turns are done' })
  assert.equal(autoState(grant, null, now + 21 * 60_000).over, '30 minutes are up')
  assert.equal(autoState({ since: now, minutes: null, turns: 3, used: 1 }, { minutes: 1 }, now + 60_000).over, '1 minute is up')
  assert.equal(describeAuto(grant, null, now), '20 min left, 3 turns left')
  assert.equal(describeAuto({ since: now }, null, now), 'no limit')
  assert.equal(describeAuto(null), '')
  assert.match(describeRun({ permissionMode: 'auto', auto: { since: Date.now(), minutes: null, turns: 4, used: 1 } }), /mode: Auto \(3 turns left\)/)
})
