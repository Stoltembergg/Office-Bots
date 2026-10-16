import { describe, expect, it } from 'vitest';
import { parseOpenCodeUrl } from '../../config';

describe('OpenCode API URL', () => {
  it('accepts a local HTTP origin and rejects remote hosts, credentials and URL paths', () => {
    expect(parseOpenCodeUrl('http://127.0.0.1:4767')).toBe('http://127.0.0.1:4767');
    expect(parseOpenCodeUrl('http://[::1]:4767')).toBe('http://[::1]:4767');
    for (const value of [
      'http://0.0.0.0:4767', 'http://192.168.1.5:4767', 'https://127.0.0.1:4767',
      'http://user:secret@127.0.0.1:4767', 'http://127.0.0.1:4767/api',
      'http://127.0.0.1:4767/?token=secret', 'http://127.0.0.1',
    ]) expect(parseOpenCodeUrl(value)).toBeUndefined();
  });
});
