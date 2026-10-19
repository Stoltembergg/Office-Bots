import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  defaultCursorAuthPath,
  fetchCurrentPeriodUsage,
  readCursorAuth,
  usageFromPeriodResponse,
  loadCursorUsage,
} from './usage';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('cursor usage', () => {
  it('defaultCursorAuthPath respeita HABBLAUD_CURSOR_AUTH', () => {
    expect(defaultCursorAuthPath({ HABBLAUD_CURSOR_AUTH: '/tmp/auth.json' }, '/home/x')).toBe('/tmp/auth.json');
    expect(defaultCursorAuthPath({}, '/home/x')).toBe('/home/x/.config/cursor/auth.json');
  });

  it('readCursorAuth lê accessToken e ignora arquivo inválido', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const path = join(tmp.dir, 'auth.json');
    writeFileSync(path, JSON.stringify({ accessToken: ' tok ', refreshToken: 'r' }));
    expect(readCursorAuth(path)).toEqual({ accessToken: 'tok' });
    writeFileSync(path, '{');
    expect(readCursorAuth(path)).toBeUndefined();
    expect(readCursorAuth(join(tmp.dir, 'missing.json'))).toBeUndefined();
  });

  it('usageFromPeriodResponse mapeia auto/api percent e billingCycleEnd', () => {
    const usage = usageFromPeriodResponse(
      {
        enabled: true,
        billingCycleEnd: '1793817921000',
        planUsage: {
          autoPercentUsed: 37.4,
          apiPercentUsed: 99.0,
        },
      },
      1_000,
    );
    expect(usage).toEqual({
      source: 'cursor',
      fetchedAt: 1_000,
      fiveHour: { utilization: 37.4, resetsAt: 1_793_817_921_000 },
      sevenDay: { utilization: 99, resetsAt: 1_793_817_921_000 },
    });
  });

  it('usageFromPeriodResponse ignora enabled=false e plano sem percentuais', () => {
    expect(usageFromPeriodResponse({ enabled: false, planUsage: { autoPercentUsed: 1 } }, 1)).toBeUndefined();
    expect(usageFromPeriodResponse({ enabled: true, planUsage: {} }, 1)).toBeUndefined();
  });

  it('fetchCurrentPeriodUsage devolve JSON em 200 e undefined em erro', async () => {
    const ok = await fetchCurrentPeriodUsage('t', {
      fetch: async () =>
        new Response(JSON.stringify({ enabled: true, planUsage: { autoPercentUsed: 10 } }), { status: 200 }),
    });
    expect(ok).toMatchObject({ planUsage: { autoPercentUsed: 10 } });
    const fail = await fetchCurrentPeriodUsage('t', {
      fetch: async () => new Response('nope', { status: 401 }),
    });
    expect(fail).toBeUndefined();
  });

  it('loadCursorUsage integra auth + fetch + parse', async () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    mkdirSync(join(tmp.dir, '.config', 'cursor'), { recursive: true });
    const authPath = join(tmp.dir, '.config', 'cursor', 'auth.json');
    writeFileSync(authPath, JSON.stringify({ accessToken: 'abc' }));
    const usage = await loadCursorUsage(authPath, {
      now: () => 5_000,
      fetch: async (_url, init) => {
        expect(init.headers).toMatchObject({ Authorization: 'Bearer abc' });
        return new Response(
          JSON.stringify({
            enabled: true,
            billingCycleEnd: '1700000000000',
            planUsage: { autoPercentUsed: 12, apiPercentUsed: 34 },
          }),
          { status: 200 },
        );
      },
    });
    expect(usage).toMatchObject({
      source: 'cursor',
      fetchedAt: 5_000,
      fiveHour: { utilization: 12, resetsAt: 1_700_000_000_000 },
      sevenDay: { utilization: 34, resetsAt: 1_700_000_000_000 },
    });
  });
});
