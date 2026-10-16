// Instalador do serviço systemd (scripts/service-install.ts): geração da unit e planos (funções puras).
// Nada aqui chama o systemctl de verdade nem grava fora de pastas temporárias.
import { describe, expect, it } from 'vitest';
import { buildUnit, isOurUnit, MARK, planInstall, planUninstall, SERVICE_NAME, unitDir, type UnitOptions } from '../../scripts/service-install';

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
    expect(unitDir({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/ana')).toBe('/x/cfg/systemd/user');
    expect(unitDir({}, '/home/ana')).toBe('/home/ana/.config/systemd/user');
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
