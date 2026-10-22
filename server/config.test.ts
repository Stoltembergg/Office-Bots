// Flags de fontes em loadConfig: HABBLAUD_CURSOR liga/desliga a fonte do Cursor (ligada por padrão, como a do Codex).
import { describe, expect, it } from 'vitest';
import { loadConfig, parseIdleLeave } from './config';
import { tempDir } from './test/fixtures';

describe('loadConfig: cursor', () => {
  it('ligado por padrão; HABBLAUD_CURSOR=0 desliga', () => {
    const tmp = tempDir();
    try {
      const cursor = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: tmp.dir, HABBLAUD_IN_DOCKER: '0', ...env }, []).cursor;
      expect(cursor({})).toBe(true);
      expect(cursor({ HABBLAUD_CURSOR: '1' })).toBe(true);
      expect(cursor({ HABBLAUD_CURSOR: '0' })).toBe(false);
      expect(cursor({ HABBLAUD_CURSOR: 'off' })).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('HABBLAUD_IDLE_LEAVE_MIN', () => {
  it('minutos em ms; vazio, zero, negativo ou texto desligam', () => {
    expect(parseIdleLeave('10')).toBe(600_000);
    expect(parseIdleLeave(' 0.5 ')).toBe(30_000);
    for (const v of [undefined, '', '0', '-3', 'dez']) expect(parseIdleLeave(v)).toBe(0);
  });
});
