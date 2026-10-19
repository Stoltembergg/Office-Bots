import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { newSessionAccounts } from './newsession';

const acc = (id: string, extra: Partial<AccountInfo> = {}): AccountInfo => ({ id, short: id.slice(-1).toUpperCase(), name: id, color: '#000', configDir: id, sessions: 0, usageStatus: 'disabled', ...extra });

describe('conta da Nova sessão', () => {
  const accounts = [acc('.claude'), acc('.claude-conta2'), acc('.codex', { provider: 'codex' }), acc('demo:.claude')];

  it('só contas do Claude Code, sem Codex nem demo', () => {
    expect(newSessionAccounts(accounts, undefined, undefined).options.map((a) => a.id)).toEqual(['.claude', '.claude-conta2']);
  });

  it('a escolha da pessoa vence a conta de quem está na sala', () => {
    expect(newSessionAccounts(accounts, '.claude', '.claude-conta2').value).toBe('.claude-conta2');
  });

  it('sem escolha, a conta de quem está na sala; sala vazia, a primeira (a padrão)', () => {
    expect(newSessionAccounts(accounts, '.claude-conta2', undefined).value).toBe('.claude-conta2');
    expect(newSessionAccounts(accounts, undefined, undefined).value).toBe('.claude');
  });

  it('escolha ou conta da sala que não está mais na lista (ou é do Codex) não valem', () => {
    expect(newSessionAccounts(accounts, '.codex', '.claude-sumiu').value).toBe('.claude');
    expect(newSessionAccounts([], '.claude', '.claude').value).toBeUndefined();
  });
});
