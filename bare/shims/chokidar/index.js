// Mobile has no watched folders; pearcore's watcher becomes a no-op that
// answers any method (on, add, removeAllListeners, close, ...) harmlessly.
function watch () {
  const w = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : k === 'close' ? async () => {} : () => w) })
  return w
}
export default { watch }
export { watch }
