export interface ManagedServer {
  url: string;
  stop(): Promise<void>;
}

export interface DesktopWindow {
  close(): void | Promise<void>;
  isDestroyed?(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface SupervisorDependencies {
  startAgents?(): Promise<{ stop(): Promise<void> }>;
  startServer(): Promise<ManagedServer>;
  createWindow(url: string): Promise<DesktopWindow> | DesktopWindow;
}

export interface DesktopSupervisor {
  start(): Promise<DesktopWindow>;
  reopenWindow(): Promise<DesktopWindow>;
  stop(): Promise<void>;
  window(): DesktopWindow | undefined;
}

export function createSupervisor(dependencies: SupervisorDependencies): DesktopSupervisor {
  let server: ManagedServer | undefined;
  let agents: { stop(): Promise<void> } | undefined;
  let mainWindow: DesktopWindow | undefined;
  let windowPromise: Promise<DesktopWindow> | undefined;
  let stopPromise: Promise<void> | undefined;

  function liveWindow(): DesktopWindow | undefined {
    if (mainWindow?.isDestroyed?.()) mainWindow = undefined;
    return mainWindow;
  }

  function ensureWindow(): Promise<DesktopWindow> {
    const current = liveWindow();
    if (current) return Promise.resolve(current);
    if (windowPromise) return windowPromise;

    const pending = (async () => {
      const ownsServer = !server, ownsAgents = !agents;
      try {
        if (!agents && dependencies.startAgents) agents = await dependencies.startAgents();
        const readyServer = server ?? await dependencies.startServer();
        server = readyServer;
        mainWindow = await dependencies.createWindow(readyServer.url);
        return mainWindow;
      } catch (error) {
        const serverToStop = ownsServer ? server : undefined;
        const agentsToStop = ownsAgents ? agents : undefined;
        if (ownsServer) server = undefined;
        if (ownsAgents) agents = undefined;
        await Promise.allSettled([
          Promise.resolve().then(() => serverToStop?.stop()),
          Promise.resolve().then(() => agentsToStop?.stop()),
        ]);
        throw error;
      }
    })();
    windowPromise = pending;
    void pending.then(
      () => { if (windowPromise === pending) windowPromise = undefined; },
      () => { if (windowPromise === pending) windowPromise = undefined; },
    );
    return pending;
  }

  return {
    start() {
      if (stopPromise) return Promise.reject(new Error('Desktop supervisor is stopping'));
      return ensureWindow();
    },
    async reopenWindow() {
      if (stopPromise) throw new Error('Desktop supervisor is stopping');
      return ensureWindow();
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        try {
          await windowPromise;
        } catch {
          // A failed start has no window or ready server to keep alive.
        }
        const windowToClose = liveWindow();
        const serverToStop = server;
        const agentsToStop = agents;
        mainWindow = undefined;
        server = undefined;
        agents = undefined;
        const results = await Promise.allSettled([
          Promise.resolve().then(() => windowToClose?.close()),
          Promise.resolve().then(() => serverToStop?.stop()),
          Promise.resolve().then(() => agentsToStop?.stop()),
        ]);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
      return stopPromise;
    },
    window() {
      return liveWindow();
    },
  };
}

export function focusExistingWindow(window: Pick<DesktopWindow, 'isMinimized' | 'restore' | 'show' | 'focus'>): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
