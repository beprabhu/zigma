// Bridge for the Set Server URL dialog — exposes exactly one call, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zigma', {
  setServerUrl: (value) => ipcRenderer.invoke('zigma:set-server-url', value),
});
