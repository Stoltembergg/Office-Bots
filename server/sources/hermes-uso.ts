// Fonte "sessões do Hermes" (fase 4 do time-de-agentes, item 4.3): uso por assinatura e personas.
//
// Lê, SÓ LEITURA (SQLite aberto com readOnly, o mesmo que `mode=ro`), os bancos de sessão dos perfis:
//   <HERMES_ROOT>/state.db                 -> perfil "default"
//   <HERMES_ROOT>/profiles/<perfil>/state.db
// e o arquivo de cota do Antigravity (~/.local/state/agy-cota.tsv, uma linha por coleta).
//
// REGRA DE PRIVACIDADE (spec time-de-agentes, PROIBIDO): só colunas de metadado. Este arquivo NÃO pode ler o
// conteúdo das conversas nem quem conversa: a tabela de mensagens, o prompt de sistema, o título da sessão, o id
// do chat e o id do usuário ficam de fora. As consultas só usam as colunas das listas abaixo (COLUNAS_*), sem `*`;
// o teste hermes-uso.test.ts falha se aparecer qualquer um desses nomes no código ou nas consultas executadas.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Janelas do painel de uso: 5 h e 7 dias (as mesmas das assinaturas). */
export const CINCO_HORAS_MS = 5 * 3600_000;
export const SETE_DIAS_MS = 7 * 24 * 3600_000;
/** Persona "conversando": última atividade pelo Telegram há menos de 2 min. */
export const CONVERSANDO_MS = 2 * 60_000;

/** Colunas lidas de session_model_usage (uso por modelo/provedor dentro de cada sessão). */
export const COLUNAS_USO = ['billing_provider', 'model', 'input_tokens', 'output_tokens', 'estimated_cost_usd', 'last_seen'] as const;
/** Colunas lidas de sessions (metadado puro). */
export const COLUNAS_SESSOES = [
  'source',
  'model',
  'billing_provider',
  'started_at',
  'ended_at',
  'last_activity_at',
  'input_tokens',
  'output_tokens',
  'estimated_cost_usd',
] as const;

const SQL_USO = `SELECT ${COLUNAS_USO.join(', ')} FROM session_model_usage WHERE last_seen >= ?`;
// Banco antigo sem session_model_usage: cai para os totais da própria sessão.
const SQL_USO_SESSOES =
  'SELECT billing_provider, model, input_tokens, output_tokens, estimated_cost_usd, COALESCE(last_activity_at, started_at) AS last_seen ' +
  'FROM sessions WHERE COALESCE(last_activity_at, started_at) >= ?';
const SQL_ULTIMA = `SELECT ${COLUNAS_SESSOES.join(', ')} FROM sessions ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1`;
const SQL_ULTIMA_TELEGRAM =
  `SELECT ${COLUNAS_SESSOES.join(', ')} FROM sessions WHERE source = 'telegram' ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1`;
const SQL_TEM_TABELA = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?";

/** Todas as consultas que este módulo executa (o teste confere cada uma). */
export const CONSULTAS = [SQL_USO, SQL_USO_SESSOES, SQL_ULTIMA, SQL_ULTIMA_TELEGRAM, SQL_TEM_TABELA] as const;

export interface BancoPerfil {
  perfil: string;
  arquivo: string;
}

export interface UsoProvedor {
  /** billing_provider como está no banco ('' vira 'desconhecido'). */
  provedor: string;
  /** Nome da assinatura: Claude, ChatGPT, Gemini, Grok ou o próprio provedor. */
  rotulo: string;
  tokensEntrada: number;
  tokensSaida: number;
  /** tokensEntrada + tokensSaida. */
  total: number;
  custoEstimadoUsd: number;
  /** Linhas (sessão × modelo) que caíram na janela. */
  registros: number;
  /** Total de tokens por perfil, para ver quem gastou. */
  perfis: Record<string, number>;
}

export interface CotaAgy {
  familia: string;
  /** 'cincoHoras' | 'seteDias' quando reconhecida; senão o texto original da janela. */
  janela: string;
  restantePct: number;
  usadoPct: number;
  /** Quando a janela reinicia (epoch ms), se veio no arquivo. */
  reiniciaEm?: number;
  /** Data/hora da coleta como está no arquivo (hora local do host). */
  coletadoEm: string;
}

export interface PersonaHermes {
  perfil: string;
  /** Última atividade em qualquer fonte (epoch ms). */
  ultimaAtividade?: number;
  ultimaFonte?: string;
  modelo?: string;
  /** Telegram com atividade há menos de 2 min. Só "conversando"/"à toa": nunca o conteúdo. */
  conversando: boolean;
}

