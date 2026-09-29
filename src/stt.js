// In-process speech-to-text via sherpa-onnx (Apache-2.0; runs on macOS, Linux,
// Windows, Android, iOS). Default model: NVIDIA Parakeet TDT 0.6B v3 (int8,
// CC-BY-4.0: "Parakeet TDT 0.6B v3 by NVIDIA"), 25 European languages.
// Benchmarked on an M1 Max CPU: 0.24 s for 7 s of speech, 0.68 s for 22 s.
//
// Models live in ~/.rkeychat/models; `rkeychat models install` fetches them.
// If no model is present, callers fall back to the Python transcriber.

import { createRequire } from 'node:module'
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { dataDir } from './config.js'

const require = createRequire(import.meta.url)
export const MODELS = [
  {
    id: 'parakeet-v3',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    size: '490 MB',
    credit: 'Parakeet TDT 0.6B v3 by NVIDIA (CC-BY-4.0)'
  }
]

const modelsDir = () => join(dataDir(), 'models')
const modelPath = (m) => join(modelsDir(), m.dir)

export function sttAvailable () { return MODELS.some((m) => existsSync(modelPath(m))) }

let recognizer = null
function load () {
  if (recognizer) return recognizer
  const m = MODELS.find((x) => existsSync(modelPath(x)))
  if (!m) return null
  const sherpa = require('sherpa-onnx-node')
  const dir = modelPath(m)
  const f = readdirSync(dir)
  const pick = (re) => { const hit = f.filter((x) => re.test(x)).sort((a, b) => (/int8/.test(b) ? 1 : 0) - (/int8/.test(a) ? 1 : 0))[0]; return hit && join(dir, hit) }
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/) },
      tokens: pick(/^tokens\.txt$/),
      modelType: 'nemo_transducer',
      numThreads: 4,
      provider: 'cpu',
      debug: 0
    }
  })
  return recognizer
}

// One decode at a time; the async decode keeps the daemon's event loop free.
let queue = Promise.resolve()
export function transcribeSamples (samples, sampleRate = 16000) {
  const job = queue.then(async () => {
    const rec = load()
    if (!rec) throw new Error('no speech model installed (rkeychat models install)')
    const s = rec.createStream()
    s.acceptWaveform({ samples, sampleRate })
    if (rec.decodeAsync) await rec.decodeAsync(s)
    else rec.decode(s)
    return rec.getResult(s).text.trim()
  })
  queue = job.catch(() => {})
  return job
}

// Any audio file → 16 kHz mono float samples (needs ffmpeg for compressed formats).
export function decodeFile (path) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
    const chunks = []
    ff.stdout.on('data', (c) => chunks.push(c))
    ff.on('error', () => reject(new Error('ffmpeg is needed to read compressed audio')))
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('couldn\'t decode the audio'))
      const buf = Buffer.concat(chunks)
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)))
    })
  })
}

export async function transcribeFileLocal (path) {
  return transcribeSamples(await decodeFile(path))
}

// `rkeychat models install`: download + unpack (curl | tar, both standard on macOS/Linux).
export function installModel (id = 'parakeet-v3', log = console.log) {
  const m = MODELS.find((x) => x.id === id)
  if (!m) throw new Error(`unknown model ${id}`)
  if (existsSync(modelPath(m))) { log(`${m.id} already installed`); return Promise.resolve() }
  mkdirSync(modelsDir(), { recursive: true })
  log(`downloading ${m.id} (${m.size}) — ${m.credit}`)
  return new Promise((resolve, reject) => {
    const p = spawn('sh', ['-c', `curl -fL --progress-bar "${m.url}" | tar xj -C "${modelsDir()}"`], { stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('close', (code) => {
      if (code === 0 && existsSync(modelPath(m))) { log('installed'); resolve() } else { rmSync(modelPath(m), { recursive: true, force: true }); reject(new Error('download failed')) }
    })
  })
}
