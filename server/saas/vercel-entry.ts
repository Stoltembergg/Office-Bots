import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGitHubWebAuthHandlers } from './github-web-auth-handlers.js';
import { createGitHubWebAuthRuntime } from './github-web-auth-runtime.js';

type Operation = 'start' | 'callback' | 'session' | 'logout';

/** Small Vercel Node.js entry point shared by the explicit auth routes. */
export async function handleGitHubWebAuth(
  operation: Operation,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const handlers = createGitHubWebAuthHandlers(createGitHubWebAuthRuntime());
    await handlers[operation](req, res);
  } catch {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const body = JSON.stringify({ error: 'GitHub authentication is unavailable' });
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}