export interface UsoHermes {
  geradoEm: number;
  cincoHoras: UsoProvedor[];
  seteDias: UsoProvedor[];
  antigravity: CotaAgy[];
  personas: PersonaHermes[];
  /** Bancos que não abriram (perfil + motivo curto), para o painel avisar em vez de mostrar zero calado. */
  falhas: { perfil: string; erro: string }[];
}

/** billing_provider -> nome da assinatura no painel. */
export function rotuloProvedor(provedor: string): string {
  const p = provedor.toLowerCase();
  if (!p) return 'Desconhecido';
  if (p.startsWith('anthropic') || p.startsWith('claude')) return 'Claude';
  if (p.startsWith('openai') || p.startsWith('chatgpt') || p.startsWith('codex')) return 'ChatGPT';
  if (p.startsWith('google') || p.startsWith('gemini')) return 'Gemini';
  if (p.startsWith('xai') || p.startsWith('grok')) return 'Grok';
  if (p.startsWith('antigravity') || p.startsWith('agy')) return 'Antigravity';
  return provedor;
}

const NOME_OK = /^[A-Za-z0-9._-]+$/;

/** Bancos de sessão debaixo de HERMES_ROOT: state.db (default) + profiles/<p>/state.db. */
export function descobrirBancos(raiz: string): BancoPerfil[] {
  const out: BancoPerfil[] = [];
  const principal = join(raiz, 'state.db');
  if (existsSync(principal)) out.push({ perfil: 'default', arquivo: principal });
  const dir = join(raiz, 'profiles');
  let nomes: string[] = [];
  try {
    nomes = readdirSync(dir).sort();
  } catch {
    nomes = [];
  }
  for (const p of nomes) {
    if (!NOME_OK.test(p)) continue;
    const arq = join(dir, p, 'state.db');
    if (existsSync(arq)) out.push({ perfil: p, arquivo: arq });
  }
  return out;
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

/** Epoch em segundos (REAL do Hermes) -> ms. */
function segParaMs(v: unknown): number | undefined {
  const n = num(v);
  return n > 0 ? Math.round(n * 1000) : undefined;
}

function acumula(mapa: Map<string, UsoProvedor>, perfil: string, linha: Record<string, unknown>): void {
  const provedor = typeof linha.billing_provider === 'string' && linha.billing_provider ? linha.billing_provider : 'desconhecido';
  let u = mapa.get(provedor);
  if (!u) {
    u = { provedor, rotulo: rotuloProvedor(provedor === 'desconhecido' ? '' : provedor), tokensEntrada: 0, tokensSaida: 0, total: 0, custoEstimadoUsd: 0, registros: 0, perfis: {} };
    mapa.set(provedor, u);
  }
  const ent = num(linha.input_tokens);
  const sai = num(linha.output_tokens);
  u.tokensEntrada += ent;
  u.tokensSaida += sai;
  u.total += ent + sai;
  u.custoEstimadoUsd += num(linha.estimated_cost_usd);
  u.registros += 1;
  u.perfis[perfil] = (u.perfis[perfil] ?? 0) + ent + sai;
}

function ordena(mapa: Map<string, UsoProvedor>): UsoProvedor[] {
  return [...mapa.values()]
    .map((u) => ({ ...u, custoEstimadoUsd: Math.round(u.custoEstimadoUsd * 10_000) / 10_000 }))
    .sort((a, b) => b.total - a.total || a.provedor.localeCompare(b.provedor));
}

/**
 * Uso por assinatura nas janelas de 5 h e 7 dias + personas, lendo os bancos indicados.
 * Atribuição à janela pelo `last_seen` da linha (sessão × modelo): os tokens são o acumulado daquela linha.
 */
export function lerUsoBancos(bancos: BancoPerfil[], agora = Date.now()): Omit<UsoHermes, 'antigravity'> {
  const cinco = new Map<string, UsoProvedor>();
  const sete = new Map<string, UsoProvedor>();
  const personas: PersonaHermes[] = [];
  const falhas: UsoHermes['falhas'] = [];
  const corteSete = (agora - SETE_DIAS_MS) / 1000;
  const corteCinco = agora - CINCO_HORAS_MS;

  for (const { perfil, arquivo } of bancos) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(arquivo, { readOnly: true });
      const temUso = !!db.prepare(SQL_TEM_TABELA).get('session_model_usage');
      const linhas = db.prepare(temUso ? SQL_USO : SQL_USO_SESSOES).all(corteSete) as Record<string, unknown>[];
      for (const l of linhas) {
        acumula(sete, perfil, l);
        const visto = segParaMs(l.last_seen);
        if (visto !== undefined && visto >= corteCinco) acumula(cinco, perfil, l);
      }
      const ultima = db.prepare(SQL_ULTIMA).get() as Record<string, unknown> | undefined;
      const tg = db.prepare(SQL_ULTIMA_TELEGRAM).get() as Record<string, unknown> | undefined;
      const quando = (l?: Record<string, unknown>) => segParaMs(l?.last_activity_at) ?? segParaMs(l?.started_at);
      const tgQuando = quando(tg);
      const persona: PersonaHermes = {
        perfil,
        conversando: tgQuando !== undefined && agora - tgQuando < CONVERSANDO_MS && tg?.ended_at == null,
      };
      const uq = quando(ultima);
      if (uq !== undefined) persona.ultimaAtividade = uq;
      if (typeof ultima?.source === 'string') persona.ultimaFonte = ultima.source;
      if (typeof ultima?.model === 'string' && ultima.model) persona.modelo = ultima.model;
      personas.push(persona);
    } catch (err) {
      falhas.push({ perfil, erro: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    } finally {
      try {
        db?.close();
      } catch {
        /* já fechado */
      }
    }
  }
  return { geradoEm: agora, cincoHoras: ordena(cinco), seteDias: ordena(sete), personas, falhas };
}

function janelaAgy(texto: string): string {
  const t = texto.toLowerCase();
  if (t.includes('five hour') || t.includes('5 hour') || t.includes('5h')) return 'cincoHoras';
  if (t.includes('weekly') || t.includes('week') || t.includes('7 day')) return 'seteDias';
  return texto;
}

/**
 * agy-cota.tsv: `data\tfamília\tjanela\trestante%\treinicia_em`, uma linha por coleta (mais nova embaixo).
 * Devolve a ÚLTIMA linha de cada (família, janela). Arquivo ausente ou ilegível -> [].
 */
export function parseCotaAgy(texto: string): CotaAgy[] {
  const ultimas = new Map<string, CotaAgy>();
  for (const bruta of texto.split(/\r?\n/)) {
    const cols = bruta.split('\t').map((c) => c.trim());
    if (cols.length < 4) continue;
    const [coletadoEm, familia, janelaTxt, pctTxt, reinicia] = cols;
    const pct = Number(pctTxt.replace('%', '').replace(',', '.'));
    if (!familia || !janelaTxt || !Number.isFinite(pct)) continue;
    const restantePct = Math.min(100, Math.max(0, pct));
    const cota: CotaAgy = { familia, janela: janelaAgy(janelaTxt), restantePct, usadoPct: 100 - restantePct, coletadoEm };
    const t = reinicia ? Date.parse(reinicia) : NaN;
    if (!Number.isNaN(t)) cota.reiniciaEm = t;
    const chave = `${familia}\u0000${cota.janela}`;
    ultimas.delete(chave); // reinserir mantém a ordem de chegada da coleta mais nova
    ultimas.set(chave, cota);
  }
  return [...ultimas.values()].sort((a, b) => a.familia.localeCompare(b.familia) || a.janela.localeCompare(b.janela));
}

export function lerCotaAgy(arquivo: string | undefined): CotaAgy[] {
  if (!arquivo) return [];
  try {
    return parseCotaAgy(readFileSync(arquivo, 'utf8'));
  } catch {
    return [];
  }
}

export interface OpcoesUsoHermes {
  /** Raiz do Hermes (no container: /hermes, montada read-only). */
  raiz: string;
  /** Caminho do agy-cota.tsv (opcional). */
  cotaAgy?: string;
  /** Cache em ms (padrão 15 s): o painel pode pedir à vontade sem martelar os bancos. */
  cacheMs?: number;
  agora?: () => number;
}

/**
 * Liga a fonte a partir do ambiente: HERMES_ROOT (obrigatória; sem ela a rota responde 404) e
 * ESCRITORIO_AGY_COTA (padrão <home>/.local/state/agy-cota.tsv; no container, monte o arquivo read-only).
 */
export function hermesUsoReader(env: NodeJS.ProcessEnv, home: string): (() => UsoHermes) | undefined {
  const raiz = env.HERMES_ROOT?.trim();
  if (!raiz) return undefined;
  const cotaAgy = env.ESCRITORIO_AGY_COTA?.trim() || join(home, '.local', 'state', 'agy-cota.tsv');
  return criarLeitorUso({ raiz, cotaAgy });
}

/** Leitor com cache curto, para a rota GET /api/hermes/uso. */
export function criarLeitorUso(opts: OpcoesUsoHermes): () => UsoHermes {
  const cacheMs = opts.cacheMs ?? 15_000;
  const agora = opts.agora ?? Date.now;
  let ultimo: UsoHermes | undefined;
  return () => {
    const t = agora();
    if (ultimo && t - ultimo.geradoEm < cacheMs) return ultimo;
    ultimo = { ...lerUsoBancos(descobrirBancos(opts.raiz), t), antigravity: lerCotaAgy(opts.cotaAgy) };
    return ultimo;
  };
}
