import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupervisor, focusExistingWindow } from './supervisor';
import { startServer } from '../server/app';

describe('desktop supervisor', () => {
  it('waits for server readiness before opening the window', async () => {
    let resolveReady!: (value: { url: string; stop: () => Promise<void> }) => void;
    const readiness = new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
      resolveReady = resolve;
    });
    const order: string[] = [];
    const createWindow = vi.fn(async (url: string) => {
      order.push(`window:${url}`);
      return {
        close: vi.fn(),
        isMinimized: () => false,
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
      };
    });
    const supervisor = createSupervisor({
      startServer: async () => {
        order.push('server:start');
        return readiness;
      },
      createWindow,
    });

    const starting = supervisor.start();
    await Promise.resolve();
    expect(order).toEqual(['server:start']);
    expect(createWindow).not.toHaveBeenCalled();

    resolveReady({ url: 'http://127.0.0.1:43123/', stop: vi.fn(async () => {}) });
    await starting;
    expect(order).toEqual(['server:start', 'window:http://127.0.0.1:43123/']);
  });

  it('restores and focuses the existing window for a second launch', () => {
    const order: string[] = [];
    focusExistingWindow({
      isMinimized: () => true,
      restore: () => order.push('restore'),
      show: () => order.push('show'),
      focus: () => order.push('focus'),
    });
    expect(order).toEqual(['restore', 'show', 'focus']);
  });

  it('reopens a closed macOS window without starting a second server', async () => {
    let destroyed = false;
    const server = { url: 'http://127.0.0.1:43123/', stop: vi.fn(async () => {}) };
    const startServer = vi.fn(async () => server);
    const createWindow = vi.fn(async () => ({
      close: vi.fn(),
      isDestroyed: () => destroyed,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    }));
    const supervisor = createSupervisor({ startServer, createWindow });

    const first = await supervisor.start();
    destroyed = true;
    const reopened = await supervisor.reopenWindow();

    expect(reopened).not.toBe(first);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledTimes(2);
    await supervisor.stop();
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it('waits for agents and reuses their single owned process across windows', async () => {
    const order: string[] = []; let release!: () => void;
    const ready = new Promise<void>(r => { release = r; }); let destroyed = false, starts = 0, stops = 0;
    const supervisor = createSupervisor({
      startAgents: async () => { starts++; await ready; order.push('agents'); return { stop: async () => { stops++; } }; },
      startServer: async () => { order.push('server'); return { url: 'http://localhost', stop: async () => {} }; },
      createWindow: async () => { order.push('window'); return { close() {}, isDestroyed: () => destroyed, isMinimized: () => false, restore() {}, show() {}, focus() {} }; },
    });
    const starting = supervisor.start(); await Promise.resolve(); expect(order).toEqual([]);
    release(); await starting; expect(order).toEqual(['agents', 'server', 'window']);
    destroyed = true; await supervisor.reopenWindow(); expect(starts).toBe(1);
    await supervisor.stop(); expect(stops).toBe(1);
  });
  it('cleans up agents if server startup fails', async () => {
    let stopped = 0;
    const supervisor = createSupervisor({ startAgents: async () => ({ stop: async () => { stopped++; } }),
      startServer: async () => { throw new Error('server failed'); }, createWindow: async () => { throw new Error('must not open'); } });
    await expect(supervisor.start()).rejects.toThrow('server failed'); expect(stopped).toBe(1);
    await supervisor.stop(); expect(stopped).toBe(1);
  });
  it('cleans up both resources even when server cleanup rejects', async () => {
    let agentsStopped = 0;
    const supervisor = createSupervisor({ startAgents: async () => ({ stop: async () => { agentsStopped++; } }),
      startServer: async () => ({ url: 'http://localhost', stop: async () => { throw new Error('cleanup failed'); } }),
      createWindow: async () => { throw new Error('window failed'); } });
    await expect(supervisor.start()).rejects.toThrow('window failed'); expect(agentsStopped).toBe(1);
  });
  it('does not close another listener when its requested port is occupied', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('expected an IP listener');
    const dataDir = mkdtempSync(join(tmpdir(), 'office-bots-server-test-'));

    try {
      await expect(startServer({
        host: '127.0.0.1',
        port: address.port,
        dataDir,
        profile: 'desktop',
        env: { HOME: dataDir, HABBLAUD_UPDATE_CHECK: '0', HABBLAUD_CODEX: '0' },
      })).rejects.toThrow();
      expect(occupied.listening).toBe(true);
    } finally {
      occupied.close();
      await once(occupied, 'close');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
