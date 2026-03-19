const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  previewFile: (filePath) => ipcRenderer.invoke('preview-file', filePath),
  findDuplicates: () => ipcRenderer.invoke('find-duplicates'),
  loadCache: (folderPath) => ipcRenderer.invoke('load-cache', folderPath),
  saveCache: (folderPath, result) => ipcRenderer.invoke('save-cache', folderPath, result),
  clearCache: (folderPath) => ipcRenderer.invoke('clear-cache', folderPath),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_e, count) => callback(count)),
  onDuplicateProgress: (callback) => ipcRenderer.on('duplicate-progress', (_e, data) => callback(data)),
  // Settings & updates
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_e, data) => callback(data)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  platform: process.platform
});
