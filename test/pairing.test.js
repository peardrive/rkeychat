// An invitation is a bare pearcore link. These pin the two things that make that
// safe: the scanner can tell what the link is for before acting on it, and holding
// the link is proved rather than assumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLink, isInvitation, signProof, checkProof, INVITE, LOGIN } from '../src/login.js'
import { encodeShareLink } from 'pearcore/src/utils/sharelink.utils.js'
import { generate, signerFromSecret } from 'rkey'

const link = (spaceName) => encodeShareLink({ spaceName, publicKey: 'a'.repeat(64), nonce: 'b'.repeat(24) })

test('the space name says what the scan is for', () => {
  assert.equal(readLink(link(`${INVITE}:ab12cd`)).action, 'room')
  assert.equal(readLink(link(`${LOGIN}:ab12cd`)).action, 'login')
})

test('the nonce comes out of the link, because it is the secret', () => {
  assert.equal(readLink(link(`${INVITE}:x`)).nonce, 'b'.repeat(24))
})

test('a pearcore link for something else is refused, not guessed at', () => {
  assert.throws(() => readLink(link('peardrive-share:holiday')), /not an rKeyChat invitation/)
  assert.throws(() => readLink('rkc1.abc'), /pearcore link/)
  assert.throws(() => readLink('https://example.com'), /pearcore link/)
  assert.ok(!isInvitation(link('some-other-app:1')))
  assert.ok(isInvitation(link(`${INVITE}:1`)))
})

test('the proof needs the nonce, the right key and the right space', async () => {
  const signer = generate('ed25519')
  const topic = 'f'.repeat(64)
  const nonce = 'b'.repeat(24)
  const proof = await signProof(signer, topic, nonce)

  assert.ok(checkProof(signer.ref, proof, topic, nonce), 'the real thing verifies')
  assert.ok(!checkProof(signer.ref, proof, topic, 'c'.repeat(24)), 'a different nonce does not')
  assert.ok(!checkProof(signer.ref, proof, 'e'.repeat(64), nonce), 'the same proof in another space does not')

  const other = signerFromSecret('ed25519', generate('ed25519').secretKey)
  assert.ok(!checkProof(other.ref, proof, topic, nonce), 'somebody else cannot present it')
  assert.ok(!checkProof(signer.ref, 'deadbeef', topic, nonce), 'rubbish does not')
})
