import { describe, expect, it } from 'vitest';
import { KiroTerminalParser } from './terminal';

describe('KiroTerminalParser', () => {
  it('ignora linhas vazias ou inválidas', () => {
    const parser = new KiroTerminalParser();
    expect(parser.push('')).toEqual([]);
    expect(parser.push('   ')).toEqual([]);
    expect(parser.push('{')).toEqual([]);
    expect(parser.push('{"kind": "Unknown"}')).toEqual([]);
  });

  it('converte evento Prompt em TerminalEntry de user', () => {
    const parser = new KiroTerminalParser();
    const line = JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        content: [{ kind: 'text', data: 'Explique a arquitetura do projeto' }],
      },
    });

    const entries = parser.push(line);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe('user');
    if (entries[0].kind === 'user') {
      expect(entries[0].text).toBe('Explique a arquitetura do projeto');
    }
  });

  it('converte evento AssistantMessage com thinking, toolUse e text', () => {
    const parser = new KiroTerminalParser();
    const line = JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        content: [
          { kind: 'thinking', data: { text: 'Analisando o código fonte...' } },
          {
            kind: 'toolUse',
            data: {
              toolUseId: 'call_abc',
              name: 'shell',
              input: { command: 'git status' },
            },
          },
          { kind: 'text', data: 'O repositório está limpo.' },
        ],
      },
    });

    const entries = parser.push(line);
    expect(entries.length).toBe(3);

    expect(entries[0].kind).toBe('thinking');
    if (entries[0].kind === 'thinking') {
      expect(entries[0].text).toBe('Analisando o código fonte...');
    }

    expect(entries[1].kind).toBe('tool');
    if (entries[1].kind === 'tool') {
      expect(entries[1].tool).toBe('shell');
      expect(entries[1].title).toBe('shell(git status)');
    }

    expect(entries[2].kind).toBe('assistant');
    if (entries[2].kind === 'assistant') {
      expect(entries[2].text).toBe('O repositório está limpo.');
    }
  });

  it('converte evento ToolResults em TerminalEntry de result com máscara de segredos', () => {
    const parser = new KiroTerminalParser();
    const line = JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: {
        toolUseId: 'call_abc',
        content: [{ kind: 'text', data: 'Authorization: Bearer secret_token_123456\nArquivos prontos.' }],
        isError: false,
      },
    });

    const entries = parser.push(line);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe('result');
    if (entries[0].kind === 'result') {
      expect(entries[0].toolUseId).toBe('call_abc');
      expect(entries[0].text).toContain('Authorization: ***');
      expect(entries[0].text).not.toContain('secret_token_123456');
    }
  });
});
