const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  previewFile: (filePath) => ipcRenderer.invoke('preview-file', filePath),
  findDuplicates: (files) => ipcRenderer.invoke('find-duplicates', files),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_e, count) => callback(count)),
  onDuplicateProgress: (callback) => ipcRenderer.on('duplicate-progress', (_e, data) => callback(data)),
  platform: process.platform
});
