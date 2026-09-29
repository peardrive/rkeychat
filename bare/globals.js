// Node-style globals pearcore expects, provided from Bare modules. Import this first.
import process from 'bare-process'
import { TextEncoder, TextDecoder } from 'bare-encoding'
import nodeCrypto from 'crypto'

globalThis.process = process
globalThis.TextEncoder ??= TextEncoder
globalThis.TextDecoder ??= TextDecoder
// @noble/* need Web Crypto's getRandomValues; bare-crypto has the OS CSPRNG behind randomFillSync
globalThis.crypto ??= {
  getRandomValues: (arr) => { nodeCrypto.randomFillSync(arr); return arr },
  randomUUID: () => nodeCrypto.randomUUID(),
  subtle: nodeCrypto.webcrypto?.subtle
}
process.env.PEARCORE_LOG_LEVEL ??= 'warn'
process.env.NODE_ENV ??= 'production'
