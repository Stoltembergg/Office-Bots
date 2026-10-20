// Ferramentas do OpenCode viram as atividades do escritório (mesmo texto e ícone do Claude Code).
import { describe, expect, it } from 'vitest';
import { describeOpenCodeTool } from './activity';

describe('describeOpenCodeTool', () => {
  it('shell vira Bash, com o comando como detalhe', () => {
    const { desc, tool } = describeOpenCodeTool('shell', { command: 'ls -1A' });
    expect(tool).toBe('Bash');
    expect(desc.detail).toBe('ls -1A');
  });

  it('read e edit usam filePath (camelCase do OpenCode) como caminho', () => {
    expect(describeOpenCodeTool('read', { filePath: '/projetos/alfa/README.md' })).toMatchObject({ tool: 'Read', desc: { text: 'Lendo README.md' } });
    expect(describeOpenCodeTool('edit', { filePath: '/projetos/alfa/a.ts' })).toMatchObject({ tool: 'Edit', desc: { text: 'Editando a.ts' } });
  });

  it('task é um subagente (Agent) com a descrição', () => {
    const { desc, tool } = describeOpenCodeTool('task', { description: 'Pesquisar API', prompt: 'texto longo', subagent_type: 'explore' });
    expect(tool).toBe('Agent');
    expect(desc.kind).toBe('delegate');
    expect(desc.text).toContain('Pesquisar API');
  });

  it('ferramenta desconhecida mantém o nome bruto', () => {
    expect(describeOpenCodeTool('frobnicate', { a: 1 })).toEqual({ desc: { kind: 'other', icon: '🛠️', text: 'Usando frobnicate' }, tool: 'frobnicate' });
  });
});
