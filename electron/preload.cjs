// Preload: the only bridge between the plain-web UI and Electron. The UI is the same page
// a browser tab gets; contextIsolation stays on and there is no Node in the page. What is
// exposed is one fact — "you are inside the desktop app" — so the UI can say so in a debug
// note and skip hints that only make sense in a browser tab.
const { contextBridge, ipcRenderer, webUtils } = require('electron')
contextBridge.exposeInMainWorld('rkc', {
  desktop: true,
  // projects (the new shell at /app/): a dropped folder's path, a native folder picker, open a folder in Finder
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) } catch { return null } },
  pickFolder: () => ipcRenderer.invoke('pick-folder').catch(() => null),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path).catch(() => false),
  // 'granted' | 'denied' | 'restricted' | 'not-determined' on macOS; 'unknown' elsewhere
  micStatus: () => ipcRenderer.invoke('mic-status').catch(() => 'unknown'),
  // first run only (electron/first-run.html): the person's name → config written, daemon started, room shown
  setup: (name) => ipcRenderer.invoke('first-run', name),
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome }
})
