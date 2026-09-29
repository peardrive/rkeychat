// SVG-only qrcode for Bare: the encoder and SVG renderer are pure JS.
import QR from 'qrcode-core/lib/core/qrcode.js'
import Svg from 'qrcode-core/lib/renderer/svg-tag.js'

export async function toString (text, opts = {}) {
  if (opts.type && opts.type !== 'svg') throw new Error('only SVG QR codes on this device')
  return Svg.render(QR.create(text, opts), opts)
}
export default { toString }
