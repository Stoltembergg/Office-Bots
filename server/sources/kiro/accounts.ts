// Descoberta da pasta e contas do Kiro: ~/.kiro ou KIRO_HOME
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DetectedAccount } from '../../accounts/detect';

export const KIRO_COLOR = '#7c3aed'; // Roxo vibrante do Kiro

export function discoverKiroDir(env: NodeJS.ProcessEnv = process.env, home: string = process.env.HOME || ''): string | undefined {
  const custom = env.KIRO_HOME?.trim() || env.KIRO_SESSIONS_DIR?.trim();
  if (custom) {
    const dir = resolve(custom);
    if (existsSync(dir)) return dir;
  }
  const defaultDir = join(home, '.kiro');
  if (existsSync(defaultDir) && statSync(defaultDir).isDirectory()) {
    return defaultDir;
  }
  return undefined;
}

export function detectKiroAccount(kiroDir: string, env: NodeJS.ProcessEnv = process.env): DetectedAccount {
  let plan = env.HABBLAUD_KIRO_PLAN?.trim() || env.KIRO_PLAN?.trim();
  let email = env.HABBLAUD_KIRO_EMAIL?.trim() || env.KIRO_EMAIL?.trim();
  let organization = env.HABBLAUD_KIRO_ORG?.trim() || env.KIRO_ORG?.trim();

  // Se não foi definido por env, tenta ler de arquivos de configuração locais em kiroDir
  if (!plan) {
    const planFiles = [join(kiroDir, 'plan'), join(kiroDir, 'plan.txt')];
    for (const pf of planFiles) {
      if (existsSync(pf)) {
        try {
          const content = readFileSync(pf, 'utf-8').trim();
          if (content) {
            plan = content;
            break;
          }
        } catch {}
      }
    }
  }

  // Tenta ler de ~/.kiro/settings/plan.json ou ~/.kiro/user.json
  const settingsJson = join(kiroDir, 'settings', 'plan.json');
  if (existsSync(settingsJson)) {
    try {
      const data = JSON.parse(readFileSync(settingsJson, 'utf-8'));
      if (typeof data.plan === 'string' && !plan) plan = data.plan.trim();
      if (typeof data.email === 'string' && !email) email = data.email.trim();
      if (typeof data.organization === 'string' && !organization) organization = data.organization.trim();
    } catch {}
  }

  const userJson = join(kiroDir, 'user.json');
  if (existsSync(userJson)) {
    try {
      const data = JSON.parse(readFileSync(userJson, 'utf-8'));
      if (typeof data.plan === 'string' && !plan) plan = data.plan.trim();
      if (typeof data.email === 'string' && !email) email = data.email.trim();
      if (typeof data.organization === 'string' && !organization) organization = data.organization.trim();
    } catch {}
  }

  return {
    id: '.kiro',
    provider: 'kiro',
    configDir: kiroDir,
    short: 'K',
    name: 'Kiro',
    color: KIRO_COLOR,
    ...(plan ? { plan } : {}),
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
  };
}
