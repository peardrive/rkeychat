import './globals.js'
import Hyperswarm from 'hyperswarm'
import dns from 'bare-dns'
const t0 = Date.now(); const step = (s) => console.log(`[${typeof Bare !== 'undefined' ? 'bare' : 'node'} ${((Date.now() - t0) / 1000).toFixed(2)}s] ${s}`)
try { dns.lookup('node1.hyperdht.org', (e, a) => step(`dns node1.hyperdht.org -> ${e ? e.message : a}`)) } catch (e) { step('dns throw ' + e.message) }
const swarm = new Hyperswarm()
await swarm.dht.ready(); step(`dht ready; firewalled=${swarm.dht.firewalled} host=${swarm.dht.host} port=${swarm.dht.port}`)
const d = swarm.join(Buffer.alloc(32, 7), { server: true, client: true })
await d.flushed(); step('topic flushed')
await swarm.destroy(); step('destroyed')
Bare.exit(0)
