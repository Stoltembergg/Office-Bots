// Flags de fontes em loadConfig: HABBLAUD_CURSOR liga/desliga a fonte do Cursor (ligada por padrão, como a do Codex).
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
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
