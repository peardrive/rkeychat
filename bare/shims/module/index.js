export function createRequire () {
  return (id) => { const e = new Error(`Cannot find module '${id}' (not available on Bare)`); e.code = 'MODULE_NOT_FOUND'; throw e }
}
export default { createRequire }
