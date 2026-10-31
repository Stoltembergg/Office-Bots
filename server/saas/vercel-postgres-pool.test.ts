import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), on: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
  query = fake.query;
  connect = fake.connect;
  on = fake.on;
} }));

import { officeBotsPostgresPool } from './vercel-postgres-pool.js';

afterEach(() => {
  vi.restoreAllMocks();
  fake.query.mockReset();
  fake.connect.mockReset();
});

it('classifies database authentication failures without logging credentials or SQL', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const error = Object.assign(new Error('synthetic-secret in driver message'), { code: '28P01' });
  fake.query.mockRejectedValue(error);
  const pool = officeBotsPostgresPool('postgresql://runtime:synthetic-secret@db.example.invalid/postgres?sslmode=require');

  await expect(pool.query('SELECT $1', ['synthetic-secret'])).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith('[office-bots] database failure', 'authentication');
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret');
  expect(JSON.stringify(log.mock.calls)).not.toContain('SELECT');
});

it('does not log unrecognized driver error codes', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  fake.query.mockRejectedValue(Object.assign(new Error('private message'), { code: 'synthetic-secret' }));
  const pool = officeBotsPostgresPool('postgresql://runtime:synthetic-secret@db.example.invalid/postgres?sslmode=require');

  await expect(pool.query('SELECT 1')).rejects.toThrow('private message');
  expect(log).toHaveBeenCalledWith('[office-bots] database failure', 'unknown');
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private message');
});
