const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('myDiary', {
  pickPath: params => ipcRenderer.invoke('pick-path', params),
})
