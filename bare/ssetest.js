import './globals.js'
import http from 'http'
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const w = res.write(': hi\n\n'); console.log('first write returned', w)
  let n = 0
  const t = setInterval(() => { const ok = res.write(`data: ${++n}\n\n`); console.log('write', n, 'returned', ok); if (n >= 5) { clearInterval(t); res.end() } }, 1000)
})
srv.listen(24999, '127.0.0.1', () => console.log('listening'))
