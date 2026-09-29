// Local transcription through Guy's transcription-and-alignment service
// (~/Anjou/transcription-and-alignment: faster-whisper, stays loaded). Nothing
// leaves the machine. Started on demand; optional (devices without it just
// can't dictate, and memos go out without a transcript).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sttAvailable, transcribeFileLocal } from './stt.js'

const DEFAULT_CMD = join(homedir(), 'Anjou', 'transcription-and-alignment', '.venv', 'bin', 'transcribe-align')

export function transcriberConfig (cfg) {
  const t = cfg.transcriber ?? {}
  return {
    cmd: process.env.RKEYCHAT_TRANSCRIBER ?? t.cmd ?? DEFAULT_CMD,
    port: Number(t.port ?? 7411),
    model: t.model ?? 'base.en'
  }
}

// In-process sherpa-onnx (Parakeet) first; the Python service is the fallback.
export function canTranscribe (cfg) {
  return sttAvailable() || existsSync(transcriberConfig(cfg).cmd)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function healthy (port) {
  try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) })).ok } catch { return false }
}

let starting = null
async function ensureService (cfg) {
  const { cmd, port, model } = transcriberConfig(cfg)
  if (await healthy(port)) return
  if (!existsSync(cmd)) throw new Error('no local transcriber on this device')
  if (!starting) {
    starting = (async () => {
      spawn(cmd, ['serve', '--port', String(port), '--model', model], { detached: true, stdio: 'ignore' }).unref()
      for (let i = 0; i < 120 && !(await healthy(port)); i++) await sleep(500)
      if (!(await healthy(port))) throw new Error('the transcriber didn\'t start')
    })().finally(() => { starting = null })
  }
  await starting
}

// Returns plain text. Dictation-speed settings: no alignment, no snapping.
export async function transcribe (cfg, path) {
  if (sttAvailable()) return transcribeFileLocal(path)
  const { port, model } = transcriberConfig(cfg)
  await ensureService(cfg)
  const res = await fetch(`http://127.0.0.1:${port}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, model, align: false, snap: false })
  })
  const { job } = await res.json()
  for (let i = 0; i < 1200; i++) {
    const j = await (await fetch(`http://127.0.0.1:${port}/jobs/${job}`)).json()
    if (j.state === 'done') return (j.result?.segments ?? []).map((s) => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim()
    if (j.state === 'failed') throw new Error(`transcription failed: ${j.error}`)
    await sleep(150)
  }
  throw new Error('transcription timed out')
}
