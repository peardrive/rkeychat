// rKeyChat's daemon on Bare. Same code as desktop (synced into ./core), with
// its own data folder: it must never share keys with the desktop app.
import './globals.js'
import os from 'os'
import path from 'path'

const data = process.env.RKEYCHAT_DATA
if (!data) throw new Error('set RKEYCHAT_DATA to this device\'s own data folder')
if (path.resolve(data) === path.join(os.homedir(), '.rkeychat')) throw new Error('refusing to use the desktop app\'s ~/.rkeychat')

const { runDaemon } = await import('./core/daemon.js')
await runDaemon({ createRoomName: process.env.RKEYCHAT_CREATE })
