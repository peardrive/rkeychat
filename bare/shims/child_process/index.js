import sub from 'bare-subprocess'
export const spawn = (...a) => sub.spawn(...a)
const unavailable = (cmd) => { const e = new Error(`${cmd} isn't available on this device`); e.code = 'ENOENT'; throw e }
export const execFileSync = (cmd) => unavailable(cmd)
export const execSync = (cmd) => unavailable(cmd)
export const execFile = (cmd, ...rest) => { const cb = rest.find((x) => typeof x === 'function'); queueMicrotask(() => cb?.(Object.assign(new Error(`${cmd} isn't available`), { code: 'ENOENT' }))) }
export default { spawn, execFileSync, execSync, execFile }
