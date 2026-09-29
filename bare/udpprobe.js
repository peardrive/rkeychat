import UDX from 'udx-native'
const u = new UDX(); const s = u.createSocket(); s.bind(47001, '0.0.0.0')
s.on('message', (m, a) => { console.log('bare got', m.toString(), 'from', a.host); })
setTimeout(() => { console.log('bare done'); Bare.exit(0) }, 4000)
