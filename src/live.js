// Live dictation over a WebSocket: the page streams 16 kHz mono PCM (Int16) as
// you talk; text streams back as { type: 'partial' } and, once you stop,
// { type: 'final' }.
//
// Engine today: rolling re-transcription. About once a second we transcribe
// everything said so far with the fast local model and send the result. A true
// streaming engine (sherpa-onnx / Parakeet / etc.) replaces `rolling()` behind
// the same protocol, so the page never changes.

import { WebSocketServer } from 'ws'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dataDir } from './config.js'
import { transcribe, canTranscribe } from './transcribe.js'
import { applyGlossary } from './glossary.js'
import { sttAvailable, transcribeSamples } from './stt.js'

const RATE = 16000
const TICK_MS = 900
const MAX_SECONDS = 180

function wav (pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

function rolling (cfg, ws) {
  const chunks = []
  let bytes = 0
  let doneBytes = 0 // audio length covered by the last transcription
  let busy = false
  let ended = false
  const id = randomBytes(5).toString('hex')
  const dir = join(dataDir(), 'tmp'); mkdirSync(dir, { recursive: true })
  const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }

  async function pass (final) {
    busy = true
    const covered = bytes
    const file = join(dir, `live-${id}-${covered}.wav`)
    try {
      writeFileSync(file, wav(Buffer.concat(chunks)))
      const raw = await transcribe(cfg, file)
      const { text, fixes } = applyGlossary(raw)
      doneBytes = covered
      send(final ? { type: 'final', text, fixes } : { type: 'partial', text })
    } catch (err) {
      send({ type: 'error', error: err.message })
    } finally {
      rmSync(file, { force: true })
      busy = false
    }
  }

  const timer = setInterval(() => {
    if (!busy && !ended && bytes - doneBytes > RATE * 2 * 0.3) pass(false)
  }, TICK_MS)

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (ended || bytes > RATE * 2 * MAX_SECONDS) return
      chunks.push(Buffer.from(data)); bytes += data.length
      return
    }
    let msg = {}
    try { msg = JSON.parse(String(data)) } catch {}
    if (msg.type === 'end') {
      ended = true
      clearInterval(timer)
      while (busy) await new Promise((resolve) => setTimeout(resolve, 30))
      if (bytes < RATE * 2 * 0.3) send({ type: 'final', text: '', fixes: [] })
      else await pass(true)
      ws.close()
    }
  })
  ws.on('close', () => { ended = true; clearInterval(timer) })
}

// In-process engine: re-decode the current utterance every ~400 ms with
// Parakeet (tens to hundreds of ms per pass), and lock an utterance in once
// there's a pause, so each pass stays short no matter how long you talk.
function sherpaLive (ws) {
  const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
  let done = '' // finalized text
  let seg = [] // Float32Array chunks of the current utterance
  let segLen = 0
  let decodedLen = 0
  let silentFor = 0 // samples of trailing quiet
  let busy = false
  let ended = false
  const QUIET = 0.012 // RMS below this counts as a pause
  const PAUSE = RATE * 0.7
  const MAX_SEG = RATE * 25

  const join = (a, b) => [a, b].filter(Boolean).join(' ')
  const concat = () => { const out = new Float32Array(segLen); let o = 0; for (const c of seg) { out.set(c, o); o += c.length } return out }

  async function pass ({ finalize = false } = {}) {
    busy = true
    try {
      const covered = segLen
      const text = segLen > RATE * 0.25 ? await transcribeSamples(concat()) : ''
      decodedLen = covered
      if (finalize) {
        done = join(done, text); seg = []; segLen = 0; decodedLen = 0; silentFor = 0
        send({ type: 'partial', text: applyGlossary(done).text })
      } else {
        send({ type: 'partial', text: applyGlossary(join(done, text)).text })
      }
    } catch (err) {
      send({ type: 'error', error: err.message })
    } finally { busy = false }
  }

  const timer = setInterval(() => {
    if (busy || ended) return
    if ((silentFor >= PAUSE && segLen > RATE * 0.5) || segLen >= MAX_SEG) pass({ finalize: true })
    else if (segLen - decodedLen > RATE * 0.25) pass()
  }, 400)

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (ended) return
      const i16 = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      const f = new Float32Array(i16.length)
      let sum = 0
      for (let i = 0; i < i16.length; i++) { f[i] = i16[i] / 32768; sum += f[i] * f[i] }
      const rms = Math.sqrt(sum / (f.length || 1))
      silentFor = rms < QUIET ? silentFor + f.length : 0
      seg.push(f); segLen += f.length
      return
    }
    let msg = {}
    try { msg = JSON.parse(String(data)) } catch {}
    if (msg.type === 'end') {
      ended = true
      clearInterval(timer)
      while (busy) await new Promise((resolve) => setTimeout(resolve, 20))
      await pass({ finalize: true })
      const { text, fixes } = applyGlossary(done)
      send({ type: 'final', text, fixes })
      ws.close()
    }
  })
  ws.on('close', () => { ended = true; clearInterval(timer) })
}

export function attachLive (server, cfg, authorized = () => true) {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/api/live' || !canTranscribe(cfg)) return socket.destroy()
    // our own GUI only (this Mac, or a paired device over Tailscale): no other web page may open the mic socket
    const origin = req.headers.origin
    const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? ''
    const sameOrigin = origin && (origin === `http://${host}` || origin === `https://${host}`)
    if (origin && !sameOrigin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return socket.destroy()
    if (!authorized(req)) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'ready', rate: RATE, engine: sttAvailable() ? 'parakeet' : 'whisper' }))
      if (sttAvailable()) sherpaLive(ws)
      else rolling(cfg, ws)
    })
  })
}
