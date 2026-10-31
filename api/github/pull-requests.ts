import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitHubAppPullRequests } from '../../server/saas/vercel-github-app-pull-requests-entry.js';

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGitHubAppPullRequests(req, res);
}
