// Configuração da fonte do OpenCode (parseOpenCodeConfig): ligada só com a URL, senha por arquivo ou variável.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOpenCodeConfig } from './config';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function passwordFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-oc-'));
  dirs.push(dir);
  const file = join(dir, 'server-password');
  writeFileSync(file, content);
  return file;
}

describe('parseOpenCodeConfig', () => {
  it('fica desligada sem HABBLAUD_OPENCODE_URL (e sem aviso)', () => {
    expect(parseOpenCodeConfig({})).toEqual({});
    expect(parseOpenCodeConfig({ HABBLAUD_OPENCODE_URL: '   ' })).toEqual({});
  });

  it('liga com a origem da URL, sem barra no fim', () => {
    expect(parseOpenCodeConfig({ HABBLAUD_OPENCODE_URL: 'http://127.0.0.1:4096/' })).toEqual({ config: { url: 'http://127.0.0.1:4096' } });
  });

  it('lê a senha do arquivo (sem espaços nas pontas)', () => {
    const file = passwordFile('segredo-de-teste\n');
    const r = parseOpenCodeConfig({ HABBLAUD_OPENCODE_URL: 'http://127.0.0.1:4096', HABBLAUD_OPENCODE_PASSWORD_FILE: file });
    expect(r).toEqual({ config: { url: 'http://127.0.0.1:4096', password: 'segredo-de-teste' } });
  });

  it('usa a variável quando não há arquivo, e o arquivo tem prioridade sobre ela', () => {
    const base = { HABBLAUD_OPENCODE_URL: 'http://127.0.0.1:4096' };
    expect(parseOpenCodeConfig({ ...base, HABBLAUD_OPENCODE_PASSWORD: ' pela-variavel ' })).toEqual({ config: { url: 'http://127.0.0.1:4096', password: 'pela-variavel' } });
    const file = passwordFile('pelo-arquivo');
    expect(parseOpenCodeConfig({ ...base, HABBLAUD_OPENCODE_PASSWORD: 'pela-variavel', HABBLAUD_OPENCODE_PASSWORD_FILE: file }).config?.password).toBe('pelo-arquivo');
  });

  it('sem senha (servidor sem basic auth) a configuração não tem password', () => {
    expect(parseOpenCodeConfig({ HABBLAUD_OPENCODE_URL: 'http://127.0.0.1:4096', HABBLAUD_OPENCODE_PASSWORD: '  ' })).toEqual({ config: { url: 'http://127.0.0.1:4096' } });
  });

  it('arquivo de senha ilegível desliga a fonte, com aviso que não mostra a senha', () => {
    const r = parseOpenCodeConfig({ HABBLAUD_OPENCODE_URL: 'http://127.0.0.1:4096', HABBLAUD_OPENCODE_PASSWORD_FILE: join(tmpdir(), 'habblaud-nao-existe', 'senha') });
    expect(r.config).toBeUndefined();
    expect(r.warning).toContain('HABBLAUD_OPENCODE_PASSWORD_FILE');
  });

  it('recusa URL que não é só a origem (ou não é http)', () => {
    for (const url of ['não é url', 'ftp://127.0.0.1:4096', 'http://127.0.0.1:4096/api', 'http://127.0.0.1:4096?x=1', 'http://user:pw@127.0.0.1:4096']) {
      const r = parseOpenCodeConfig({ HABBLAUD_OPENCODE_URL: url });
      expect(r.config, url).toBeUndefined();
      expect(r.warning, url).toContain('HABBLAUD_OPENCODE_URL recusada');
    }
  });
});
