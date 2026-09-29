import { EventEmitter } from 'events'
export class WebSocketServer extends EventEmitter {
  constructor () { super() }
  handleUpgrade () {}
  close (cb) { cb?.() }
}
export default { WebSocketServer }
