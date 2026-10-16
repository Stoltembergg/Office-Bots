// Comando de terminal que reabre uma sessão encerrada do histórico (botão "Copiar comando para retomar"). Função pura:
// só monta texto, não executa nada, não fala com o servidor e não toca no DOM. O texto é para shells POSIX (bash, zsh):
// todo caminho vai entre aspas simples e só um UUID aparece sem aspas. Testada em ui/resume.test.ts.
import type { AccountInfo, RecentSession } from '../../../shared/types';

export type ShellPlatform = 'posix' | 'windows';
export type ResumeSession = Pick<RecentSession, 'account' | 'provider' | 'sessionId' | 'project' | 'open'>;
export type ResumeAccount = Pick<AccountInfo, 'id' | 'configDir'>;

/** Mesma expressão de server/pty/manager.ts (o cliente não importa código do servidor). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Onde a sessão rodou, pelo formato do caminho (o navegador pode não ser a máquina do projeto). */
export function shellPlatformOf(path: string | undefined): ShellPlatform | undefined {
  if (!path) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return 'windows';
  if (path.startsWith('/')) return 'posix';
  return undefined;
}

/** Aspas simples POSIX: nada expande lá dentro; cada `'` vira `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const TOOLS = {
  claude: { bin: 'claude --resume', envVar: 'CLAUDE_CONFIG_DIR', defaultId: '.claude' },
  codex: { bin: 'codex resume', envVar: 'CODEX_HOME', defaultId: '.codex' },
};

/** `cd '<pasta>' && [VAR='<conta>' ]ferramenta <id>`, ou `undefined` quando não dá para montar com segurança. */
export function resumeCommand(
  session: ResumeSession,
  account: ResumeAccount | undefined,
  platform: ShellPlatform | undefined = shellPlatformOf(session.project),
): string | undefined {
  if (session.open) return undefined;
  if (platform !== 'posix') return undefined;
  const project = session.project;
  if (!project || CONTROL_CHARS.test(project)) return undefined;
  if (!SESSION_ID.test(session.sessionId)) return undefined;
  const tool = session.provider === 'codex' ? TOOLS.codex : TOOLS.claude;
  let env = '';
  if (session.account !== tool.defaultId) {
    const dir = account?.id === session.account ? account.configDir : undefined;
    if (!dir || !dir.startsWith('/') || CONTROL_CHARS.test(dir)) return undefined;
    env = `${tool.envVar}=${shellQuote(dir)} `;
  }
  return `cd ${shellQuote(project)} && ${env}${tool.bin} ${session.sessionId}`;
}
