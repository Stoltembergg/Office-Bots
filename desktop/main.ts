import { fileURLToPath } from 'node:url';
import { startManagedAgents } from './agents';
import { SessionError } from '../server/agents/manager';
import { app, ipcMain } from 'electron';
import { startServer } from '../server/app';
import { createSupervisor, focusExistingWindow, type DesktopSupervisor } from './supervisor';
import { registerDesktopIpc, type TrustedWindowLike } from './ipc';
import { createBeforeQuitHandler } from './lifecycle';
import { createMainWindow } from './window';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let supervisor: DesktopSupervisor | undefined;
  let agents: Awaited<ReturnType<typeof startManagedAgents>> | undefined;

  const focusMainWindow = async () => {
    if (!supervisor) return;
    try {
      focusExistingWindow(await supervisor.reopenWindow());
    } catch (error) {
      console.error('Unable to restore Office Bots window', error);
    }
  };

  app.on('second-instance', () => { void focusMainWindow(); });
  app.on('activate', () => { void focusMainWindow(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', createBeforeQuitHandler(
    () => supervisor?.stop() ?? Promise.resolve(),
    () => app.quit(),
    (error) => console.error('Unable to stop Office Bots cleanly', error),
  ));

  void app.whenReady().then(async () => {
    app.setName('Office Bots');
    app.setAppUserModelId('com.officebots.app');
    supervisor = createSupervisor({
      startAgents: async () => {
        agents = await startManagedAgents({ directory: app.getPath('userData'), workerEntry: fileURLToPath(new URL('./pi-worker.mjs', import.meta.url)) });
        return agents;
      },
      startServer: () => startServer({
        host: '127.0.0.1',
        port: 0,
        dataDir: app.getPath('userData'),
        profile: 'desktop',
        dev: OFFICE_BOTS_DEV,
      }),
      createWindow: (url) => createMainWindow(url),
    });
    registerDesktopIpc({
      ipcMain,
      getWindow: () => supervisor?.window() as TrustedWindowLike | undefined,
      getAppVersion: () => app.getVersion(),
    });
    await supervisor.start();
    if (process.argv.includes('--office-bots-smoke-test')) {
      if (!agents) throw new SessionError('runtime-failed');
      const session = await agents.runtime.create({ id: 'smoke', agentId: 'smoke-agent', projectId: 'smoke-project', cwd: app.getPath('userData'),
        selection: { providerId: 'openai', accountId: 'not-authorized-smoke', modelId: 'gpt-4.1', thinkingLevel: 'off' } });
      await agents.runtime.close(session.runtimeSessionId);
      console.log('OFFICE_BOTS_PI_WORKER_SMOKE_OK');
      console.log('OFFICE_BOTS_DESKTOP_SMOKE_OK');
      app.quit();
    }
  }).catch(async (error: unknown) => {
    console.error('Unable to start Office Bots', error);
    process.exitCode = 1;
    await supervisor?.stop();
    app.quit();
  });
}

declare const OFFICE_BOTS_DEV: boolean;
