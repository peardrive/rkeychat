// Bare's zlib has no Brotli, which pearcore uses for sharelinks. Decoding uses a
// pure-JS Brotli decoder (reads anything desktop Node produces). Encoding emits
// valid Brotli made of uncompressed meta-blocks: desktop decodes it fine, the
// link is just a little longer. Sharelinks are tiny, so that's the right trade.
import zlib from 'bare-zlib'
import decompress from 'brotli/decompress.js'

export * from 'bare-zlib'
export default { ...zlib, brotliCompressSync, brotliDecompressSync }

export function brotliDecompressSync (buf) {
  return Buffer.from(decompress(Buffer.from(buf)))
}

export function brotliCompressSync (input) {
  const data = Buffer.from(input)
  const out = []
  let acc = 0
  let n = 0
  const bits = (value, count) => {
    for (let i = 0; i < count; i++) {
      acc |= ((value >>> i) & 1) << n
      if (++n === 8) { out.push(acc); acc = 0; n = 0 }
    }
  }
  const align = () => { if (n) { out.push(acc); acc = 0; n = 0 } }

  bits(0, 1) // WBITS = 16
  const MAX = 1 << 24
  for (let off = 0; off < data.length; off += MAX) {
    const chunk = data.subarray(off, off + MAX)
    const len = chunk.length - 1
    const nibbles = len < 1 << 16 ? 4 : len < 1 << 20 ? 5 : 6
    bits(0, 1) // ISLAST = 0
    bits(nibbles - 4, 2) // MNIBBLES
    bits(len, nibbles * 4) // MLEN - 1
    bits(1, 1) // ISUNCOMPRESSED
    align()
    for (const b of chunk) out.push(b)
  }
  bits(1, 1) // ISLAST
  bits(1, 1) // ISLASTEMPTY
  align()
  return Buffer.from(out)
}
