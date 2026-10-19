// Conta da "Nova sessão" da gaveta da sala: com mais de uma conta do Claude Code, a gaveta mostra um seletor.
import type { AccountInfo } from '../../../shared/types';
import { isCodex } from './provider';

export interface NewSessionAccounts {
  /** Contas do Claude Code em que a sessão pode abrir (as do Codex e as do demo ficam de fora). */
  options: AccountInfo[];
  /** Conta escolhida: a que a pessoa marcou, senão a de quem está na sala, senão a primeira (a padrão vem antes). */
  value: string | undefined;
}

export function newSessionAccounts(accounts: readonly AccountInfo[], roomAccount: string | undefined, picked: string | undefined): NewSessionAccounts {
  const options = accounts.filter((a) => !isCodex(a) && !a.id.startsWith('demo:'));
  const has = (id: string | undefined): id is string => !!id && options.some((a) => a.id === id);
  const value = has(picked) ? picked : has(roomAccount) ? roomAccount : options[0]?.id;
  return { options, value };
}
