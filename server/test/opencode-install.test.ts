// Instalador do plugin do OpenCode: descoberta da pasta, marca do nosso arquivo,
// install (com backup e --force), uninstall (só o nosso) e parse dos argumentos.
// Tudo com sistema de arquivos em memória.
import { describe, expect, it } from 'vitest';
import {
  backupName,
  configDirOf,
  habblaudBase,
  isOurPlugin,
  isWslRelease,
  parseArgs,
  PLUGIN_FILE,
  pluginPath,
  run,
  toLocalPath,
} from '../../scripts/opencode-install';

const OURS = '// Plugin do OpenCode para o Habblaud.\nmais código';
const FOREIGN = '// plugin de outro\nmais código';

interface Mem {
  files: Map<string, string>;
  renamed: Array<[string, string]>;
  lines: string[];
}

function mem(files: Record<string, string> = {}): Mem {
  return { files: new Map(Object.entries(files)), renamed: [], lines: [] };
}

function deps(m: Mem, env: Record<string, string | undefined> = {}) {
  return {
    env,
    out: (l: string) => m.lines.push(l),
    now: () => new Date('2026-10-14T05:00:00Z'),
    read: (p: string) => m.files.get(p),
    write: (p: string, t: string) => m.files.set(p, t),
    rename: (f: string, t: string) => {
      m.files.set(t, m.files.get(f)!);
      m.files.delete(f);
      m.renamed.push([f, t]);
    },
    mkdir: (_p: string) => {},
  };
}

