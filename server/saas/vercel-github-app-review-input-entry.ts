import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGitHubAppReviewInputHandlers } from './github-app-review-input-handlers';
import { createGitHubAppPullRequestsRuntime } from './github-app-pull-requests-runtime';

/** Prepares a bounded PR input using server-only GitHub credentials; patches are not returned to the browser. */
export async function handleGitHubAppReviewInput(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const runtime = createGitHubAppPullRequestsRuntime();
    await createGitHubAppReviewInputHandlers({ loader: runtime.reviewInputLoader }).prepare(req, res);
  } catch {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const body = JSON.stringify({ error: 'Pull request input is unavailable' });
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}
