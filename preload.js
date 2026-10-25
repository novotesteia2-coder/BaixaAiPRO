'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Ponte do DaVinci Resolve (opcional) e captura do audio do computador
  resolveCall: (action, params) => ipcRenderer.invoke('resolve-call', { action, params }),
  captureSystemAudio: (seconds) => ipcRenderer.invoke('capture-audio', seconds),

  // Pastas / arquivos
  openFolder: (folder) => ipcRenderer.invoke('open-folder', folder),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  getDownloadsDir: () => ipcRenderer.invoke('get-downloads-dir'),
  setDownloadsDir: (dir) => ipcRenderer.invoke('set-downloads-dir', dir),

  // Espelho do cep.fs / cep.process (usado pelo motor Deno)
  fs: {
    writeFile: (p, c) => ipcRenderer.invoke('fs-write', { p, c }),
    readFile: (p) => ipcRenderer.invoke('fs-read', p),
    deleteFile: (p) => ipcRenderer.invoke('fs-delete', p),
    exists: (p) => ipcRenderer.invoke('fs-exists', p),
  },
  process: {
    createProcess: (cmd, args) => ipcRenderer.invoke('proc-create', { cmd, args }),
    isRunning: (pid) => ipcRenderer.invoke('proc-isrunning', pid),
  },
});
