// Conta do Cursor: uma só (.cursor) no MVP, mesmo com várias pastas (a primeira dá o caminho exibido).
// Letra R (o Cursor não tem alias de shell para detectar) e cor da paleta sem repetir as das outras ferramentas.
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';

export const CURSOR_ACCOUNT_ID = '.cursor';

export interface CursorDetectOptions {
  /** Cores já usadas pelas contas do Claude Code e do Codex (não se repetem). */
  taken?: { colors?: Iterable<string> };
}

export function detectCursorAccount(root: string, opts: CursorDetectOptions = {}): DetectedAccount {
  const used = new Set(opts.taken?.colors ?? []);
  const color = ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[used.size % ACCOUNT_COLORS.length];
  return { id: CURSOR_ACCOUNT_ID, provider: 'cursor', configDir: root, short: 'R', name: 'Cursor', color };
}
