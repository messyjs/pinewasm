const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pw', {
  compile: (src) => ipcRenderer.invoke('compile', src),
  run: (payload) => ipcRenderer.invoke('run', payload),
  sweep: (payload) => ipcRenderer.invoke('sweep', payload),
  fetchKlines: (p) => ipcRenderer.invoke('fetch-klines', p),
  genbot: (p) => ipcRenderer.invoke('genbot', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  exportWasm: (src) => ipcRenderer.invoke('export-wasm', src),
  readFile: (kind) => ipcRenderer.invoke('read-file', kind),
});
