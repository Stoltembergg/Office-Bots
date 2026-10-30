import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createSaasSessionManager,
  SaasSessionError,
  type SaasSessionStore,
} from './sessions';

interface TestSessionRow {
  readonly githubUserId: string;
  readonly expiresAt: number;
  revokedAt: number | null;
}

/** Process-local persistence used only by these synthetic tests. */
function createInMemorySaasSessionStore(): {
  readonly store: SaasSessionStore;
  readonly rows: Map<string, TestSessionRow>;
} {
  const rows = new Map<string, TestSessionRow>();
  const store: SaasSessionStore = {
    async create(digest, githubUserId, expiresAt): Promise<void> {
      if (rows.has(digest)) throw new Error('synthetic digest collision');
      rows.set(digest, { githubUserId, expiresAt, revokedAt: null });
    },
    async findActive(digest, now): Promise<unknown | undefined> {
      const row = rows.get(digest);
      if (!row || row.revokedAt !== null || row.expiresAt <= now) return undefined;
      return { githubUserId: row.githubUserId, expiresAt: row.expiresAt };
    },
    async revoke(digest, now): Promise<boolean> {
      const row = rows.get(digest);
      if (!row || row.revokedAt !== null || row.expiresAt <= now) return false;
      row.revokedAt = now;
      return true;
    },
  };
  return { store, rows };
}

function createManager(options: {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly store?: SaasSessionStore;
} = {}) {
  const memory = createInMemorySaasSessionStore();
  const manager = createSaasSessionManager({
    store: options.store ?? memory.store,
    ttlMs: options.ttlMs,
    now: options.now,
  });
  return { manager, memory };
}

describe('fundação isolada de sessões SaaS', () => {
  it('cria credencial opaca e guarda somente o digest, sem renovar o TTL absoluto', async () => {
    let now = 10_000;
    const { manager, memory } = createManager({ now: () => now, ttlMs: 5_000 });
    const credentials = await manager.create(42);
    const digest = createHash('sha256').update(credentials.token, 'ascii').digest('hex');

    expect(credentials.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credentials.expiresAt).toBe(15_000);
    expect(memory.rows.get(digest)).toEqual({ githubUserId: '42', expiresAt: 15_000, revokedAt: null });
    expect(memory.rows.has(credentials.token)).toBe(false);

    now = 12_000;
    await expect(manager.get(credentials.token)).resolves.toEqual({ githubUserId: '42', expiresAt: 15_000 });
    now = 15_000;
    await expect(manager.get(credentials.token)).resolves.toBeUndefined();
  });

  it('valida e normaliza o ID estável do GitHub antes de persistir', async () => {
    const store = createInMemorySaasSessionStore();
    const create = vi.spyOn(store.store, 'create');
    const manager = createSaasSessionManager({ store: store.store, now: () => 1_000, ttlMs: 1_000 });

    await expect(manager.create('12345678901234567890')).resolves.toMatchObject({ expiresAt: 2_000 });
    for (const githubUserId of [undefined, null, '', '0', '00042', ' 42', '-42', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123456789012345678901']) {
      await expect(manager.create(githubUserId)).rejects.toMatchObject({ code: 'invalid_identity' });
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('verifica expiração no limite e recusa revogar sessão expirada', async () => {
    let now = 20_000;
    const { manager } = createManager({ now: () => now, ttlMs: 2_000 });
    const credentials = await manager.create('31415');

    now = credentials.expiresAt - 1;
    await expect(manager.get(credentials.token)).resolves.toMatchObject({ expiresAt: credentials.expiresAt });
    now = credentials.expiresAt;
    await expect(manager.get(credentials.token)).resolves.toBeUndefined();
    await expect(manager.revoke(credentials.token)).resolves.toBe(false);
  });

  it('revoga atomicamente e não permite consultas nem revogação repetida', async () => {
    const { manager } = createManager({ now: () => 30_000, ttlMs: 60_000 });
    const credentials = await manager.create('2718');

    await expect(manager.revoke(credentials.token)).resolves.toBe(true);
    await expect(manager.get(credentials.token)).resolves.toBeUndefined();
    await expect(manager.revoke(credentials.token)).resolves.toBe(false);
  });

  it('ignora tokens inválidos sem consultar o store', async () => {
    const memory = createInMemorySaasSessionStore();
    const findActive = vi.spyOn(memory.store, 'findActive');
    const revoke = vi.spyOn(memory.store, 'revoke');
    const { manager } = createManager({ store: memory.store, now: () => 40_000 });

    for (const token of [undefined, null, '', 'short', 'a'.repeat(44), 'x'.repeat(42) + '!']) {
      await expect(manager.get(token)).resolves.toBeUndefined();
      await expect(manager.revoke(token)).resolves.toBe(false);
    }
    expect(findActive).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('falha fechado em erros de persistência e não expõe tokens nem detalhes do store', async () => {
    const tokenMarker = 'synthetic-private-token-marker';
    const store: SaasSessionStore = {
      async create(): Promise<void> {
        throw new Error(`synthetic storage failure containing ${tokenMarker}`);
      },
      async findActive(): Promise<unknown | undefined> {
        throw new Error(`synthetic lookup failure containing ${tokenMarker}`);
      },
      async revoke(): Promise<boolean> {
        throw new Error(`synthetic revocation failure containing ${tokenMarker}`);
      },
    };
    const manager = createSaasSessionManager({ store, now: () => 50_000 });
    const credentials = await createManager({ now: () => 50_000 }).manager.create('1618');

    for (const operation of [
      manager.create('1618'),
      manager.get(credentials.token),
      manager.revoke(credentials.token),
    ]) {
      const failure = await operation.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SaasSessionError);
      expect(failure).toMatchObject({ code: 'store_failure' });
      expect((failure as Error).message).not.toContain(tokenMarker);
      expect((failure as Error).message).not.toContain(credentials.token);
    }
  });

  it('mantém sessões e identidades de usuários distintos separadas', async () => {
    const { manager } = createManager({ now: () => 60_000, ttlMs: 60_000 });
    const first = await manager.create('101');
    const second = await manager.create('202');

    await expect(manager.get(first.token)).resolves.toMatchObject({ githubUserId: '101' });
    await expect(manager.get(second.token)).resolves.toMatchObject({ githubUserId: '202' });
    await manager.revoke(first.token);
    await expect(manager.get(first.token)).resolves.toBeUndefined();
    await expect(manager.get(second.token)).resolves.toMatchObject({ githubUserId: '202' });
  });

  it('falha fechado se o store devolver uma identidade ou expiração malformada', async () => {
    const { manager } = createManager({
      now: () => 70_000,
      store: {
        async create(): Promise<void> {},
        async findActive(): Promise<unknown> {
          return { githubUserId: '0007', expiresAt: 80_000 };
        },
        async revoke(): Promise<boolean> {
          return false;
        },
      },
    });
    const credentials = await createManager({ now: () => 70_000 }).manager.create('7');

    await expect(manager.get(credentials.token)).rejects.toMatchObject({ code: 'store_failure' });
  });
});
