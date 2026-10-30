import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGitHubAppRepositoriesHandlers } from './github-app-repositories-handlers';
import { createGitHubAppRepositoriesRuntime } from './github-app-repositories-runtime';

type Operation = 'authorize' | 'callback' | 'install' | 'repositories' | 'selectRepository';

/** Explicit same-origin Vercel handlers; no legacy local-server API is forwarded here. */
export async function handleGitHubAppRepositories(
  operation: Operation,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const handlers = createGitHubAppRepositoriesHandlers(createGitHubAppRepositoriesRuntime());
    await handlers[operation](req, res);
  } catch {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const body = JSON.stringify({ error: 'GitHub App repository access is unavailable' });
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}
