// A shared picture says its shape from its first bytes (src/image-size.js), so the chat lays the gallery out before
// the bytes arrive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { imageSizeOf, imageSize } from '../src/image-size.js'

const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }
const gif = (w, h) => { const b = Buffer.alloc(16); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b }
// a JPEG: SOI, an APP0 segment, then SOF0 with height then width
const jpeg = (w, h) => Buffer.concat([Buffer.from('ffd8', 'hex'), Buffer.from('ffe00010', 'hex'), Buffer.alloc(14), Buffer.from('ffc00011', 'hex'), Buffer.from([8]), Buffer.from([h >> 8, h & 255, w >> 8, w & 255]), Buffer.alloc(12)])
const webpLossy = (w, h) => { const b = Buffer.alloc(32); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8 ', 12, 'latin1'); b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b }

test('png, gif, jpeg and webp sizes from the first bytes; anything else is null', () => {
  assert.deepEqual(imageSizeOf(png(1024, 768)), { w: 1024, h: 768 })
  assert.deepEqual(imageSizeOf(gif(320, 200)), { w: 320, h: 200 })
  assert.deepEqual(imageSizeOf(jpeg(1920, 1080)), { w: 1920, h: 1080 })
  assert.deepEqual(imageSizeOf(webpLossy(640, 480)), { w: 640, h: 480 })
  assert.equal(imageSizeOf(Buffer.from('not a picture at all, just words')), null)
  assert.equal(imageSizeOf(Buffer.alloc(4)), null)
  assert.equal(imageSizeOf(png(0, 10)), null)
})

test('imageSize reads a file and is null for a file that is not a picture or is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rkc-img-'))
  writeFileSync(join(dir, 'a.png'), png(300, 150))
  writeFileSync(join(dir, 'a.txt'), 'hello')
  assert.deepEqual(imageSize(join(dir, 'a.png')), { w: 300, h: 150 })
  assert.equal(imageSize(join(dir, 'a.txt')), null)
  assert.equal(imageSize(join(dir, 'missing.png')), null)
  rmSync(dir, { recursive: true, force: true })
})
