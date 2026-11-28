// 2026-11-27: Guy wrote "Yes go ahead" while the agent's turn waited on his answer to an ask. The runner cancelled
// the turn; the cancel line was itself a change in the room, which poked the runner, which cancelled again: 2,000
// "interrupted" lines and a Mac app at 100% CPU that stopped answering. A turn is cancelled once, and never while
// it waits on an ask.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AcpProcess } from '../src/acp.js'

function proc () {
  const lines = []; const sent = []
  const p = new AcpProcess({ name: 'pear', room: {}, bridge: { kind: 'claude', via: 'acp', dir: '/tmp' }, onActivity: (t) => lines.push(t) })
  p.cx = { notify: async (m) => { sent.push(m) } }
  p.sessionId = 's1'
  p.pending = { resolve () {}, reject () {} }
  return { p, lines, sent }
}

test('a running turn is cancelled once, however often the runner asks', () => {
  const { p, lines, sent } = proc()
  assert.equal(p.cancel(), true)
  for (let i = 0; i < 50; i++) assert.equal(p.cancel(), false)
  assert.deepEqual(sent, ['session/cancel'])
  assert.equal(lines.length, 1)
})

test('a turn waiting on a person\'s answer to an ask is not cancelled', () => {
  const { p, lines, sent } = proc()
  p.asking = true
  assert.equal(p.cancel(), false)
  assert.deepEqual(sent, [])
  assert.equal(lines.length, 0)
  p.asking = false
  assert.equal(p.cancel(), true, 'once the answer is in, a newer message may still preempt it')
})
