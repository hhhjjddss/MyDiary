const { contextBridge, ipcRenderer } = require('electron')

let apiToken = ''
try {
  apiToken = ipcRenderer.sendSync('mydiary:api-token') || ''
} catch {}

contextBridge.exposeInMainWorld('myDiary', {
  token: apiToken,
  pickPath: params => ipcRenderer.invoke('pick-path', params),
})
