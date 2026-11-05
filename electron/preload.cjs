// Preload: the only bridge between the plain-web UI and Electron. The UI is the same page
// a browser tab gets; contextIsolation stays on and there is no Node in the page. What is
// exposed is one fact — "you are inside the desktop app" — so the UI can say so in a debug
// note and skip hints that only make sense in a browser tab.
const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('rkc', {
  desktop: true,
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome }
})
