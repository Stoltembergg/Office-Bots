import { describe, expect, it } from 'vitest';
import { resumeCommand, shellPlatformOf, shellQuote, type ResumeAccount, type ResumeSession } from './resume';

const ID = '3f2b9c1e-7a4d-4e8b-9a61-2c5d8e0f1b37';

function session(p: Partial<ResumeSession> = {}): ResumeSession {
  return { account: '.claude', sessionId: ID, project: '/home/ana/proj', open: false, ...p };
}

const conta2: ResumeAccount = { id: '.claude-conta2', configDir: '/home/ana/.claude-conta2' };

describe('resumeCommand (Claude Code)', () => {
  it('shellPlatformOf reconhece o formato do caminho', () => {
    expect(shellPlatformOf('/home/a')).toBe('posix');
    expect(shellPlatformOf('C:\\x')).toBe('windows');
    expect(shellPlatformOf('c:/x')).toBe('windows');
    expect(shellPlatformOf('\\\\srv\\x')).toBe('windows');
    expect(shellPlatformOf('rel/x')).toBeUndefined();
    expect(shellPlatformOf('')).toBeUndefined();
    expect(shellPlatformOf(undefined)).toBeUndefined();
  });

  it('shellQuote usa aspas simples e escapa cada aspa simples', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("it's a 'b' c")).toBe("'it'\\''s a '\\''b'\\'' c'");
    expect(shellQuote('')).toBe("''");
  });

  it('conta padrão: cd e claude --resume, sem CLAUDE_CONFIG_DIR e sem precisar da conta', () => {
    expect(resumeCommand(session(), undefined)).toBe(`cd '/home/ana/proj' && claude --resume ${ID}`);
  });

  it('outra conta: CLAUDE_CONFIG_DIR com a pasta da conta antes do claude', () => {
    expect(resumeCommand(session({ account: '.claude-conta2' }), conta2)).toBe(
      `cd '/home/ana/proj' && CLAUDE_CONFIG_DIR='/home/ana/.claude-conta2' claude --resume ${ID}`,
    );
  });

  it('caminhos com espaço, aspas, $, crase, ; e && ficam literais dentro das aspas simples', () => {
    const project = `/home/ana/a b'c $HOME \`x\` ;y && "z" \\w`;
    expect(resumeCommand(session({ project }), undefined)).toBe(
      `cd '/home/ana/a b'\\''c $HOME \`x\` ;y && "z" \\w' && claude --resume ${ID}`,
    );
    expect(resumeCommand(session({ project: "/home/ana/it's a 'b' c" }), undefined)).toBe(
      `cd '/home/ana/it'\\''s a '\\''b'\\'' c' && claude --resume ${ID}`,
    );
    const configDir = `/home/ana/.c'd $X`;
    expect(resumeCommand(session({ account: '.claude-conta2' }), { id: '.claude-conta2', configDir })).toBe(
      `cd '/home/ana/proj' && CLAUDE_CONFIG_DIR='/home/ana/.c'\\''d $X' claude --resume ${ID}`,
    );
  });

  it('sem project (ausente ou vazio) não há comando', () => {
    expect(resumeCommand(session({ project: undefined }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ project: '' }), undefined)).toBeUndefined();
  });

  it('caminho do Windows, relativo ou plataforma windows não geram comando', () => {
    expect(resumeCommand(session({ project: 'C:\\Users\\a\\proj' }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ project: '\\\\srv\\share\\p' }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ project: 'rel/proj' }), undefined)).toBeUndefined();
    expect(resumeCommand(session(), undefined, 'windows')).toBeUndefined();
  });

  it('caractere de controle no project ou no configDir necessário recusa o comando', () => {
    for (const c of ['\n', '\r', '\u0000', '\u0001', '\t', '\u001b', '\u001f', '\u007f']) {
      expect(resumeCommand(session({ project: `/home/ana/p${c}q` }), undefined)).toBeUndefined();
      expect(
        resumeCommand(session({ account: '.claude-conta2' }), { id: '.claude-conta2', configDir: `/home/ana/.c${c}d` }),
      ).toBeUndefined();
    }
  });

  it('sessionId só vale se for UUID (maiúsculas aceitas)', () => {
    expect(resumeCommand(session({ sessionId: 'x' }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ sessionId: '3f2b9c1e' }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ sessionId: `${ID}; rm -rf ~` }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ sessionId: `x; rm -rf ~ ${ID}` }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ sessionId: `x${ID}` }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ sessionId: ID.toUpperCase() }), undefined)).toBe(
      `cd '/home/ana/proj' && claude --resume ${ID.toUpperCase()}`,
    );
  });

  it('conta não padrão desconhecida, com id diferente ou com configDir inválido não gera comando', () => {
    const s = session({ account: '.claude-conta2' });
    expect(resumeCommand(s, undefined)).toBeUndefined();
    expect(resumeCommand(s, { id: '.claude-conta2', configDir: '(demonstração)' })).toBeUndefined();
    expect(resumeCommand(s, { id: '.claude-conta2', configDir: '~/.claude-x' })).toBeUndefined();
    expect(resumeCommand(s, { id: '.claude-conta2', configDir: '' })).toBeUndefined();
    expect(resumeCommand(s, { id: '.claude-conta2', configDir: 'rel/.claude-x' })).toBeUndefined();
    expect(resumeCommand(s, { id: '.claude-outra', configDir: '/home/ana/.claude-outra' })).toBeUndefined();
  });

  it('sessão aberta não gera comando, mesmo com tudo válido', () => {
    expect(resumeCommand(session({ open: true }), undefined)).toBeUndefined();
    expect(resumeCommand(session({ open: true, account: '.claude-conta2' }), conta2)).toBeUndefined();
  });
});

describe('resumeCommand (Codex)', () => {
  const codex = (p: Partial<ResumeSession> = {}) => session({ account: '.codex', provider: 'codex', ...p });

  it('conta .codex: cd e codex resume, sem CODEX_HOME', () => {
    expect(resumeCommand(codex(), undefined)).toBe(`cd '/home/ana/proj' && codex resume ${ID}`);
  });

  it('outra conta do Codex: CODEX_HOME com a pasta da conta antes do codex', () => {
    expect(
      resumeCommand(codex({ account: '.codex-trabalho' }), { id: '.codex-trabalho', configDir: '/home/ana/.codex-trabalho' }),
    ).toBe(`cd '/home/ana/proj' && CODEX_HOME='/home/ana/.codex-trabalho' codex resume ${ID}`);
  });

  it('conta do Codex desconhecida e sessão aberta do Codex não geram comando', () => {
    expect(resumeCommand(codex({ account: '.codex-trabalho' }), undefined)).toBeUndefined();
    expect(resumeCommand(codex({ open: true }), undefined)).toBeUndefined();
  });
});
