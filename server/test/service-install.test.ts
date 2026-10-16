// Instalador do serviço systemd (scripts/service-install.ts): geração da unit e planos (funções puras).
// Nada aqui chama o systemctl de verdade nem grava fora de pastas temporárias.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUnit,
  defaultExec,
  isOurUnit,
  MARK,
  parseArgs,
  planInstall,
  planUninstall,
  run,
  SERVICE_NAME,
  unitDir,
  type ExecResult,
  type RunContext,
  type RunOptions,
  type UnitOptions,
} from '../../scripts/service-install';
import { tempDir } from './fixtures';

const OPTS: UnitOptions = {
  nodePath: '/usr/bin/node',
  root: '/home/ana/habblaud',
  serverEntry: '/home/ana/habblaud/dist/server/index.js',
  pathEnv: '/usr/local/bin:/usr/bin',
};

describe('service-install.ts: buildUnit', () => {
  it('SVC-01: a unit usa o node, a pasta e o PATH recebidos, sem caminho fixo', () => {
    expect(buildUnit(OPTS)).toBe(
      [
        '# habblaud: npm run service:install',
        '[Unit]',
        'Description=Habblaud (escritório dos agentes) em http://localhost:4747',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'WorkingDirectory=/home/ana/habblaud',
        'Environment="PATH=/usr/local/bin:/usr/bin"',
        'ExecStart="/usr/bin/node" "/home/ana/habblaud/dist/server/index.js"',
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  it('SVC-01: com --port a unit leva HABBLAUD_PORT e a porta na descrição', () => {
    const unit = buildUnit({ ...OPTS, port: 4851 });
    expect(unit).toContain('Environment="HABBLAUD_PORT=4851"\n');
    expect(unit).toContain('Description=Habblaud (escritório dos agentes) em http://localhost:4851\n');
    expect(buildUnit(OPTS)).not.toContain('HABBLAUD_PORT');
  });

  it('SVC-01: quebra de linha em caminho ou PATH é recusada', () => {
    for (const k of ['nodePath', 'root', 'serverEntry', 'pathEnv'] as const) {
      for (const nl of ['\n', '\r']) {
        expect(() => buildUnit({ ...OPTS, [k]: `/a${nl}ExecStartPre=/bin/x` })).toThrow('quebra de linha');
      }
    }
  });

  it('SVC-01: caminhos com espaço, %, $, aspas e barra invertida saem escapados', () => {
    const root = '/home/a b/%h/$x"y\\z';
    const unit = buildUnit({ ...OPTS, nodePath: '/n o/node', root, serverEntry: `${root}/dist/server/index.js`, pathEnv: '/a b:/c%d:/e"f' });
    expect(unit).toContain('WorkingDirectory=/home/a b/%%h/$x"y\\z\n');
    expect(unit).toContain('ExecStart="/n o/node" "/home/a b/%%h/$$x\\"y\\\\z/dist/server/index.js"\n');
    expect(unit).toContain('Environment="PATH=/a b:/c%%d:/e\\"f"\n');
  });
});

describe('service-install.ts: unitDir e marca', () => {
  it('SVC-01: usa $XDG_CONFIG_HOME quando definido, senão ~/.config', () => {
    expect(unitDir({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/ana')).toBe(join('/x/cfg', 'systemd', 'user'));
    expect(unitDir({}, '/home/ana')).toBe(join('/home/ana', '.config', 'systemd', 'user'));
    expect(SERVICE_NAME).toBe('habblaud.service');
  });

  it('SVC-02: só a primeira linha com a marca torna a unit "nossa"', () => {
    expect(isOurUnit(buildUnit(OPTS))).toBe(true);
    expect(isOurUnit(`[Unit]\n${MARK}\n`)).toBe(false);
    expect(isOurUnit('[Unit]\nDescription=feita à mão\n')).toBe(false);
  });
});

describe('service-install.ts: planInstall', () => {
  const wanted = buildUnit(OPTS);
  const other = buildUnit({ ...OPTS, nodePath: '/outro/node' });
  const manual = '[Unit]\nDescription=Habblaud\n[Service]\nExecStart=/usr/bin/node dist/server/index.js\n';

  it('SVC-02: sem unit grava; unit igual não faz nada; unit nossa diferente atualiza', () => {
    expect(planInstall(undefined, wanted, false)).toEqual({ action: 'write', message: 'unit criada' });
    expect(planInstall(wanted, wanted, false)).toEqual({ action: 'none', message: 'já instalado' });
    expect(planInstall(other, wanted, false).action).toBe('update');
  });

  it('SVC-03: unit sem a marca não é tocada sem --force; com --force é trocada', () => {
    const p = planInstall(manual, wanted, false);
    expect(p.action).toBe('skip');
    expect(p.message).toContain('--force');
    expect(planInstall(manual, wanted, true).action).toBe('update');
  });
});

describe('service-install.ts: planUninstall', () => {
  const mine = buildUnit(OPTS);
  const manual = '[Unit]\nDescription=feita à mão\n';

  it('SVC-04: sem unit não faz nada; unit nossa sai; unit sem marca só com --force', () => {
    expect(planUninstall(undefined, false)).toEqual({ action: 'none', message: 'não instalado' });
    expect(planUninstall(mine, false).action).toBe('remove');
    const p = planUninstall(manual, false);
    expect(p.action).toBe('skip');
    expect(p.message).toContain('--force');
    expect(planUninstall(manual, true).action).toBe('remove');
  });
});

// ---------------------------------------------------------------------------------------------
// run(): pasta de units temporária e systemctl/loginctl falsos (nunca toca o systemd de verdade)
// ---------------------------------------------------------------------------------------------

describe('service-install.ts: run', () => {
  let tmp: ReturnType<typeof tempDir>;
  let calls: string[];
  let lines: string[];
  let answers: Record<string, Partial<ExecResult> | (() => Partial<ExecResult>)>;
  let file: string;
  let ctx: RunContext;

  const INSTALL: RunOptions = { command: 'install', dryRun: false, force: false };
  const UNINSTALL: RunOptions = { command: 'uninstall', dryRun: false, force: false };
  const STATUS: RunOptions = { command: 'status', dryRun: false, force: false };

  beforeEach(() => {
    tmp = tempDir('habblaud-service-');
    calls = [];
    lines = [];
    answers = {};
    const root = join(tmp.dir, 'projeto');
    mkdirSync(join(root, 'dist', 'server'), { recursive: true });
    writeFileSync(join(root, 'dist', 'server', 'index.js'), '');
    file = join(tmp.dir, 'cfg', 'systemd', 'user', SERVICE_NAME);
    ctx = {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: join(tmp.dir, 'cfg'), PATH: '/usr/local/bin:/usr/bin' },
      home: tmp.dir,
      user: 'ana',
      nodePath: '/usr/bin/node',
      root,
      serverEntry: join(root, 'dist', 'server', 'index.js'),
      out: (l) => lines.push(l),
      exec: (cmd, args) => {
        const key = [cmd, ...args].join(' ');
        calls.push(key);
        const a = answers[key];
        const given = typeof a === 'function' ? a() : a;
        const dflt: ExecResult = { status: 0, stdout: cmd === 'loginctl' ? 'Linger=no\n' : '', stderr: '' };
        return { ...dflt, ...given };
      },
    };
  });
  afterEach(() => tmp.cleanup());

  const unitFor = (o: Partial<UnitOptions> = {}): string =>
    buildUnit({ nodePath: ctx.nodePath, root: ctx.root, serverEntry: ctx.serverEntry, pathEnv: ctx.env.PATH ?? '', ...o });
  const text = (): string => lines.join('\n');

  it('SVC-02: sem unit grava a unit esperada, recarrega, liga e avisa do linger sem rodá-lo', () => {
    expect(run(INSTALL, ctx)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(unitFor());
    expect(calls).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now habblaud.service',
      'loginctl show-user ana --property=Linger',
    ]);
    expect(text()).toContain('loginctl enable-linger ana');
    expect(calls.some((c) => c.includes('enable-linger'))).toBe(false);
  });

  it('SVC-02: loginctl falhando não avisa do linger e a unit é gravada', () => {
    answers['loginctl show-user ana --property=Linger'] = { status: 1, stdout: 'Linger=no\n', stderr: 'boom' };
    expect(run(INSTALL, ctx)).toBe(0);
    expect(text()).not.toContain('enable-linger');
    expect(readFileSync(file, 'utf8')).toBe(unitFor());
  });

  it('SVC-02: loginctl com saída vazia não avisa do linger e a unit é gravada', () => {
    answers['loginctl show-user ana --property=Linger'] = { status: 0, stdout: '' };
    expect(run(INSTALL, ctx)).toBe(0);
    expect(text()).not.toContain('enable-linger');
    expect(readFileSync(file, 'utf8')).toBe(unitFor());
  });

  it('SVC-02: com o linger ligado não há aviso', () => {
    answers['loginctl show-user ana --property=Linger'] = { stdout: 'Linger=yes\n' };
    expect(run(INSTALL, ctx)).toBe(0);
    expect(text()).not.toContain('enable-linger');
  });

  it('SVC-02: instalar de novo sem mudança não grava nem chama o systemctl', () => {
    run(INSTALL, ctx);
    calls.length = 0;
    lines.length = 0;
    const before = readFileSync(file, 'utf8');
    expect(run(INSTALL, ctx)).toBe(0);
    expect(calls).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(text()).toContain('já instalado');
  });

  it('SVC-02: unit nossa diferente (outro node) é regravada e o serviço reinicia', () => {
    run(INSTALL, ctx);
    calls.length = 0;
    expect(run(INSTALL, { ...ctx, nodePath: '/outro/node' })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(unitFor({ nodePath: '/outro/node' }));
    expect(calls.slice(0, 4)).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable habblaud.service',
      'systemctl --user restart habblaud.service',
    ]);
  });

  it('SVC-02: --dry-run mostra a unit e não grava nem chama o systemctl', () => {
    expect(run({ ...INSTALL, dryRun: true }, ctx)).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
    expect(text()).toContain(unitFor());
  });

  it('SVC-03: fora do Linux sai com 1, diz o motivo e não grava nada', () => {
    expect(run(INSTALL, { ...ctx, platform: 'darwin' })).toBe(1);
    expect(text()).toBe('✗ Só há suporte ao systemd de usuário no Linux (inclui o WSL com systemd); darwin não é suportado ainda.');
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('SVC-03: sem dist/server/index.js sai com 1, manda rodar o build e não grava nada', () => {
    expect(run(INSTALL, { ...ctx, serverEntry: join(ctx.root, 'dist', 'server', 'nada.js') })).toBe(1);
    expect(text()).toContain('npm run build');
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('SVC-03: systemd de usuário que não responde sai com 1, cita o WSL e não grava nada', () => {
    answers['systemctl --user show-environment'] = { status: 1, stderr: 'Failed to connect to bus' };
    expect(run(INSTALL, ctx)).toBe(1);
    expect(text()).toContain('systemd=true');
    expect(text()).toContain('/etc/wsl.conf');
    expect(existsSync(file)).toBe(false);
  });

  it('SVC-03: unit sem a marca não é tocada sem --force', () => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '[Unit]\nDescription=feita à mão\n');
    expect(run(INSTALL, ctx)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('[Unit]\nDescription=feita à mão\n');
    expect(text()).toContain('--force');
    expect(calls).toEqual([]);
    expect(run({ ...INSTALL, force: true }, ctx)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(unitFor());
  });

  it('SVC-03: --port fora de 1..65535 falha com a faixa válida', () => {
    for (const bad of ['0', '65536', 'abc', '4747.5']) expect(() => parseArgs(['install', '--port', bad])).toThrow(/1 e 65535/);
    expect(parseArgs(['install', '--port', '4851'])).toEqual({ command: 'install', dryRun: false, force: false, port: 4851 });
  });

  it('SVC-03: unit nova com enable --now falhando é desfeita e o install seguinte liga tudo', () => {
    answers['systemctl --user enable --now habblaud.service'] = { status: 1, stderr: 'Failed to enable unit: boom' };
    expect(run(INSTALL, ctx)).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(calls[calls.length - 1]).toBe('systemctl --user daemon-reload');
    answers = {};
    calls.length = 0;
    expect(run(INSTALL, ctx)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(unitFor());
    expect(calls).toContain('systemctl --user enable --now habblaud.service');
  });

  it('SVC-03: unit antiga nossa com restart falhando volta ao conteúdo anterior', () => {
    const old = unitFor({ nodePath: '/antigo/node' });
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, old);
    answers['systemctl --user restart habblaud.service'] = { status: 1, stderr: 'boom' };
    expect(run(INSTALL, ctx)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(old);
  });

  it('SVC-03: falha do systemctl mostra o stderr dele e sai com 1', () => {
    answers['systemctl --user enable --now habblaud.service'] = { status: 1, stderr: 'Failed to enable unit: boom' };
    expect(run(INSTALL, ctx)).toBe(1);
    expect(text()).toContain('Failed to enable unit: boom');
  });

  it('SVC-04: uninstall desliga, apaga a unit e só depois recarrega', () => {
    run(INSTALL, ctx);
    calls.length = 0;
    let existedAtReload: boolean | undefined;
    answers['systemctl --user daemon-reload'] = () => {
      existedAtReload = existsSync(file);
      return {};
    };
    expect(run(UNINSTALL, ctx)).toBe(0);
    expect(calls).toEqual(['systemctl --user disable --now habblaud.service', 'systemctl --user daemon-reload']);
    expect(existedAtReload).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('SVC-04: uninstall sem unit não chama systemctl e diz "não instalado"', () => {
    expect(run(UNINSTALL, ctx)).toBe(0);
    expect(text()).toContain('não instalado');
    expect(calls).toEqual([]);
  });

  it('SVC-04: uninstall com disable --now falhando sai com 1, mantém a unit e não recarrega', () => {
    run(INSTALL, ctx);
    calls.length = 0;
    lines.length = 0;
    answers['systemctl --user disable --now habblaud.service'] = { status: 1, stderr: 'falso: disable quebrou' };
    expect(run(UNINSTALL, ctx)).toBe(1);
    expect(text()).toContain('falso: disable quebrou');
    expect(existsSync(file)).toBe(true);
    expect(calls).not.toContain('systemctl --user daemon-reload');
  });

  it('SVC-04: uninstall com daemon-reload falhando sai com 1 e mostra a mensagem', () => {
    run(INSTALL, ctx);
    lines.length = 0;
    answers['systemctl --user daemon-reload'] = { status: 1, stderr: 'falso: reload quebrou' };
    expect(run(UNINSTALL, ctx)).toBe(1);
    expect(text()).toContain('falso: reload quebrou');
  });

  it('SVC-02: instalar sem --port reaproveita a porta da unit e não chama o systemctl', () => {
    expect(run({ ...INSTALL, port: 5000 }, ctx)).toBe(0);
    calls.length = 0;
    lines.length = 0;
    expect(run(INSTALL, ctx)).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('Environment="HABBLAUD_PORT=5000"\n');
    expect(calls).toEqual([]);
    expect(text()).toContain('já instalado');
  });

  it('SVC-04: linger desconhecido mostra "desconhecido" e não sugere enable-linger', () => {
    run(INSTALL, ctx);
    lines.length = 0;
    answers['loginctl show-user ana --property=Linger'] = { status: 0, stdout: '' };
    expect(run(STATUS, ctx)).toBe(0);
    expect(text()).toContain('linger: desconhecido');
    expect(text()).not.toContain('enable-linger');
  });

  it('SVC-04: uninstall de unit sem a marca não toca sem --force', () => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '[Unit]\nDescription=feita à mão\n');
    expect(run(UNINSTALL, ctx)).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(calls).toEqual([]);
    expect(run({ ...UNINSTALL, force: true }, ctx)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('SVC-04: uninstall --dry-run não apaga nem chama o systemctl', () => {
    run(INSTALL, ctx);
    calls.length = 0;
    expect(run({ ...UNINSTALL, dryRun: true }, ctx)).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('SVC-04: status mostra a unit, is-enabled, is-active e o linger', () => {
    run(INSTALL, ctx);
    lines.length = 0;
    answers['systemctl --user is-enabled habblaud.service'] = { stdout: 'enabled\n' };
    answers['systemctl --user is-active habblaud.service'] = { stdout: 'active\n' };
    answers['loginctl show-user ana --property=Linger'] = { stdout: 'Linger=yes\n' };
    expect(run(STATUS, ctx)).toBe(0);
    const t = text();
    expect(t).toContain('habblaud.service');
    expect(t).toContain('gerada por este instalador');
    expect(t).toContain('is-enabled): enabled');
    expect(t).toContain('is-active): active');
    expect(t).toContain('linger: ligado');
    expect(t).not.toContain('difere');
  });

  it('SVC-04: status avisa quando a unit difere da que o install geraria agora (outro node)', () => {
    run(INSTALL, ctx);
    lines.length = 0;
    expect(run(STATUS, { ...ctx, nodePath: '/outro/node' })).toBe(0);
    expect(text()).toContain('npm run service:install');
  });

  it('SVC-04: status não acusa diferença numa unit instalada com --port', () => {
    run({ ...INSTALL, port: 4851 }, ctx);
    lines.length = 0;
    expect(run(STATUS, ctx)).toBe(0);
    expect(text()).not.toContain('difere');
  });

  it('SVC-04: status sem unit diz que não está instalado e sai com 0', () => {
    expect(run(STATUS, ctx)).toBe(0);
    expect(text()).toContain('não instalado');
  });
});

describe('service-install.ts: defaultExec e main', () => {
  it('comando inexistente devolve status null e stderr preenchido', () => {
    const r = defaultExec('/caminho/que/nao/existe-xyz', []);
    expect(r.status).toBeNull();
    expect(r.stderr).not.toBe('');
  });

  it('main de verdade: opção desconhecida sai com 1 e não chama o systemd', () => {
    const root = resolve(__dirname, '..', '..');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/service-install.ts', '--bogus'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('opção desconhecida');
  });
});
