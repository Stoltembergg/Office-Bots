// Parser do terminal do DSH e do OpenCode: conversão das linhas dos espelhos em TerminalEntry (formato comum).
import { describe, expect, it } from 'vitest';
import { createDshTerminalParser } from './terminal';
import { createOpencodeTerminalParser } from '../opencode/terminal';

describe('terminal do DSH', () => {
  it('prompt, resposta, ferramenta e resultado', () => {
    const p = createDshTerminalParser();
    expect(p.push(JSON.stringify({ type: 'session', id: 's', createdAt: 1, cwd: '/p' }))).toEqual([]);
    expect(p.push(JSON.stringify({ type: 'user/message', time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'arruma o login' }] } }))[0]).toMatchObject({ kind: 'user', at: 10, text: 'arruma o login' });
    // aviso automático (não foi você digitando) não aparece como prompt
    expect(p.push(JSON.stringify({ type: 'user/message', time: 11, data: { source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'x' }] } }))).toEqual([]);
    expect(p.push(JSON.stringify({ type: 'assistant/message', time: 12, data: { message: { content: [{ type: 'text', text: 'pronto!' }] } } }))[0]).toMatchObject({ kind: 'assistant', at: 12, text: 'pronto!' });
    expect(p.push(JSON.stringify({ type: 'tool/call', time: 13, data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' } }))).toEqual([
      { kind: 'tool', id: 'c1', at: 13, tool: 'pwsh', title: 'pwsh(npm test)', input: 'npm test', inputKind: 'command' },
    ]);
    expect(p.push(JSON.stringify({ type: 'tool/result', time: 14, data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } }))[0]).toMatchObject({ kind: 'result', at: 14, toolUseId: 'c1', text: 'ok' });
    expect(p.push(JSON.stringify({ type: 'approval/asked', time: 15, data: {} }))[0]).toMatchObject({ kind: 'system', level: 'warn' });
    expect(p.push(JSON.stringify({ type: 'turn/end', time: 16, data: { reason: { kind: 'aborted' } } }))[0]).toMatchObject({ kind: 'system', text: 'Turno interrompido' });
    expect(p.push('não é json')).toEqual([]);
  });
});

describe('terminal do OpenCode', () => {
  it('prompt, resposta e ferramenta com resultado embutido', () => {
    const p = createOpencodeTerminalParser();
    expect(p.push(JSON.stringify({ seq: 1, type: 'user', at: 100, data: { text: 'abre o server' } }))).toEqual([
      { kind: 'user', id: 'oc-1', at: 100, text: 'abre o server' },
    ]);
    const out = p.push(
      JSON.stringify({
        seq: 2,
        type: 'assistant',
        at: 200,
        data: {
          content: [
            { type: 'text', text: 'vou ler a pasta' },
            {
              type: 'tool',
              id: 'c1',
              name: 'read',
              state: { status: 'completed', input: { path: 'C:/x' }, content: [{ type: 'text', text: 'a.ts\npackage.json' }] },
            },
          ],
        },
      }),
    );
    expect(out[0]).toMatchObject({ kind: 'assistant', text: 'vou ler a pasta' });
    expect(out[1]).toMatchObject({ kind: 'tool', id: 'c1', title: 'read(C:/x)' });
    expect(out[2]).toMatchObject({ kind: 'result', toolUseId: 'c1', text: 'a.ts\npackage.json' });
    // seq repetida não sai de novo
    expect(p.push(JSON.stringify({ seq: 2, type: 'user', at: 200, data: { text: 'dup' } }))).toEqual([]);
  });
});
