// Run bare-pack under Bare (it segfaults under this Mac's Node 20): give it `process` first.
globalThis.process = require('bare-process')
require('./node_modules/bare-pack/bin.js')
