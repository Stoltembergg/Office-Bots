import path from 'node:path';
import type { ModelSelection } from '../shared/agents/contracts';
import { CatalogStore } from '../server/agents/catalog';
import { SessionManager, SessionError } from '../server/agents/manager';
import { SessionStore } from '../server/agents/sessions';
import { PiRuntime } from '../server/agents/pi/runtime';
import type { ManagedRuntime } from '../server/agents/runtime';

type DesktopRuntime = ManagedRuntime & { initialize(): Promise<void>; stop(): Promise<void> };
/** Owned by Electron main, once per userData directory. Never expose this factory
 * or its paths over HTTP/preload. Account availability remains closed until M3.
 */
export async function startManagedAgents(options: {
  directory: string;
  workerEntry: string;
  isAvailable?: (selection: ModelSelection) => Promise<boolean>;
  createRuntime?: (options: { entry: string; directory: string }) => DesktopRuntime;
}) {
  const runtime = (options.createRuntime ?? (config => new PiRuntime(config)))({ entry: options.workerEntry, directory: path.join(options.directory, 'pi') });
  let manager!: SessionManager;
  const catalog = new CatalogStore(options.directory, id => manager.isAgentBusy(id));
  manager = new SessionManager(catalog, runtime, options.isAvailable ?? (async () => false), new SessionStore(options.directory, catalog));
  try { await runtime.initialize(); await manager.initialize(); }
  catch (error) {
    await runtime.stop().catch(() => undefined);
    throw error instanceof SessionError ? error : new SessionError('runtime-failed');
  }
  let stopping: Promise<void> | undefined;
  return { catalog, manager, runtime,
    stop(): Promise<void> {
      if (stopping) return stopping;
      const drained = manager.shutdown();
      // Attach to the drain immediately; it may fail before process exit. Wait
      // for both before reporting failure so no live worker escapes ownership.
      stopping = Promise.allSettled([Promise.resolve().then(() => runtime.stop()), drained]).then(results => {
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
      });
      return stopping;
    },
  };
}
