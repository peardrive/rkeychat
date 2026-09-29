// Speech-to-text bench: time sherpa-onnx models on a 16 kHz mono WAV.
//   node bench/stt-bench.cjs clip.wav
// Streaming models are fed in 100 ms chunks at "infinite speed" to measure
// compute; the reported first-partial latency is compute only.

const sherpa = require('sherpa-onnx-node')
const fs = require('fs')
const path = require('path')
const os = require('os')

const MODELS = path.join(process.env.RKEYCHAT_DATA || path.join(os.homedir(), '.rkeychat'), 'models')
const wav = sherpa.readWave(process.argv[2])
const secs = wav.samples.length / wav.sampleRate

function files (dir) {
  const f = fs.readdirSync(dir)
  const pick = (re) => { const m = f.filter((x) => re.test(x)).sort((a, b) => (/int8/.test(b) ? 1 : 0) - (/int8/.test(a) ? 1 : 0)); return m[0] && path.join(dir, m[0]) }
  return { encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/), tokens: pick(/^tokens\.txt$/), model: pick(/^model.*\.onnx$/) }
}

function offline (name, extra = {}) {
  const dir = path.join(MODELS, name)
  if (!fs.existsSync(dir)) return console.log(`skip ${name} (not downloaded)`)
  const f = files(dir)
  let t = Date.now()
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, tokens: f.tokens, numThreads: 4, provider: 'cpu', debug: 0, ...extra }
  })
  const load = Date.now() - t
  for (let run = 0; run < 2; run++) {
    t = Date.now()
    const s = rec.createStream()
    s.acceptWaveform({ samples: wav.samples, sampleRate: wav.sampleRate })
    rec.decode(s)
    const text = rec.getResult(s).text
    if (run === 1) console.log(`${name}\n  load ${load} ms · decode ${Date.now() - t} ms for ${secs.toFixed(1)} s audio (${((Date.now() - t) / 1000 / secs).toFixed(3)} RTF)\n  "${text.trim()}"`)
  }
}

function online (name) {
  const dir = path.join(MODELS, name)
  if (!fs.existsSync(dir)) return console.log(`skip ${name} (not downloaded)`)
  const f = files(dir)
  let t = Date.now()
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, tokens: f.tokens, numThreads: 4, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: true
  })
  const load = Date.now() - t
  t = Date.now()
  const s = rec.createStream()
  const step = wav.sampleRate / 10
  let firstPartialAt = null
  let partials = 0
  let last = ''
  for (let i = 0; i < wav.samples.length; i += step) {
    s.acceptWaveform({ samples: wav.samples.subarray(i, i + step), sampleRate: wav.sampleRate })
    while (rec.isReady(s)) rec.decode(s)
    const text = rec.getResult(s).text
    if (text && text !== last) { partials++; last = text; if (firstPartialAt === null) firstPartialAt = i / wav.sampleRate }
  }
  s.acceptWaveform({ samples: new Float32Array(wav.sampleRate * 0.6), sampleRate: wav.sampleRate }) // trailing silence flushes the tail
  s.inputFinished()
  while (rec.isReady(s)) rec.decode(s)
  const total = Date.now() - t
  console.log(`${name}\n  load ${load} ms · all compute ${total} ms for ${secs.toFixed(1)} s audio (${(total / 1000 / secs).toFixed(3)} RTF) · ${partials} partial updates, first after ${firstPartialAt?.toFixed(1)} s of audio\n  "${rec.getResult(s).text.trim()}"`)
}

console.log(`clip: ${process.argv[2]} (${secs.toFixed(1)} s)\n`)
for (const d of fs.readdirSync(MODELS)) {
  if (/streaming/.test(d)) online(d)
  else if (/parakeet|nemo/.test(d)) offline(d, { modelType: 'nemo_transducer' })
}
