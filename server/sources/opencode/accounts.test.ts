// Descoberta das pastas do OpenCode no host. É ela que decide se o `docker:up` monta a pasta CERTA
// numa sessão limpa (depois de reiniciar a máquina, sem env nenhuma).
//
// O bug que estes testes travam: só o primeiro candidato era considerado ($HOME), e no WSL aquele
// `$HOME/.local/share/opencode/habblaud` podia existir com lixo de teste — o `docker:up` montava a
// pasta errada sem nenhum erro e o escritório ficava sem os agentes do OpenCode. Agora todas as raízes
// que passam em isOpenCodeHome entram, incluindo o perfil do Windows em /mnt/c/Users.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { defaultOpenCodeHome, discoverOpenCodeDirs, isOpenCodeHome } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const tmp = (): string => {
  const t = tempDir('habblaud-opencode-acc-');
  cleanups.push(t.cleanup);
  return t.dir;
};

/** Cria `<raiz>/habblaud/sessions` — o que faz uma raiz passar em isOpenCodeHome. */
function fakeData(base: string): string {
  const dir = join(base, 'habblaud');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return dir;
}

/** Isola o teste do /mnt/c/Users da máquina real. */
const SEM_WINDOWS = { HABBLAUD_WIN_PROFILES: '/nao/existe' };

describe('discoverOpenCodeDirs', () => {
  it('HABBLAUD_OPENCODE_DIRS substitui tudo e só precisa existir', () => {
    const dir = tmp();
    expect(discoverOpenCodeDirs({ ...SEM_WINDOWS, HABBLAUD_OPENCODE_DIRS: dir }, '/home/ninguem')).toEqual([dir]);
  });

  it('sem env nenhuma: acha a pasta do $HOME', () => {
    const home = tmp();
    const esperado = fakeData(join(home, '.local', 'share', 'opencode'));
    expect(discoverOpenCodeDirs(SEM_WINDOWS, home)).toEqual([resolve(esperado)]);
  });

  it('sem env e sem candidato algum: vazio (o docker:up avisa em vez de montar a errada)', () => {
    expect(discoverOpenCodeDirs(SEM_WINDOWS, tmp())).toEqual([]);
  });

  it('$HOME com o habblaud/ mas sem sessions/ não passa em isOpenCodeHome', () => {
    const home = tmp();
    mkdirSync(join(home, '.local', 'share', 'opencode', 'habblaud'), { recursive: true });
    expect(discoverOpenCodeDirs(SEM_WINDOWS, home)).toEqual([]);
  });

  it('as DUAS raízes com sessions/ entram, não só a primeira da lista', () => {
    const home = tmp();
    const doHome = fakeData(join(home, '.local', 'share', 'opencode'));
    const dataDir = tmp();
    const porEnv = fakeData(dataDir);
    expect(discoverOpenCodeDirs({ ...SEM_WINDOWS, OPENCODE_DATA_DIR: dataDir }, home)).toEqual([
      resolve(porEnv),
      resolve(doHome),
    ]);
  });

  it('mesma raiz citada duas vezes não vira conta dupla', () => {
    const home = tmp();
    const base = join(home, '.local', 'share', 'opencode');
    const esperado = fakeData(base);
    expect(discoverOpenCodeDirs({ ...SEM_WINDOWS, OPENCODE_DATA_DIR: base }, home)).toEqual([resolve(esperado)]);
  });

  it('USERPROFILE vale como home quando o HOME não tem nada (Windows nativo)', () => {
    const home = tmp();
    const perfil = tmp();
    const esperado = fakeData(join(perfil, '.local', 'share', 'opencode'));
    expect(discoverOpenCodeDirs({ ...SEM_WINDOWS, USERPROFILE: perfil }, home)).toEqual([resolve(esperado)]);
  });

  it('o perfil do Windows visível no WSL entra como candidato', () => {
    const raiz = tmp();
    const esperado = fakeData(join(raiz, 'Teste', '.local', 'share', 'opencode'));
    expect(discoverOpenCodeDirs({ HABBLAUD_WIN_PROFILES: raiz }, tmp())).toEqual([resolve(esperado)]);
  });

  it('HABBLAUD_OPENCODE_DIR é a pasta exata do plugin, sem acrescentar habblaud/', () => {
    const dir = join(tmp(), 'outra', 'habblaud');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    expect(discoverOpenCodeDirs({ ...SEM_WINDOWS, HABBLAUD_OPENCODE_DIR: dir }, tmp())).toEqual([resolve(dir)]);
  });
});

describe('defaultOpenCodeHome', () => {
  it('prefere a primeira raiz que EXISTE, não a primeira da lista', () => {
    const home = tmp();
    // $HOME com o habblaud/ vazio: não pode ganhar da raiz do Windows, que tem sessions/.
    mkdirSync(join(home, '.local', 'share', 'opencode', 'habblaud'), { recursive: true });
    const raiz = tmp();
    const esperado = fakeData(join(raiz, 'Teste', '.local', 'share', 'opencode'));
    expect(defaultOpenCodeHome({ HABBLAUD_WIN_PROFILES: raiz }, home)).toBe(resolve(esperado));
  });

  it('sem nada, cai na do $HOME mesmo não existindo (é o que o aviso do docker:up cita)', () => {
    const home = tmp();
    expect(defaultOpenCodeHome(SEM_WINDOWS, home)).toBe(resolve(join(home, '.local', 'share', 'opencode', 'habblaud')));
  });
});

describe('isOpenCodeHome', () => {
  it('sessions/ ou open-sessions/ bastam; o habblaud/ vazio não', () => {
    const base = join(tmp(), 'x');
    expect(isOpenCodeHome(base)).toBe(false);
    mkdirSync(join(base, 'open-sessions'), { recursive: true });
    expect(isOpenCodeHome(base)).toBe(true);
  });
});
