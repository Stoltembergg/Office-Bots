import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitHubWebAuth } from '../server/saas/vercel-entry';

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleGitHubWebAuth('session', req, res);
}
