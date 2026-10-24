// Entry point for the standalone web profile. Desktop callers import startServer() from app.ts
// and own the returned stop() lifecycle instead of installing process-wide signal handlers.
import { startServer } from './app';

const running = await startServer({ profile: 'web' });
let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = running.stop().finally(() => process.exit(0));
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
