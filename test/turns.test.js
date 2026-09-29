import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budget, addressedTo, replyDepth } from '../src/turns.js'
import { parseMentions } from '../src/proto.js'

const human = (text, mentions = []) => ({ kind: 'msg', human: true, name: 'guy', depth: 0, text, mentions })
const agent = (name, depth, mentions = []) => ({ kind: 'msg', human: false, name, depth, mentions })
const ctl = (action, extra = {}) => ({ kind: 'control', action, ...extra })

test('default budget is 3 rounds and resets when Guy speaks', () => {
  const log = [human('hi'), agent('claude', 1), agent('kimi', 2), agent('claude', 3)]
  const b = budget(log)
  assert.equal(b.remaining, 0)
  assert.equal(b.allows(4), false)
  const after = budget([...log, human('keep going')])
  assert.equal(after.remaining, 3)
  assert.equal(after.allows(1), true)
})

test('extend, unlimited, until, pause', () => {
  const base = [human('hi'), agent('claude', 1), agent('kimi', 2), agent('claude', 3)]
  assert.equal(budget([...base, ctl('extend', { n: 10 })]).allows(13), true)
  assert.equal(budget([...base, ctl('extend', { n: 10 })]).allows(14), false)
  assert.equal(budget([...base, ctl('unlimited')]).allows(1000), true)
  assert.equal(budget([...base, ctl('until', { until: 2000 })], { now: 1000 }).allows(99), true)
  assert.equal(budget([...base, ctl('until', { until: 2000 })], { now: 3000 }).allows(4), false)
  assert.equal(budget([...base, ctl('extend', { n: 5 }), ctl('pause')]).allows(4), false)
  assert.equal(budget([...base, ctl('extend', { n: 5 }), ctl('pause'), ctl('resume')]).allows(4), true)
})

test('"run all night" survives Guy chatting; reset ends it', () => {
  const log = [ctl('unlimited'), human('go'), agent('a', 50)]
  assert.equal(budget(log).allows(51), true)
  assert.equal(budget([...log, ctl('reset')]).allows(51), false)
})

test('addressing: open floor for un-addressed human messages, mentions otherwise', () => {
  assert.equal(addressedTo(human('anyone?'), 'claude'), true)
  assert.equal(addressedTo(human('@kimi you', ['kimi']), 'claude'), false)
  assert.equal(addressedTo(agent('kimi', 1, ['claude']), 'claude'), true)
  assert.equal(addressedTo(agent('kimi', 1, []), 'claude'), false)
  assert.equal(addressedTo(agent('claude', 1, ['claude']), 'claude'), false)
})

test('reply depth follows the deepest trigger', () => {
  assert.equal(replyDepth([human('x')]), 1)
  assert.equal(replyDepth([agent('a', 2), human('x')]), 3)
})

test('mentions only match real participants; @all expands', () => {
  const names = ['guy', 'claude', 'kimi-mini']
  assert.deepEqual(parseMentions('hey @Claude and @nobody', names), ['claude'])
  assert.deepEqual(parseMentions('@all look', names).sort(), [...names].sort())
})

test('per-agent pause and post limits', () => {
  const log = [human('go'), ctl('pause', { agent: 'kimi' }), ctl('limit', { agent: 'claude', n: 1 }), agent('claude', 1)]
  const b = budget(log)
  assert.equal(b.allows(2, 'kimi'), false)
  assert.equal(b.allows(2, 'claude'), false) // used its 1 post
  assert.equal(b.allows(2, 'other'), true)
  const next = budget([...log, human('again'), ctl('resume', { agent: 'kimi' })])
  assert.equal(next.allows(1, 'kimi'), true)
  assert.equal(next.allows(1, 'claude'), true) // limit is per human turn
  assert.deepEqual(next.agents.limits, { claude: 1 })
})

test('mirrored terminal messages never wake agents or touch rounds', () => {
  const mirroredHuman = { kind: 'msg', human: true, name: 'guy', depth: 0, text: 'hi', mentions: [], via: 'mirror' }
  const mirroredAgent = { kind: 'msg', human: false, name: 'claude', depth: 0, mentions: [], via: 'mirror' }
  assert.equal(addressedTo(mirroredHuman, 'claude'), false)
  const log = [human('go'), agent('claude', 1), agent('kimi', 2), mirroredHuman, mirroredAgent]
  assert.equal(budget(log).used, 2) // the mirrored human message did not reset the count
})
