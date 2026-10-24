export interface IpcSenderIdentity {
  senderUrl: string;
  trustedUrl: string;
  isMainFrame: boolean;
  isTrustedWebContents: boolean;
}

export const APP_VERSION_CHANNEL = 'office-bots:app-version';

interface IpcInvokeEvent {
  sender: unknown;
  senderFrame: unknown | null;
}

interface IpcMainLike {
  handle(channel: string, listener: (event: IpcInvokeEvent) => unknown): void;
  removeHandler(channel: string): void;
}

export interface TrustedWindowLike {
  webContents: { getURL(): string };
}

/** Registers the intentionally small renderer API and rejects calls from every other frame/window. */
export function registerDesktopIpc(options: {
  ipcMain: IpcMainLike;
  getWindow(): TrustedWindowLike | undefined;
  getAppVersion(): string;
}): () => void {
  options.ipcMain.handle(APP_VERSION_CHANNEL, (event) => {
    const window = options.getWindow();
    const frame = event.senderFrame as { url?: string } | null;
    const senderMainFrame = (event.sender as { mainFrame?: unknown } | null)?.mainFrame;
    if (!window || !frame || typeof frame.url !== 'string' || !isTrustedIpcSender({
      senderUrl: frame.url,
      trustedUrl: window.webContents.getURL(),
      isMainFrame: event.senderFrame === senderMainFrame,
      isTrustedWebContents: event.sender === window.webContents,
    })) {
      throw new Error('Untrusted IPC sender');
    }
    return options.getAppVersion();
  });
  return () => options.ipcMain.removeHandler(APP_VERSION_CHANNEL);
}

/** Only the main frame of the window created by this app may invoke privileged IPC. */
export function isTrustedIpcSender(identity: IpcSenderIdentity): boolean {
  if (!identity.isMainFrame || !identity.isTrustedWebContents) return false;
  try {
    return new URL(identity.senderUrl).origin === new URL(identity.trustedUrl).origin;
  } catch {
    return false;
  }
}
