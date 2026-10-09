// One pairing mechanism, two meanings. The thing that must never slip: a code that
// invites someone to a room must not hand them the account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeLogin, decodeLogin, encodePair, decodePair, decodeAny, isPairing } from '../src/login.js'

const base = { r: 'bip340:' + 'a'.repeat(64), n: 'guy', s: 'pearcore://xyz', k: 'tok' }

test('a login code still decodes as a login', () => {
  const c = encodeLogin(base)
  assert.ok(c.startsWith('rkl1.'))
  assert.equal(decodeAny(c).action, 'login')
  assert.equal(decodeLogin(c).name, 'guy')
})

test('a room code carries the room and says what it is for', () => {
  const c = encodePair({ a: 'room', ...base, rn: 'PearDrive Lab' })
  assert.ok(c.startsWith('rkp1.'))
  const d = decodeAny(c)
  assert.equal(d.action, 'room')
  assert.equal(d.roomName, 'PearDrive Lab')
  // the room's topic is deliberately NOT in the code: the offerer knows which room
  // the offer is for, so putting it on the wire only makes the QR denser
  assert.ok(!c.includes('rm'), 'no room topic on the wire')
})

test('the two prefixes do not decode as each other', () => {
  assert.throws(() => decodePair(encodeLogin(base)), /pairing code/)
  assert.throws(() => decodeLogin(encodePair({ a: 'room', ...base })), /login code/)
})

test('an action we do not know is refused rather than guessed at', () => {
  assert.throws(() => decodePair(encodePair({ a: 'drive', ...base })), /unknown pairing action/)
})

test('an incomplete code is refused', () => {
  assert.throws(() => decodePair(encodePair({ a: 'room', r: base.r })), /incomplete/)
})

test('the scanner recognises both kinds and nothing else', () => {
  assert.ok(isPairing(encodeLogin(base)))
  assert.ok(isPairing(encodePair({ a: 'room', ...base })))
  assert.ok(!isPairing('rkc1.whatever'))
  assert.ok(!isPairing('https://example.com'))
})
