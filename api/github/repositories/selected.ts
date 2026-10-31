import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitHubAppRepositories } from '../../../server/saas/vercel-github-app-entry.js';

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGitHubAppRepositories('selectRepository', req, res);
}
