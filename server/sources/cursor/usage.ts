// Uso do plano Cursor: GetCurrentPeriodUsage (DashboardService) com o accessToken do CLI.
// Token só no host — nunca entra no snapshot. Poll típico: 60 s (CursorSource).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, UsageWindow } from '../../../shared/types';

export const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

/** Epoch ms: number, numeric string (API Cursor), ou ISO. */
function epochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      return n < 1e12 ? Math.round(n * 1000) : n;
    }
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Default: ~/.config/cursor/auth.json (override: HABBLAUD_CURSOR_AUTH). */
export function defaultCursorAuthPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.HABBLAUD_CURSOR_AUTH?.trim();
  if (override) return override;
  return join(home, '.config', 'cursor', 'auth.json');
}

export function readCursorAuth(path: string): { accessToken: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as { accessToken?: unknown };
    const token = typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
    return token ? { accessToken: token } : undefined;
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function windowFromPercent(pct: number | undefined, resetsAt: number | undefined): UsageWindow | undefined {
  if (pct === undefined) return undefined;
  const w: UsageWindow = { utilization: Math.min(100, Math.max(0, pct)) };
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  return w;
}

/**
 * Normaliza a resposta JSON do DashboardService.
 * fiveHour ← Cursor Models (autoPercentUsed); sevenDay ← Other Models (apiPercentUsed).
 */
export function usageFromPeriodResponse(raw: unknown, fetchedAt: number): AccountUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const body = raw as Record<string, unknown>;
  if (body.enabled === false) return undefined;
  const plan = body.planUsage;
  if (!plan || typeof plan !== 'object') return undefined;
  const p = plan as Record<string, unknown>;
  const resetsAt = epochMs(body.billingCycleEnd);
  const auto = windowFromPercent(num(p.autoPercentUsed), resetsAt);
  const api = windowFromPercent(num(p.apiPercentUsed), resetsAt);
  if (!auto && !api) return undefined;
  const usage: AccountUsage = { source: 'cursor', fetchedAt };
  if (auto) usage.fiveHour = auto;
  if (api) usage.sevenDay = api;
  return usage;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Chama a API; devolve undefined em falha de rede/HTTP/JSON (sem lançar). */
export async function fetchCurrentPeriodUsage(
  accessToken: string,
  opts: { fetch?: FetchFn; url?: string } = {},
): Promise<unknown | undefined> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = opts.url ?? CURSOR_USAGE_URL;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Lê auth, busca uso e normaliza. */
export async function loadCursorUsage(
  authPath: string,
  opts: { fetch?: FetchFn; url?: string; now?: () => number } = {},
): Promise<AccountUsage | undefined> {
  const auth = readCursorAuth(authPath);
  if (!auth) return undefined;
  const raw = await fetchCurrentPeriodUsage(auth.accessToken, opts);
  if (raw === undefined) return undefined;
  return usageFromPeriodResponse(raw, (opts.now ?? Date.now)());
}
