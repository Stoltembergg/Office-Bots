import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitHubAppRepositories } from '../../server/saas/vercel-github-app-entry';

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGitHubAppRepositories('repositories', req, res);
}
