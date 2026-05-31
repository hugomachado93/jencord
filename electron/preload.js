import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getScreenAccess: () => ipcRenderer.invoke('get-screen-access'),
});
