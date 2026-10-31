import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitHubWebAuth } from '../../../server/saas/vercel-entry.js';

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGitHubWebAuth('callback', req, res);
}
