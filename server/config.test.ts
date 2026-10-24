import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('server profiles', () => {
  it('keeps web defaults while desktop binds locally with isolated state and no World or remote access', () => {
    const home = mkdtempSync(join(tmpdir(), 'office-bots-config-'));
    temporaryDirs.push(home);
    const config = loadConfig({
      HOME: home,
      HABBLAUD_IN_DOCKER: '0',
      HABBLAUD_WORLD: '1',
      HABBLAUD_UPDATE_CHECK: '1',
      HABBLAUD_REMOTE_PORT: '4748',
    }, [], {
      profile: 'desktop',
      host: '127.0.0.1',
      port: 0,
      dataDir: join(home, 'Office Bots'),
    });

    expect(config).toMatchObject({
      profile: 'desktop',
      host: '127.0.0.1',
      port: 0,
      dataDir: join(home, 'Office Bots'),
      updateCheck: false,
      world: { enabled: false },
    });
    expect(config.remote).toBeUndefined();

    const web = loadConfig({ HOME: home, HABBLAUD_IN_DOCKER: '0' }, []);
    expect(web).toMatchObject({ profile: 'web', port: 4747, world: { enabled: true } });
  });

  it('keeps port zero opt-in for web and lets an explicit profile override --dev', () => {
    const home = mkdtempSync(join(tmpdir(), 'office-bots-config-'));
    temporaryDirs.push(home);

    expect(loadConfig({ HOME: home, HABBLAUD_IN_DOCKER: '0', HABBLAUD_PORT: '0' }, []).port).toBe(4747);
    expect(loadConfig({ HOME: home, HABBLAUD_IN_DOCKER: '0' }, ['--dev'], { profile: 'desktop', dev: false })).toMatchObject({
      dev: false,
      world: { enabled: false, dev: false },
    });
  });
});
