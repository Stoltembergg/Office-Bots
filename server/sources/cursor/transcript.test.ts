import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { parseCursorStore } from './transcript';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeStore(blobs: unknown[], sessionMeta?: Record<string, unknown>): string {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const dir = join(tmp.dir, 'chat');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB);');
  const ins = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  blobs.forEach((b, i) => {
    ins.run(`blob-${i}`, Buffer.from(JSON.stringify(b)));
  });
  // blob binário (ignorado)
  ins.run('bin-1', Buffer.from([0x00, 0x01, 0x02, 0xff]));
  if (sessionMeta) {
    const hex = Buffer.from(JSON.stringify(sessionMeta)).toString('hex');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', hex);
  }
  db.close();
  return path;
}

describe('parseCursorStore', () => {
  it('emite prompt, tool-calls e ignora blobs binários', () => {
    const path = writeStore([
      { role: 'system', content: 'You are an AI coding assistant' },
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_query>\nCorrigir o carrinho\n</user_query>' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '...' },
          {
            type: 'tool-call',
            toolCallId: 'call-read-1',
            toolName: 'Read',
            args: { path: '/projetos/loja/App.tsx' },
            providerOptions: { cursor: { modelName: 'cursor-grok-4.5-high' } },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-shell-1',
            toolName: 'Shell',
            args: { command: 'npm test', description: 'Rodar testes' },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-edit-1',
            toolName: 'StrReplace',
            args: { path: '/projetos/loja/App.tsx', old_string: 'a\nb', new_string: 'a\nb\nc\nd' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-read-1',
            result: 'ok',
          },
        ],
        providerOptions: {
          cursor: {
            highLevelToolCallResult: {
              output: {
                success: {
                  todos: [
                    { id: '1', content: 'Corrigir carrinho', status: 'TODO_STATUS_IN_PROGRESS' },
                    { id: '2', content: 'Testar', status: 'TODO_STATUS_PENDING' },
                  ],
                },
              },
            },
          },
        },
      },
    ], { approvalMode: 'unrestricted', lastUsedModel: 'default' });

    const r = parseCursorStore(path, { idPrefix: '.cursor:c1', endAtMs: 1_000_000 });
    expect(r.maxRowId).toBeGreaterThan(0);
    expect(r.stats.toolCalls).toBe(3);
    expect(r.stats.linesAdded).toBe(4);
    expect(r.stats.linesRemoved).toBe(2);
    expect(r.model).toBe('cursor-grok-4.5-high');
    expect(r.permissionMode).toBe('bypassPermissions');
    expect(r.tasks).toEqual([
      { id: '1', title: 'Corrigir carrinho', status: 'in_progress' },
      { id: '2', title: 'Testar', status: 'pending' },
    ]);

    const kinds = r.activities.map((a) => a.kind);
    expect(kinds).toContain('prompt');
    expect(kinds).toContain('read');
    expect(kinds).toContain('test'); // describeCommand classifica `npm test` como kind test
    expect(kinds).not.toContain('think');

    const read = r.activities.find((a) => a.kind === 'read')!;
    expect(read.id).toBe('.cursor:c1#call-read-1');
    expect(read.text).toMatch(/App\.tsx/);
    expect(read.at).toBeLessThanOrEqual(1_000_000);

    const shell = r.activities.find((a) => a.tool === 'Shell')!;
    expect(shell.kind).toBe('test');
    expect(shell.detail || shell.text).toMatch(/npm test|testes/i);
  });

  it('afterRowId só retorna blobs novos', () => {
    const path = writeStore([
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_query>\nprimeiro\n</user_query>' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-a',
            toolName: 'Glob',
            args: { glob_pattern: '*.ts' },
          },
        ],
      },
    ]);
    const first = parseCursorStore(path, { idPrefix: 'x', endAtMs: 1000 });
    expect(first.activities.some((a) => a.kind === 'prompt')).toBe(true);

    // Reabre e acrescenta um blob
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
      'blob-new',
      Buffer.from(
        JSON.stringify({
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-b',
              toolName: 'Grep',
              args: { pattern: 'TODO' },
            },
          ],
        }),
      ),
    );
    db.close();

    const next = parseCursorStore(path, { idPrefix: 'x', afterRowId: first.maxRowId, endAtMs: 2000 });
    expect(next.activities).toHaveLength(1);
    expect(next.activities[0]?.kind).toBe('search');
    expect(next.activities[0]?.text).toMatch(/TODO/);
  });

  it('arquivo inexistente ou vazio: resultado vazio', () => {
    const r = parseCursorStore('/tmp/habblaud-missing-store-db-xyz.db');
    expect(r.activities).toEqual([]);
    expect(r.maxRowId).toBe(0);
  });
});
