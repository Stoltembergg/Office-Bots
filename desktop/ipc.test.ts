import { describe, expect, it } from 'vitest';
import { APP_VERSION_CHANNEL, isTrustedIpcSender, registerDesktopIpc } from './ipc';

describe('desktop IPC sender validation', () => {
  const appUrl = 'http://127.0.0.1:43123/';

  it('accepts only the app origin in its top-level trusted web contents', () => {
    expect(isTrustedIpcSender({
      senderUrl: 'http://127.0.0.1:43123/settings',
      trustedUrl: appUrl,
      isMainFrame: true,
      isTrustedWebContents: true,
    })).toBe(true);
  });

  it('rejects external origins, subframes, and other web contents', () => {
    for (const input of [
      { senderUrl: 'https://attacker.example/', trustedUrl: appUrl, isMainFrame: true, isTrustedWebContents: true },
      { senderUrl: appUrl, trustedUrl: appUrl, isMainFrame: false, isTrustedWebContents: true },
      { senderUrl: appUrl, trustedUrl: appUrl, isMainFrame: true, isTrustedWebContents: false },
    ]) {
      expect(isTrustedIpcSender(input)).toBe(false);
    }
  });

  it('exposes only the app version to its own main frame', () => {
    const mainFrame = { url: `${appUrl}settings` };
    const webContents = { getURL: () => appUrl, mainFrame };
    let channel = '';
    let handler: ((event: { sender: unknown; senderFrame: unknown | null }) => unknown) | undefined;
    let removed = '';
    const remove = registerDesktopIpc({
      ipcMain: {
        handle: (registeredChannel, registeredHandler) => {
          channel = registeredChannel;
          handler = registeredHandler;
        },
        removeHandler: (removedChannel) => { removed = removedChannel; },
      },
      getWindow: () => ({ webContents }),
      getAppVersion: () => '1.2.3',
    });

    expect(channel).toBe(APP_VERSION_CHANNEL);
    expect(handler?.({ sender: webContents, senderFrame: mainFrame })).toBe('1.2.3');
    expect(() => handler?.({ sender: {}, senderFrame: mainFrame })).toThrow('Untrusted IPC sender');
    expect(() => handler?.({ sender: webContents, senderFrame: { url: 'https://attacker.example/' } })).toThrow('Untrusted IPC sender');
    remove();
    expect(removed).toBe(APP_VERSION_CHANNEL);
  });
});
