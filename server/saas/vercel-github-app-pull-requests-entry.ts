import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGitHubAppPullRequestsHandlers } from './github-app-pull-requests-handlers';
import { createGitHubAppPullRequestsRuntime } from './github-app-pull-requests-runtime';

/** Dedicated read-only endpoint; it does not accept repository selectors or forward to legacy APIs. */
export async function handleGitHubAppPullRequests(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const runtime = createGitHubAppPullRequestsRuntime();
    await createGitHubAppPullRequestsHandlers(runtime).list(req, res);
  } catch {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const body = JSON.stringify({ error: 'Pull request access is unavailable' });
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}
