import { BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';

export async function createMainWindow(url: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#171724',
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  const trustedOrigin = new URL(url).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    try {
      if (new URL(destination).origin !== trustedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  try {
    await window.loadURL(url);
    window.show();
    return window;
  } catch (error) {
    window.destroy();
    throw error;
  }
}
