// Spike: does pearcore boot on Bare? Account, database, a space, the swarm.
import './globals.js'
import path from 'path'
import os from 'os'

const root = process.env.SPIKE_DIR ?? path.join(os.tmpdir(), 'rkeychat-bare-spike')
process.env.DEFAULT_ACCOUNT_DIR = root
const t0 = Date.now()
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${s}`)

const { createCore } = await import('pearcore/src/core.js')
step('pearcore imported')
const core = await createCore({ rootPath: root })
step('core created')
const accounts = await core.accounts.list()
if (!accounts.some((a) => a.username === 'spike')) { await core.accounts.create('spike', 'spike-password-123'); step('account created') }
const creds = await core.accounts.authenticate('spike', 'spike-password-123')
step(`authenticated; device key ${Buffer.from(creds.publicKey ?? creds.secretKey?.subarray?.(32) ?? []).toString('hex').slice(0, 16)}…`)
const space = await core.space.create({ spaceName: 'bare-spike', permissionRead: true, permissionBroadcast: true })
step(`space created ${space.topicHash.slice(0, 16)}…`)
const list = await core.space.list()
step(`spaces: ${list.length}`)
await core.accounts.logout()
step('logged out, done')
Bare.exit(0)
