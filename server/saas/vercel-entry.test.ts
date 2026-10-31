import { afterEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitHubWebAuth } from './vercel-entry.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('logs only a fixed configuration stage when the auth runtime fails', async () => {
  vi.stubEnv('OFFICE_BOT_APP_ORIGIN', 'https://synthetic-secret@example.invalid');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };

  await handleGitHubWebAuth('session', { method: 'GET', headers: {} } as IncomingMessage,
    response as unknown as ServerResponse);

  expect(log).toHaveBeenCalledWith('[office-bots] github auth failure', 'session', 'configuration:origin');
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret');
  expect(response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith('{"error":"GitHub authentication is unavailable"}');
});

it('identifies an invalid database TLS mode without logging the connection string', async () => {
  vi.stubEnv('OFFICE_BOT_APP_ORIGIN', 'https://office-bots.example');
  vi.stubEnv('GITHUB_OAUTH_CALLBACK_URL', 'https://office-bots.example/api/auth/github/callback');
  vi.stubEnv('OFFICE_BOTS_DATABASE_URL', 'postgresql://runtime:synthetic-secret@db.example.invalid/postgres?sslmode=disable');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };

  await handleGitHubWebAuth('session', { method: 'GET', headers: {} } as IncomingMessage,
    response as unknown as ServerResponse);

  expect(log).toHaveBeenCalledWith('[office-bots] github auth failure', 'session', 'configuration:database-sslmode');
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret');
  expect(response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
});