describe('opencode:install (peças puras)', () => {
  it('pasta de configuração: OPENCODE_CONFIG_DIR, Windows, WSL e o padrão', () => {
    expect(configDirOf({ OPENCODE_CONFIG_DIR: 'C:\\x' }, 'win32', '', undefined)).toBe('C:\\x');
    expect(configDirOf({}, 'win32', '', undefined)).toBe(undefined);
    // No Linux (onde o teste roda) o join usa "/"; no Windows de verdade sai com "\" — o que importa é a pasta certa.
    expect(configDirOf({ USERPROFILE: 'C:\\Users\\Ana' }, 'win32', '', undefined)).toBe('C:\\Users\\Ana/.config/opencode');
    expect(configDirOf({}, 'linux', '6.6.87.1-microsoft-standard-WSL2', 'C:\\Users\\Ana')).toBe('C:\\Users\\Ana/.config/opencode');
    expect(configDirOf({}, 'linux', '6.6.87.1-microsoft-standard-WSL2', undefined)).toBe(undefined);
    expect(configDirOf({ HOME: '/home/ana' }, 'linux', '6.6-generic', undefined)).toBe('/home/ana/.config/opencode');
    expect(isWslRelease('6.6.87.1-microsoft-standard-WSL2')).toBe(true);
    expect(isWslRelease('6.6-generic')).toBe(false);
    expect(pluginPath('/c').endsWith('habblaud.js')).toBe(true);
  });

  it('caminho local: no WSL, C:\\ vira /mnt/c; fora, volta como veio', () => {
    expect(toLocalPath('C:\\Users\\Ana\\.config', 'linux', '6.6.87.1-microsoft-standard-WSL2')).toBe('/mnt/c/Users/Ana/.config');
    expect(toLocalPath('D:/x', 'linux', '6.6.87.1-microsoft-standard-WSL2')).toBe('/mnt/d/x');
    expect(toLocalPath('C:\\x', 'win32', '')).toBe('C:\\x');
    expect(toLocalPath('/home/ana', 'linux', '6.6-generic')).toBe('/home/ana');
  });

  it('marca do nosso arquivo e nome do backup', () => {
    expect(isOurPlugin(OURS)).toBe(true);
    expect(isOurPlugin(FOREIGN)).toBe(false);
    expect(isOurPlugin('')).toBe(false);
    expect(backupName('/p/habblaud.js', new Date('2026-10-14T05:00:00Z'))).toBe('/p/habblaud.js.habblaud-backup-20261014-050000');
  });

  it('base do Habblaud: URL, porta ou padrão', () => {
    expect(habblaudBase({ HABBLAUD_URL: 'http://x:1/' })).toBe('http://x:1');
    expect(habblaudBase({ HABBLAUD_PORT: '4747' })).toBe('http://127.0.0.1:4747');
    expect(habblaudBase({})).toBe('http://127.0.0.1:4747');
  });

  it('install: grava quando não há; atualiza o nosso com backup; sem --force não encosta no dos outros', async () => {
    const target = '/c/.config/opencode/plugins/habblaud.js';
    const env = { OPENCODE_CONFIG_DIR: '/c/.config/opencode' };
    const withSource = (files: Record<string, string>) => ({ [PLUGIN_FILE]: OURS, ...files });
    // Sem nada: instala.
    const m1 = mem(withSource({}));
    expect(await run({ command: 'install', dryRun: false, force: false }, deps(m1, env))).toBe(0);
    expect(m1.files.get(target)).toBe(OURS);
    // Igual: nada muda.
    const m2 = mem(withSource({ [target]: OURS }));
    expect(await run({ command: 'install', dryRun: false, force: false }, deps(m2, env))).toBe(0);
    expect(m2.renamed).toEqual([]);
    // Nosso desatualizado: backup + atualiza.
    const m3 = mem(withSource({ [target]: `${OURS}\nvelho` }));
    expect(await run({ command: 'install', dryRun: false, force: false }, deps(m3, env))).toBe(0);
    expect(m3.files.get(target)).toBe(OURS);
    expect(m3.renamed).toEqual([[target, `${target}.habblaud-backup-20261014-050000`]]);
    // Dos outros: recusa sem --force, troca com --force (e backup).
    const m4 = mem(withSource({ [target]: FOREIGN }));
    expect(await run({ command: 'install', dryRun: false, force: false }, deps(m4, env))).toBe(2);
    expect(m4.files.get(target)).toBe(FOREIGN);
    expect(await run({ command: 'install', dryRun: false, force: true }, deps(m4, env))).toBe(0);
    expect(m4.files.get(target)).toBe(OURS);
    // --dry-run não grava.
    const m5 = mem(withSource({}));
    expect(await run({ command: 'install', dryRun: true, force: false }, deps(m5, env))).toBe(0);
    expect(m5.files.get(target)).toBeUndefined();
  });

  it('uninstall: tira só o nosso (com backup); o dos outros e o ausente ficam', async () => {
    const target = '/c/.config/opencode/plugins/habblaud.js';
    const env = { OPENCODE_CONFIG_DIR: '/c/.config/opencode' };
    const m1 = mem({ [PLUGIN_FILE]: OURS, [target]: OURS });
    expect(await run({ command: 'uninstall', dryRun: false, force: false }, deps(m1, env))).toBe(0);
    expect(m1.files.get(target)).toBeUndefined();
    expect(m1.renamed).toEqual([[target, `${target}.habblaud-backup-20261014-050000`]]);
    const m2 = mem({ [PLUGIN_FILE]: OURS, [target]: FOREIGN });
    expect(await run({ command: 'uninstall', dryRun: false, force: false }, deps(m2, env))).toBe(2);
    expect(m2.files.get(target)).toBe(FOREIGN);
    const m3 = mem({ [PLUGIN_FILE]: OURS });
    expect(await run({ command: 'uninstall', dryRun: false, force: false }, deps(m3, env))).toBe(0);
  });

  it('parseArgs: comandos e opções; sem comando mostra o uso', async () => {
    expect(parseArgs(['install'])).toMatchObject({ command: 'install', dryRun: false, force: false });
    expect(parseArgs(['status', '--config', '/x'])).toMatchObject({ command: 'status', config: '/x' });
    expect(parseArgs(['install', '--dry-run', '--force'])).toMatchObject({ dryRun: true, force: true });
    expect(() => parseArgs(['--x'])).toThrow();
    const m = mem({});
    expect(await run({ dryRun: false, force: false, help: true }, deps(m, {}))).toBe(0);
  });
});
