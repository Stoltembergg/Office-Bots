import { contextBridge, ipcRenderer } from 'electron';
import { APP_VERSION_CHANNEL } from './ipc';

contextBridge.exposeInMainWorld('officeBots', Object.freeze({
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(APP_VERSION_CHANNEL),
}));
