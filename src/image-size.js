// The size of a picture from its first bytes, so a shared image can say its shape before anyone fetches it
// (the chat lays a gallery out from `w` and `h`; AGENTS: signed statements are integers). PNG, JPEG, GIF and WebP;
// anything else, or a file too short to read, is null. Reads at most the first 64 KB.
import { openSync, readSync, closeSync } from 'node:fs'

const HEAD = 64 * 1024

export function imageSizeOf (buf) {
  if (!buf || buf.length < 12) return null
  // PNG: IHDR width/height at 16 and 20
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) return pair(buf.readUInt32BE(16), buf.readUInt32BE(20))
  // GIF: little-endian 16-bit at 6 and 8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return pair(buf.readUInt16LE(6), buf.readUInt16LE(8))
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X chunks
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') return pair(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return pair((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1) }
    if (chunk === 'VP8X') return pair(1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)))
    return null
  }
  // JPEG: walk the markers to the first SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return pair(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5))
      i += 2 + len
    }
  }
  return null
}

const pair = (w, h) => (w > 0 && h > 0 && w < 1e6 && h < 1e6 ? { w, h } : null)

export function imageSize (path) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEAD)
    const n = readSync(fd, buf, 0, HEAD, 0)
    return imageSizeOf(buf.subarray(0, n))
  } catch { return null } finally { if (fd !== null) try { closeSync(fd) } catch {} }
}
