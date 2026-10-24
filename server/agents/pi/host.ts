import { isCommand, WorkerFailure } from './protocol';
import { PiBackend } from './sdk';

/** Process-local dispatcher. Cancel/close must remain concurrent with prompt. */
export function serve(backend: PiBackend): void {
  const send = (message: unknown) => { if (process.connected) process.send?.(message); };
  process.on('message', message => {
    if (!isCommand(message)) { process.exitCode = 1; process.disconnect(); return; }
    void (async () => {
      try {
        let result: unknown;
        switch (message.type) {
          case 'create': result = await backend.create(message.config); break;
          case 'prompt': await backend.prompt(message.runtimeSessionId, message.input, message.runId); break;
          case 'cancel': await backend.cancel(message.runtimeSessionId); break;
          case 'close': await backend.close(message.runtimeSessionId); break;
        }
        send({ version: 1, id: message.id, ok: true, ...(result === undefined ? {} : { result }) });
      } catch (error) {
        send({ version: 1, id: message.id, ok: false, code: error instanceof WorkerFailure ? error.code : 'runtime-failed' });
      }
    })();
  });
  // The worker must not survive its owning app. No detached background model job.
  process.once('disconnect', () => process.exit(0));
  send({ version: 1, type: 'ready' });
}
