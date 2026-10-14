// Plugin do OpenCode para o Habblaud.
//
// Ele roda NATIVO no Windows, dentro do próprio OpenCode, e escreve os arquivos que a fonte do Habblaud lê
// (server/sources/opencode/):
//
//   sessions/<sessionId>.jsonl       a conversa em JSONL no FORMATO DO CLAUDE CODE;
//   sessions/<sessionId>.meta.json   { sessionId, cwd, parentId, agent, model, title, startedAt };
//   open-sessions/<sessionId>.lock   marcador de presença: existir = sessão aberta.
//
// POR QUE O PLUGIN EXISTE: o OpenCode guarda a conversa num SQLite (`opencode.db`), e o WSL não consegue lê-lo —
// o SQLite precisa de lock de arquivo e a montagem /mnt/c não tem. Quem escreve é o lado do Windows.
//
// COMO ELE TRABALHA (e por que assim): nesta versão do OpenCode o domínio `session` NÃO tem `list()` nem
// `messages()` — não há leitura da conversa em bloco. O que existe são os próprios eventos, e eles carregam o
// texto FINAL de cada pedaço (`session.text.ended`, `session.reasoning.ended`), a chamada e o resultado da
// ferramenta (`session.tool.called` / `session.tool.success`) e o prompt do usuário (`session.inbox.enqueued`).
// Então a conversa é montada a partir desses eventos terminais, nunca dos `.delta` (que sãoravenhas e não
// precisariam ser remontadas). O arquivo é reescrito por inteiro a partir do estado acumulado em memória, então é
// idempotente: rodar de novo sem mudança não escreve nada, e nada duplica.
//
// O setup() roda uma vez por projeto aberto, e todas as instâncias veem os mesmos eventos — por isso o estado é
// por sessão e a escrita é idempotente: as instâncias escrevem exatamente o mesmo conteúdo. O que NÃO é
// idempotente é registrar um pedido de permissão (POST /api/permissions manda um cartão novo a cada projeto
// aberto), então quem assume o pedido é uma só instância, marcada em PERM_ASSUMIDAS.
//
// Nada sai do computador: os dois destinos são 127.0.0.1.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.HABBLAUD_PORT || 4747)
const BASE = process.env.HABBLAUD_URL || `http://127.0.0.1:${PORT}`

/**
 * Pasta que a fonte do Habblaud observa: a MESMA que o servidor enxerga (o docker-up monta em /opencode/<conta>).
 * Padrão: o subdiretório `habblaud/` da pasta de dados do OpenCode — separado de propósito, porque a pasta de
 * dados tem o opencode.db com tokens do provedor, que esta fonte nunca abre.
 */
const DATA_DIR =
  process.env.HABBLAUD_OPENCODE_DIR ||
  join(process.env.OPENCODE_DATA_DIR || join(homedir(), '.local', 'share', 'opencode'), 'habblaud')

const SESSIONS = join(DATA_DIR, 'sessions')
const OPEN = join(DATA_DIR, 'open-sessions')

/** Depois de ociosar, quanto tempo a sessão continua presente sem nenhum evento. */
const IDLE_GRACE_MS = 150_000
/**
 * De quanto em quanto tempo o marcador de presença é renovado. É o que mantém uma sessão ABERTA no escritório
 * mesmo parada (você pensando antes de mandar a próxima mensagem) — o pior caso do Habblaud, em que quase não
 * chega evento nenhum.
 */
const HEARTBEAT_MS = 30_000
/** Espera antes de gravar: os eventos chegam em rajada. */
const COALESCE_MS = 500

mkdirSync(SESSIONS, { recursive: true })
mkdirSync(OPEN, { recursive: true })

const idleTimers = new Map()
const dirty = new Set()

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const log = (...a) => {
  try {
    console.error('[habblaud]', ...a)
  } catch {
    /* nada */
  }
}

// ------------------------------------------------------------------ estado por sessão

/**
 * O que sabemos de cada sessão. `lines` é a conversa em JSONL (formato Claude), reconstruída dos eventos.
 * `texts`/`tools` são os ids já convertidos, para não reescrever o mesmo texto a cada delta.
 */
/**
 * Le o que ja existe em disco para uma sessao: o historico (para nao perder ao recarregar) e os metadados.
 * O OpenCode recarrega o plugin sozinho quando o arquivo dele muda, e sem isto a proxima escrita sobrescrevia
 * o .jsonl so com os eventos novos.
 */
function loadExisting(id, s) {
  try {
    const mp = join(SESSIONS, id + ".meta.json")
    if (existsSync(mp)) {
      const m = JSON.parse(readFileSync(mp, "utf8"))
      if (!s.directory) s.directory = m.cwd
      if (!s.parentId) s.parentId = m.parentId
      if (!s.agent) s.agent = m.agent
      if (!s.model) s.model = m.model
      if (!s.title) s.title = m.title
      if (!s.startedAt) s.startedAt = m.startedAt
    }
  } catch {
    /* sem metadados: o evento trara */
  }
  try {
    const tp = join(SESSIONS, id + ".jsonl")
    if (existsSync(tp)) {
      for (const raw of readFileSync(tp, "utf8").split("\n")) {
        if (!raw.trim()) continue
        try {
          const line = JSON.parse(raw)
          s.lines.push(line)
          // Marca como visto para o replay dos mesmos eventos nao duplicar a linha.
          if (line && line.uuid) s.seen.add('u:' + line.uuid)
        } catch {
          /* linha quebrada: ignora */
        }
      }
    }
  } catch {
    /* sem historico ainda */
  }
}

const sessions = new Map()
function slot(id) {
  let s = sessions.get(id)
  if (!s) {
    s = {
      lines: [],
      seen: new Set(),
      directory: undefined,
      projectId: undefined,
      parentId: undefined,
      agent: undefined,
      model: undefined,
      title: undefined,
      startedAt: undefined,
      dirty: false,
      // Nomes das ferramentas em andamento, por id da chamada: o `session.tool.called` nao traz
      // `name` e quase nenhum `input` tem campo `tool`, entao sem guardar aqui todo `using_tool`
      // dizia "usando Tool" (E.4 / item 4.6). Limpo no proprio resultado da chamada.
      toolNames: new Map(),
    }
    sessions.set(id, s)
    loadExisting(id, s)
  }
  return s
}

const touch = (id) => {
  try {
    const p = join(OPEN, `${id}.lock`)
    writeFileSync(p, '')
    utimesSync(p, new Date(), new Date())
  } catch (err) {
    log('lock:', err.message)
  }
}

const cancelIdle = () => {
  /* sem timer: a presenca agora e mantida pelo batimento */
}

/**
 * Fim de turno: a sessão continua ABERTA (o idle é fim de turno, não de sessão). O marcador NÃO é removido aqui
 * de propósito — com o batimento, uma sessão aberta porém parada continua no escritório, e uma sessão realmente
 * fechada é limpa quando o OpenCode sobe de novo.
 */
const markIdle = () => {
  /* nada a fazer: quem decide a saída é a limpeza da próxima subida */
}

// ------------------------------------------------------------------ conversão

const iso = (ms) => new Date(typeof ms === 'number' && ms > 0 ? ms : Date.now()).toISOString()

const TOOL_NAMES = {
  bash: 'Bash',
  shell: 'Bash',
  edit: 'Edit',
  patch: 'Edit',
  write: 'Write',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  ls: 'LS',
  webfetch: 'WebFetch',
  task: 'Task',
  todowrite: 'TodoWrite',
}
const toolName = (n) => {
  const s = String(n || 'tool')
  return TOOL_NAMES[s.toLowerCase()] || s.charAt(0).toUpperCase() + s.slice(1)
}

function outputText(o) {
  if (o == null) return ''
  if (typeof o === 'string') return o
  try {
    return JSON.stringify(o)
  } catch {
    return String(o)
  }
}

/**
 * O motivo de uma ferramenta que falhou, para o escritório mostrar o erro de verdade.
 *
 * `session.tool.failed` é o ÚNICO evento que traz `error`, no schema `Session.StructuredError`
 * ({ type, message, status?, response? }) — e o próprio OpenCode renderiza só `error.message`.
 * `content` é o que existia antes da falha e serve de último recurso. Como o transcript.ts exibe a
 * PRIMEIRA linha do `content` na atividade, é nele que o motivo precisa entrar.
 */
function failureText(d) {
  const e = d.error
  if (typeof e === 'string') {
    const s = e.trim()
    if (s) return s
  } else if (e && typeof e === 'object') {
    const m = str(e.message)
    if (m) return m
  }
  return outputText(d.content) || 'falhou'
}

/** Acrescenta uma linha uma única vez (o mesmo evento pode chegar por mais de uma instância do plugin). */
function push(s, key, line) {
  if (s.seen.has(key)) return
  s.seen.add(key)
  s.lines.push(line)
  s.dirty = true
}

/**
 * Igual a push, mas substitui a linha de MESMO uuid quando ela ja existe. e o que raciocinio/texto usam:
 * a linha nasce no .started (para o personagem comecar a mostrar "Pensando..." na hora) e o .ended ocupa
 * o mesmo lugar com o texto final. Sem isto o push() descartaria o conteudo final por chave ja vista.
 */
function pushOrReplace(s, key, line) {
  const i = s.lines.findIndex((l) => l.uuid === line.uuid)
  if (i >= 0) {
    s.lines[i] = line
    s.dirty = true
    return
  }
  push(s, key, line)
}

/** Chaves que NUNCA são o conteúdo do prompt (o fallback antigo pegava item.type === "user"). */
const NOT_TEXT = new Set(['type', 'delivery', 'id', 'sessionID', 'role', 'status', 'kind'])

/**
 * O prompt do usuário. `session.inbox.enqueued` traz `item`, e nesta versão o texto está em
 * `item.payload.text` (o resto do item é tipo/delivery/metadata). Procura em ordem decrescente de certeza e,
 * no fim, aceita a string mais longa que não seja metadado — nunca `type`.
 */
function userPromptFrom(item) {
  if (item == null) return undefined
  if (typeof item === 'string') return item
  if (typeof item !== 'object') return undefined

  const payload = item.payload && typeof item.payload === 'object' ? item.payload : undefined
  // 1. O caminho conhecido: item.payload.text
  if (payload) {
    const t = str(payload.text) || str(payload.prompt) || str(payload.content) || str(payload.message)
    if (t) return t
    if (Array.isArray(payload.parts)) {
      const joined = payload.parts
        .map((p) => (typeof p === 'string' ? p : str(p && p.text)))
        .filter(Boolean)
        .join('\n')
      if (joined) return joined
    }
  }
  // 2. No próprio item.
  const direct = str(item.text) || str(item.prompt) || str(item.content) || str(item.message) || str(item.body)
  if (direct) return direct
  if (Array.isArray(item.parts)) {
    const joined = item.parts
      .map((p) => (typeof p === 'string' ? p : str(p && p.text)))
      .filter(Boolean)
      .join('\n')
    if (joined) return joined
  }
  // 3. A maior string que não seja metadado (o item.type === "user" é o que o fallback antigo pegava).
  let best
  for (const [k, v] of Object.entries(item)) {
    if (NOT_TEXT.has(k)) continue
    const s = typeof v === 'string' ? v.trim() : undefined
    if (s && s.length > 3 && (!best || s.length > best.length)) best = s
  }
  return best
}

/** O diretório do projeto: `location` da sessão ou do contexto do plugin. */
function directoryOf(d, fallback) {
  const loc = d && d.location
  if (typeof loc === 'string') return str(loc)
  if (loc && typeof loc === 'object') {
    return str(loc.directory) || str(loc.path) || str(loc.canonical) || (loc.project && str(loc.project.directory))
  }
  const proj = d && d.project
  if (proj && typeof proj === 'object') return str(proj.directory) || str(proj.canonical) || str(proj.path)
  // O fallback e' o `ctx.location` da INSTANCIA: a localizacao em si ({directory, project}), nao um objeto
  // que a CONTENHA. Ler `fallback.location` aqui devolvia undefined, e sem `s.directory` o flush aborta —
  // sem meta, sem transcript, sem agente no escritorio, e qualquer pedido de permissao da sessao voltava
  // `unknown-session`. E' exatamente o caso da sessao ja aberta quando o plugin sobe, que nunca recebe
  // `session.created` (o ramo acima) e depende so' deste fallback.
  if (typeof fallback === 'string') return str(fallback)
  if (fallback && typeof fallback === 'object') {
    return str(fallback.directory) || str(fallback.path) || str(fallback.canonical) || (fallback.project && str(fallback.project.directory))
  }
  return undefined
}

/**
 * Acrescenta uma linha de assistant SÓ com `stop_reason`: é o sinal de "o turno acabou" que o parser do Claude
 * Code lê (transcript.ts: `s.ended = m.stop_reason === "end_turn" && ...`).
 *
 * Importante: isto ACRESCENTA uma linha, não altera uma já escrita. O transcript precisa ser append-only porque
 * o Habblaud o lê de forma incremental por posição de byte; reescrever uma linha já lida faria o servidor ler
 * fragmentos a partir do offset e perder o sinal.
 */
function markTurnEnd(s, reason, tag) {
  // A dedupe e' por CONTEUDO, nao por id. Neste OpenCode session.execution.succeeded/.failed e
  // session.idle nao trazem assistantMessageID (o schema deles e' so' o base), entao a chave
  // 'turnend:' + id colapsava numa constante: so' o PRIMEIRO fim de turno de cada carga do plugin
  // era gravado e os turnos seguintes nunca armavam a ociosidade — o personagem ficava "working"
  // para sempre. Guarda apenas quando a conversa ja' termina com um marcador (os eventos de fim de
  // turno podem chegar em sequencia: succeeded, depois idle).
  const last = s.lines[s.lines.length - 1];
  if (last && last.message && last.message.stop_reason) return;
  s.lines.push({
    type: 'assistant',
    uuid: 'turn-end:' + (tag || Date.now()) + ':' + s.lines.length,
    timestamp: iso(),
    message: { role: 'assistant', content: [], stop_reason: reason },
  });
  s.dirty = true;
}

/**
 * Fim de turno com ERRO.
 *
 * `session.execution.failed` carrega `error` ({type, message, status, response}) — e e' o unico sinal que
 * explica um turno morto por causa do modelo (sem chave, saldo zerado, modelo fora). Sem gravar isto o
 * turno acabava mudo: o escritorio nao via erro nenhum e o personagem continuava "working".
 *
 * Os dois efeitos vao JUNTOS numa linha so': o texto vira a atividade de erro (o transcript.ts a le pelo
 * campo `isApiErrorMessage`, o mesmo que o terminal.ts ja entende) e o `stop_reason` finaliza o turno —
 * porque so "end_turn" tira o status de trabalho (markTicks/settleStatus). Sem o stop_reason a mensagem
 * apareceria e o agente ficaria preso em "working".
 */
function markTurnError(s, why) {
  const last = s.lines[s.lines.length - 1];
  if (last && last.message && last.message.stop_reason) return; // mesmo dedupe do markTurnEnd
  s.lines.push({
    type: 'assistant',
    uuid: 'turn-error:' + Date.now() + ':' + s.lines.length,
    timestamp: iso(),
    isApiErrorMessage: true,
    error: why,
    message: { role: 'assistant', content: [{ type: 'text', text: why }], stop_reason: 'end_turn' },
  });
  s.dirty = true;
}
// ------------------------------------------------------------------ gravação

function writeMeta(id, s) {
  if (!s.directory) return
  const out = { sessionId: id, cwd: s.directory }
  if (s.parentId) out.parentId = s.parentId
  if (s.agent) out.agent = s.agent
  if (s.model) out.model = s.model
  if (s.title) out.title = s.title
  if (s.startedAt) out.startedAt = s.startedAt
  try {
    writeFileSync(join(SESSIONS, `${id}.meta.json`), JSON.stringify(out))
  } catch (err) {
    log('meta:', err.message)
  }
}

function writeTranscript(id, s) {
  const file = join(SESSIONS, `${id}.jsonl`)
  const body = s.lines.map((l) => JSON.stringify(l)).join('\n') + (s.lines.length ? '\n' : '')
  try {
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (prev === body) return false
    writeFileSync(file, body)
    return true
  } catch (err) {
    log('transcript:', err.message)
    return false
  }
}

/** POST para o Habblaud; undefined = fora do ar, recusou, ou veio sem corpo (o chamador decide o que fazer). */
async function postJson(pathname, body, timeoutMs = 2_000) {
  try {
    const r = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return undefined
    return await r.json()
  } catch {
    return undefined
  }
}

/** GET para o Habblaud; undefined = fora do ar. */
async function getJson(pathname, timeoutMs) {
  try {
    const r = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return undefined
    return await r.json()
  } catch {
    return undefined
  }
}

async function tell(hook, props) {
  await postJson('/api/opencode/events', { dataDir: DATA_DIR, event: { hook_event_name: hook, ...props } }, 1_500)
}

// ------------------------------------------------------- permissões do OpenCode (Fase 4)
//
// O OpenCode pede a aprovação com um evento próprio (`permission.asked`, cujo payload é o Permission.Request:
// {id, sessionID, action, resources[], ...}). O escritório do Habblaud decide, e a resposta volta pela API do
// próprio OpenCode — `ctx.permission.reply`. É o mesmo desenho do hook do Codex (mod/habblaud-codex/hook.mjs),
// só que lá o terminal é quem espera e aqui é o plugin: registra em POST /api/permissions e espera em
// GET /api/permissions/:id/wait até a decisão ou o fim da janela.
//
// Sem escritório aberto o Habblaud devolve {skip} na hora e nada desvia: continua o prompt do app do OpenCode,
// que é o que já acontecia antes desta ponte existir.

/**
 * Janela que o escritório tem para responder. 5 minutos = o `DEFAULT_TIMEOUT_MS` do próprio servidor
 * (server/permissions/registry.ts): é o tempo que a interface do escritório leva para você ver o cartão e
 * decidir. Com 25 s (o padrão do hook do Codex) o pedido expirava antes de dá tempo de responder.
 */
const PERM_WAIT_MS = 300_000
/** Máximo de uma chamada de long-poll: o servidor devolve antes, quando decidir. */
const PERM_POLL_S = 25
/** Recursos que valem a pena levar ao cartão (o servidor corta de novo). */
const PERM_MAX_RESOURCES = 64

/**
 * O OpenCode instancia o plugin uma vez POR PROJETO (uma por `ctx.location`), e o `ctx.permission` resolve o
 * `pending` na INSTÂNCIA DA LOCALIZAÇÃO DELE: `ctx.permission.reply` chama o serviço de permissão direto — o
 * adaptador só usa a rota HTTP para decodificar o payload, então a middleware que a rota tem (que resolve a
 * sessão) não roda. Com vários projetos abertos, a instância de OUTRO projeto respondia
 * "Permission request not found" e a aprovação do escritório nunca liberava a chamada: o prompt do app ficava
 * pendente e só ele resolvia.
 *
 * Só a instância dona da sessão enxerga o pedido — nas outras `permission.list` vem vazio. É o discriminador
 * autoritativo: `s.directory` não serve, porque cada instância grava a própria localização no slot da sessão
 * que já existia quando o plugin subiu, e todas dariam "match".
 *
 * `true` = esta instância enxerga o pedido (é a dona); `false` = não enxerga (outra é a dona); `undefined` =
 * não deu para saber (sem `permission.list`, ou erro) — aí assume como antes, que é o comportamento antigo.
 */
async function ownPermission(ctx, sessionID, requestID) {
  if (!sessionID || !requestID || !ctx.permission || typeof ctx.permission.list !== 'function') return undefined
  try {
    const l = await ctx.permission.list({ sessionID })
    if (!Array.isArray(l)) return undefined
    return l.some((p) => p && str(p.id) === requestID)
  } catch {
    return undefined
  }
}

/**
 * Pedidos de permissão já assumidos por UMA das instâncias (ver o cabeçalho: o `setup()` roda uma vez por
 * projeto aberto e todas as instâncias veem o MESMO barramento de eventos do servidor).
 *
 * A escrita de transcript é idempotente por construção — reescrever o mesmo conteúdo não muda nada — mas
 * `POST /api/permissions` NÃO é: cada projeto aberto mandava o próprio e o escritório recebia UM CARTÃO POR
 * PROJETO para uma permissão só. As instâncias são módulos separados, então o único estado que elas
 * compartilham é o `globalThis` — e ele tem exatamente o escopo certo: um barramento por processo.
 */
const COMPARTILHADO = (globalThis.__habblaud ??= {
  permissoes: new Set(),
  perguntas: new Set(),
  token: Math.random().toString(36).slice(2, 10),
})
const PERM_ASSUMIDAS = COMPARTILHADO.permissoes

/** Recursos pedidos (caminhos, comandos, URLs), só os que prestam. */
function permResources(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw) {
    const s = str(r)
    if (s && out.length < PERM_MAX_RESOURCES) out.push(s)
  }
  return out
}

/** Leva o pedido para o escritório e devolve a resposta para o OpenCode quando ele decidir. */
async function permAguardar(ctx, req, cwd) {
  const resources = permResources(req.resources)
  const reg = await postJson('/api/permissions', {
    provider: 'opencode',
    session_id: str(req.sessionID),
    cwd,
    tool_name: str(req.action) || 'permissao',
    tool_input: { resources },
    timeout_ms: PERM_WAIT_MS,
  })
  const id = reg && str(reg.id)
  if (!id) return // {skip} = sem escritório, ou o Habblaud fora do ar: o app do OpenCode decide sozinho.

  const deadline = Date.now() + PERM_WAIT_MS
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) {
      return // expirou: o servidor devolve {status:'released'} e ninguém responde.
    }
    const pollS = Math.max(0.05, Math.min(PERM_POLL_S, left / 1_000))
    const w = await getJson(`/api/permissions/${encodeURIComponent(id)}/wait?timeout=${pollS}`, pollS * 1_000 + 5_000)
    if (!w) {
      return // Habblaud caiu no meio da espera: não insiste, o prompt do app segue.
    }
    if (w.status === 'pending') continue
    permResponder(ctx, req, w).catch(() => {})
    return
  }
}

/**
 * Devolve a decisão para o OpenCode. `once` aprova; `reject` recusa e o `message` vai ao modelo como ORIENTAÇÃO
 * (ele continua com o recado), enquanto o reject sem motivo para a chamada. `interrupt` (que o Codex não aceita)
 * o OpenCode aceita: derruba o turno depois de recusar. `released` não responde nada — quem decide é o próprio app.
 *
 * O nome do campo é `decision`, não `reply`: `ctx.permission.reply` é o cliente da rota
 * POST /api/session/:sessionID/permission/:requestID/reply, cujo payload é `{decision, message?}` e cujos
 * parâmetros de URL (sessionID, requestID) o adaptador do plugin MESCLA no mesmo objeto de um único argumento.
 * Com `reply` o schema recusava tudo com `Missing key at ["decision"]`.
 */
async function permResponder(ctx, req, w) {
  const sessionID = str(req.sessionID)
  const requestID = str(req.id)
  if (!sessionID || !requestID) return
  if (w.status !== 'decided') return

  if (w.behavior === 'allow') {
    await ctx.permission.reply({ sessionID, requestID, decision: 'once' }).catch(() => {})
    return
  }
  if (w.behavior === 'deny') {
    const message = str(w.message)
    await ctx.permission.reply({ sessionID, requestID, decision: 'reject', ...(message ? { message } : {}) }).catch(() => {})
    if (w.interrupt) {
      // O Codex nao aceita `interrupt` no reply; o OpenCode aceita como chamada propria.
      await ctx.session.interrupt({ sessionID }).catch(() => {})
    }
  }
}

// ------------------------------------------------------- mensagens do escritório (Fase 5)
//
// O escritório manda texto à sessão pelo MESMO caminho do Claude Code: o plugin pergunta a cada 2 s se há
// mensagens para cada sessão aberta (POST /api/mod/inbox), entrega cada uma com `ctx.session.prompt` e
// confirma em POST /api/mod/inbox/ack. Nenhuma rota nova no servidor: o `inbox()` dele já atende qualquer
// provider que não seja `codex`, e `sessionId` do agente é o id da sessão do OpenCode.
//
// Só a instância DONA pergunta e entrega (ownSession): `ctx.session.prompt` tem a `sessionLocationMiddleware`
// na rota, mas o adaptador do plugin chama o serviço direto — o mesmo motivo da Fase 4. A pergunta (`inbox`)
// já marca a mensagem como `sent` no servidor, então se uma instância errada buscasse, a certa nunca a veria:
// quem não é dona nem pergunta. O discriminador aqui é `ctx.session.get`, cuja rota NÃO tem a middleware
// (é global) e devolve a localização real da sessão (`data.location.directory`).
//
// A chamada é `prompt({ sessionID, text })` — UM objeto só, como no `reply` da Fase 4: o adaptador mescla
// params e payload. `metadata` é opcional no schema (`SessionInbox.UserPayload`), então só texto basta.

/** De quanto em quanto tempo pergunta ao Habblaud se há mensagens (o mesmo do habblaud-mensagens). */
const MSG_POLL_MS = 2_000
/** Motivo de falha numa linha só (o texto da mensagem nunca é cortado: só o motivo). */
const MSG_MAX_REASON = 500

/** Localização desta instância: objeto `{directory, ...}` ou string, como na Fase 4. */
function ownDir(ctx) {
  const l = ctx.location
  return l && typeof l === 'object' ? l.directory : l
}

/**
 * `true` = esta instância é a dona da sessão; `false` = outra é; `undefined` = não deu para saber
 * (sem `session.get`, ou erro) — aí NÃO pergunta, ao contrário da Fase 4: aqui buscar sem poder entregar
 * esconderia a mensagem da instância certa (o servidor marca `sent` na busca).
 */
async function ownSession(ctx, sessionID) {
  if (!sessionID || !ctx.session || typeof ctx.session.get !== 'function') return undefined
  try {
    const info = await ctx.session.get({ sessionID })
    const dir = (info && info.data && info.data.location && info.data.location.directory)
      || (info && info.location && info.location.directory)
    const mine = ownDir(ctx)
    if (!dir || !mine) return undefined
    return dir === mine
  } catch {
    return undefined
  }
}

/** Motivo de falha numa linha só, com tamanho limitado. */
function msgReason(raw, fallback) {
  const msg = typeof raw === 'string' ? raw : (raw && typeof raw.message === 'string' ? raw.message : '')
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MSG_MAX_REASON ? `${line.slice(0, MSG_MAX_REASON - 1)}…` : line
}

/** Uma mensagem para a sessão, como se digitada nela. Nunca lança. */
async function msgDeliverOne(ctx, sessionID, text) {
  if (!text || !text.trim()) return { ok: false, error: 'mensagem vazia' }
  try {
    await ctx.session.prompt({ sessionID, text })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msgReason(err, 'a sessão não aceitou a mensagem') }
  }
}

/**
 * Uma rodada: para cada sessão aberta desta instância, busca, entrega e confirma. Nunca lança.
 * Uma rodada por vez: um Habblaud lento não empilha perguntas.
 */
let msgPolling = false
async function msgRound(ctx) {
  if (msgPolling) return
  msgPolling = true
  try {
    let names = []
    try {
      names = readdirSync(OPEN).filter((n) => n.endsWith('.lock')).map((n) => n.slice(0, -'.lock'.length))
    } catch {
      /* sem marcadores: nada a perguntar */
    }
    for (const id of names) {
      if ((await ownSession(ctx, id)) !== true) continue
      const inbox = await postJson('/api/mod/inbox', { session: id })
      const list = inbox && Array.isArray(inbox.messages) ? inbox.messages : undefined
      if (!list || !list.length) continue
      const results = []
      for (const m of list.slice(0, 5)) {
        if (!m || typeof m.id !== 'string' || !m.id) continue
        const r = await msgDeliverOne(ctx, id, typeof m.text === 'string' ? m.text : '')
        results.push(r.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: r.error })
      }
      if (results.length) await postJson('/api/mod/inbox/ack', { session: id, results })
    }
  } catch {
    /* silêncio: a próxima rodada tenta de novo */
  } finally {
    msgPolling = false
  }
}

// ------------------------------------------------------- perguntas ao usuário (Fase 4.7)
//
// Quando o modelo chama a ferramenta `question`, o OpenCode cria um FORMULÁRIO (form.created) e o turno trava
// até ele ser respondido — e a API do plugin (2.0.27/2.0.28) NÃO expõe form.reply (o SessionDomain do ctx termina
// em `context`; mandar HTTP cru exigiria descobrir porta e senha: gambiarra, não). Então o plugin ENVOLVE o
// execute da ferramenta (`ctx.tool.transform`): o escritório responde primeiro; sem escritório, expiração ou
// resposta inválida, chama o ORIGINAL e vale o prompt nativo (a mesma filosofia das permissões).
//
// O embrulho devolve a resposta como tool_result no formato NATIVO (verificado no transcript real):
//   content: [{type:'text', text:'User has answered your questions: "P"="R". You can now ...'}]
//   metadata: {answers: [[valores-por-pergunta]], truncated: false}
// e a dispensa como erro `The user dismissed this question` (também nativo). O modelo não distingue.
// Os VALORES (não os rótulos) vão na resposta, como o form.replied registra.
//
// Só a instância DONA desvia (ownSession, o mesmo da Fase 5): buscar sem poder entregar não é opção aqui
// porque o embrulho decide na hora. As outras chamam o original em cascata até a dona. FORM_ASSUMIDAS (um
// por chamada) impede dois cartões quando o registro é global e todos os embrulhos veem a mesma chamada.

/** Chamadas `question` já assumidas por UM embrulho (mesmo motivo do PERM_ASSUMIDAS). */
const FORM_ASSUMIDAS = (COMPARTILHADO.perguntas ??= new Set())

/** Espera a decisão do escritório; undefined = expirou ou o Habblaud caiu (vale o nativo). */
async function waitOfficeDecision(id) {
  const deadline = Date.now() + PERM_WAIT_MS
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return undefined
    const pollS = Math.max(0.05, Math.min(PERM_POLL_S, left / 1_000))
    const w = await getJson(`/api/permissions/${encodeURIComponent(id)}/wait?timeout=${pollS}`, pollS * 1_000 + 5_000)
    if (!w) return undefined
    if (w.status === 'pending') continue
    return w
  }
}

/**
 * Respostas do escritório (posições) → valores do input ORIGINAL. Espelha o answersFor do hook do Claude
 * (mod/habblaud-permissoes), com `multiple` no lugar de `multiSelect`. undefined = não dá para responder
 * (vale o nativo): pergunta sem texto, posição inválida, valor ausente, escolha demais sem multiple,
 * pergunta sem resposta ou nem todas as perguntas respondidas.
 */
function mapQuestionAnswers(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || !answers.length) return undefined
  const byQuestion = new Map()
  for (const a of answers) {
    if (!a || typeof a !== 'object' || !Number.isInteger(a.question) || byQuestion.has(a.question)) return undefined
    byQuestion.set(a.question, a)
  }
  const values = []
  const texts = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    if (!q || typeof q !== 'object') continue // entrada inválida: o escritório nem mostrou
    const qq = str(q.question)
    if (!qq) continue // idem
    const a = byQuestion.get(i)
    if (!a) return undefined
    const options = Array.isArray(q.options) ? q.options : []
    const vals = []
    for (const oi of Array.isArray(a.options) ? a.options : []) {
      // Nem toda chamada traz `value` (só `label`): a ferramenta usa o rótulo como valor nesse caso
      // (o form criado sempre tem os dois) — então o embrulho faz o mesmo, ou a resposta nunca bateria.
      const opt = Number.isInteger(oi) && oi >= 0 ? options[oi] : undefined
      const v = (opt && (str(opt.value) || str(opt.label))) || undefined
      if (!v) return undefined
      vals.push(v)
    }
    const other = str(a.other)
    if (other) vals.push(other.trim())
    if (!vals.length) return undefined
    if (q.multiple !== true && vals.length > 1) return undefined
    values.push(vals)
    texts.push(`"${qq}"="${vals.join(', ')}"`)
  }
  if (!texts.length) return undefined
  return {
    text: `User has answered your questions: ${texts.join(', ')}. You can now continue with the user's answers in mind.`,
    values,
  }
}

/**
 * O execute embrulhado: escritório primeiro, nativo como plano B. Nunca lança exceto a dispensa
 * (que o nativo também lança como erro) — qualquer outro problema cai no original.
 */
async function askViaOffice(ctx, fallbackDir, input, context, orig) {
  const fallback = () => orig(input, context)
  const sessionID = str(context && context.sessionID)
  const callId = str(context && context.id)
  const questions = input && Array.isArray(input.questions) ? input.questions : undefined
  if (!sessionID || !callId || !questions || !questions.length) {
    return fallback()
  }
  // Só a dona desvia; as outras delegam (cascata até a dona quando o registro é global).
  if ((await ownSession(ctx, sessionID)) !== true) {
    return fallback()
  }
  if (FORM_ASSUMIDAS.has(callId)) {
    return fallback()
  }
  FORM_ASSUMIDAS.add(callId)
  try {
    const dir = (sessions.get(sessionID) || {}).directory || fallbackDir
    const reg = await postJson('/api/permissions', {
      provider: 'opencode',
      session_id: sessionID,
      cwd: dir,
      tool_name: 'Question',
      tool_input: { questions },
      timeout_ms: PERM_WAIT_MS,
    })
    const id = reg && str(reg.id)
    if (!id) {
      return fallback() // {skip} = sem escritório: nativo na hora.
    }
    const w = await waitOfficeDecision(id)
    if (!w || w.status !== 'decided') {
      return fallback()
    }
    if (w.behavior === 'answer' && Array.isArray(w.answers)) {
      const mapped = mapQuestionAnswers(questions, w.answers)
      if (mapped) {
        // `output` é OBRIGATÓRIO: a ferramenta declara `output: {answers: string[][]}` e o harness
        // recusa o retorno sem ele ("Tool did not return its declared output"). `metadata.answers`
        // repete os valores, como no evento nativo.
        return {
          output: { answers: mapped.values },
          content: [{ type: 'text', text: mapped.text }],
          metadata: { answers: mapped.values, truncated: false },
        }
      }
      return fallback() // inválida: nativo.
    }
    if (w.behavior === 'deny') {
      throw new Error('The user dismissed this question')
    }
    return fallback() // released/terminal: nativo.
  } finally {
    FORM_ASSUMIDAS.delete(callId)
  }
}

/**
 * Embrulha o execute da ferramenta `question` (uma vez; marca para não embrulhar de novo num reload).
 * Sem a ferramenta, sem transform ou qualquer erro: não faz nada e a pergunta segue nativa.
 * Devolve a função de desfazer (o teardown chama).
 */
async function wrapQuestionTool(ctx, fallbackDir) {
  try {
    if (!ctx.tool || typeof ctx.tool.transform !== 'function') {
      return undefined
    }
    const registration = await ctx.tool.transform((editor) => {
      try {
        if (!editor || typeof editor.get !== 'function' || typeof editor.update !== 'function') {
          return
        }
        if (!editor.get('question')) {
          return
        }
        editor.update('question', (tool) => {
          if (!tool || typeof tool.execute !== 'function' || tool.execute.__habblaud) return
          const orig = tool.execute
          const wrapped = (input, context) => askViaOffice(ctx, fallbackDir, input, context, orig)
          wrapped.__habblaud = true
          tool.execute = wrapped
        })
      } catch {
        /* sem o embrulho, a pergunta segue nativa */
      }
    })
    if (!registration || typeof registration.dispose !== 'function') return undefined
    return () => registration.dispose().catch(() => {})
  } catch {
    return undefined
  }
}

function flush(id) {
  const s = sessions.get(id)
  if (!s) return
  if (!s.directory || !s.dirty) return
  writeMeta(id, s)
  const changed = writeTranscript(id, s)
  s.dirty = false
  if (changed) touch(id)
  tell(working.has(id) ? 'SessionStart' : 'Stop', { session_id: id, cwd: s.directory })
}

/** working = o agente está em turno; muda com step.started/execution.started e volta com execution.succeeded. */
const working = new Set()

function schedule(id) {
  dirty.add(id)
  if (schedule.timer) clearTimeout(schedule.timer)
  schedule.timer = setTimeout(() => {
    schedule.timer = undefined
    for (const i of dirty) flush(i)
    dirty.clear()
  }, COALESCE_MS)
}

// ------------------------------------------------------------------ o plugin

export default {
  id: 'habblaud',

  async setup(ctx) {
    const fallbackDir = ctx.location

    // Marcadores de uma execução anterior: o OpenCode foi fechado e nada mais vai remover estes arquivos.
    try {
      const now = Date.now()
      for (const name of readdirSync(OPEN)) {
        if (!name.endsWith('.lock')) continue
        const p = join(OPEN, name)
        try {
          if (now - statSync(p).mtimeMs > IDLE_GRACE_MS) rmSync(p, { force: true })
        } catch {
          /* já sumiu */
        }
      }
    } catch {
      /* sem marcadores antigos */
    }

    // Batimento: mantém viva toda sessão conhecida enquanto o OpenCode estiver aberto.
    const beat = setInterval(() => {
      for (const id of sessions.keys()) touch(id)
    }, HEARTBEAT_MS)
    if (typeof beat.unref === 'function') beat.unref()

    // Mensagens do escritório (Fase 5): pergunta a cada 2 s se há mensagens para as sessões desta
    // instância e as entrega. Fora do ar, a rodada só volta vazia até ele voltar.
    const msgPoll = setInterval(() => {
      void msgRound(ctx)
    }, MSG_POLL_MS)
    if (typeof msgPoll.unref === 'function') msgPoll.unref()

    // Perguntas ao usuário (Fase 4.7): envolve o execute da ferramenta `question` para o escritório
    // responder primeiro. Sem a ferramenta ou qualquer erro, a pergunta segue nativa.
    const unwrapQuestion = await wrapQuestionTool(ctx, fallbackDir)

    let closed = false
    ;(async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          if (closed) break
          const type = ev && ev.type
          const d = (ev && (ev.data || ev.properties)) || {}

          // Permissão: o OpenCode pede, o escritório do Habblaud decide. Não é evento de sessão, então passa
          // ANTES do filtro logo abaixo (que é só para o transcript). O pedido não deixa rastro em arquivo:
          // ele vive inteiro na API.
          if (type === 'permission.asked') {
            // Só UMA instância assume o pedido (PERM_ASSUMIDAS): as outras veem o mesmo evento e ficam de fora,
            // senão o escritório receberia um cartão por projeto aberto. E antes disso, só a instância DONA
            // da sessão pode assumir (ownPermission) — a de outro projeto não consegue responder.
            const rid = str(d.id)
            if (rid) {
              if (PERM_ASSUMIDAS.has(rid)) continue
              if ((await ownPermission(ctx, str(d.sessionID), rid)) === false) continue
              PERM_ASSUMIDAS.add(rid)
            }
            const dir = (sessions.get(str(d.sessionID)) || {}).directory || fallbackDir
            permAguardar(ctx, d, dir)
              .finally(() => {
                if (rid) PERM_ASSUMIDAS.delete(rid)
              })
              .catch(() => {})
            continue
          }
          // So evento DE SESSAO abre sessao: shell.created traz info.id = id do SHELL ("sh_..."), e tratalo como
          // sessao criava personagem e lock fantasma a cada evento de shell.
          if (typeof type !== 'string' || !type.startsWith('session.')) continue
          const id = str(d.sessionID) || str(d.sessionId)
          if (!id) continue

          const s = slot(id)

          // Sessao que ja existia quando o plugin subiu nao recebe session.created (o OpenCode nao avisa do
          // passado). O location desta instancia e o projeto aberto: e' a pasta onde ela mora, e a sala.
          if (!s.directory) s.directory = directoryOf(undefined, fallbackDir)

          switch (type) {
            case 'session.created': {
              s.directory = directoryOf(d, fallbackDir) || s.directory
              s.projectId = str(d.projectID) || s.projectId
              s.agent = str(d.agent) || s.agent
              s.model = typeof d.model === 'string' ? d.model : str(d.model && d.model.modelID) || s.model
              s.startedAt = s.startedAt || Date.now()
              touch(id)
              schedule(id)
              break
            }

            case 'session.renamed': {
              const t = str(d.title)
              if (t) {
                s.title = t
                s.dirty = true
              }
              schedule(id)
              break
            }

            // O PROMPT do usuário chega pela fila da sessão.
            case 'session.inbox.enqueued': {
              const prompt = userPromptFrom(d.item)
              if (prompt) {
                push(s, `prompt:${d.inboxID || prompt.slice(0, 40)}`, {
                  type: 'user',
                  uuid: `inbox:${d.inboxID || Date.now()}`,
                  timestamp: iso(num(d.created) || Date.now()),
                  message: { role: 'user', content: prompt },
                })
                touch(id)
              }
              schedule(id)
              break
            }

            // O texto FINAL da resposta (nunca os deltas).
            // O texto comeca a chegar ANTES de terminar. Sem esta linha so aparece no fim do bloco.
            case 'session.text.started': {
              push(s, `text:${d.assistantMessageID}:${d.ordinal}`, {
                type: 'assistant',
                uuid: `${d.assistantMessageID}:t${d.ordinal}`,
                timestamp: iso(),
                message: { role: 'assistant', content: [{ type: 'text', text: '...' }] },
              })
              touch(id)
              schedule(id)
              break
            }

            case 'session.text.ended': {
              const t = str(d.text)
              if (t) {
                pushOrReplace(s, `text:${d.assistantMessageID}:${d.ordinal}`, {
                  type: 'assistant',
                  uuid: `${d.assistantMessageID}:t${d.ordinal}`,
                  timestamp: iso(),
                  message: { role: 'assistant', content: [{ type: 'text', text: t }] },
                })
                touch(id)
              }
              schedule(id)
              break
            }

            // O raciocinio comeca ANTES de terminar. O reasoning.ended so chega quando o bloco inteiro acaba;
            // num prompt gigante isso leva minutos e o personagem ficaria mudo ate o fim do turno.
            case 'session.reasoning.started': {
              push(s, `reason:${d.assistantMessageID}:${d.ordinal}`, {
                type: 'assistant',
                uuid: `${d.assistantMessageID}:r${d.ordinal}`,
                timestamp: iso(),
                message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
              })
              touch(id)
              schedule(id)
              break
            }

            case 'session.reasoning.ended': {
              const t = str(d.text)
              if (t) {
                pushOrReplace(s, `reason:${d.assistantMessageID}:${d.ordinal}`, {
                  type: 'assistant',
                  uuid: `${d.assistantMessageID}:r${d.ordinal}`,
                  timestamp: iso(),
                  message: { role: 'assistant', content: [{ type: 'thinking', thinking: t }] },
                })
                touch(id)
              }
              schedule(id)
              break
            }

            // O NOME da ferramenta. So o `session.tool.input.started` traz `name` ({...s, name});
            // o `session.tool.called` vem sem ele. Os dois sao eventos `Or` (duraveis) e o `.started`
            // sempre publica antes da chamada, entao o cache nunca perde a ordem.
            case 'session.tool.input.started': {
              if (d.name && d.id) s.toolNames.set(d.id, toolName(d.name))
              break
            }

            // A chamada da ferramenta (o tool_result vem no success, com o mesmo id).
            case 'session.tool.called': {
              const name = s.toolNames.get(d.id) || toolName(d.name || (d.input && d.input.tool))
              push(s, `call:${d.id}`, {
                type: 'assistant',
                uuid: `${d.assistantMessageID}:${d.id}:call`,
                timestamp: iso(),
                message: { role: 'assistant', content: [{ type: 'tool_use', id: d.id, name, input: d.input || {} }] },
              })
              touch(id)
              schedule(id)
              break
            }

            // O RESULTADO da ferramenta, no formato Claude Code (`tool_result`).
            //
            // O erro vem do EVENTO, nunca de `executed`. Este OpenCode publica:
            //   session.tool.success → { content, executed, resultState }
            //   session.tool.failed  → { error, content, executed, resultState }
            // e o executável decide `status:"error"` exatamente quando o tipo é `session.tool.failed`.
            // `executed` é `providerExecuted` (não é flag de sucesso): veio `false` em TODOS os 14
            // resultados de uma sessão real — inclusive leituras bem-sucedidas — marcando tudo como
            // erro no escritório. `resultState` é o estado do PROVEDOR, não o status da ferramenta,
            // por isso também não serve como sinal.
            case 'session.tool.success':
            case 'session.tool.failed': {
              const failed = type === 'session.tool.failed'
              // O nome ja foi consumido pela chamada; solta a referencia (o cache e' por chamada,
              // e uma sessao longa geraria centenas delas).
              s.toolNames.delete(d.id)
              const content = failed ? failureText(d) : outputText(d.content)
              push(s, `ok:${d.id}`, {
                type: 'user',
                uuid: `${d.assistantMessageID}:${d.id}:ok`,
                parentUuid: `${d.assistantMessageID}:${d.id}:call`,
                timestamp: iso(),
                toolUseResult: { toolUseId: d.id, is_error: failed },
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: d.id, content, is_error: failed }] },
              })
              touch(id)
              schedule(id)
              break
            }

            // Ciclo de vida do turno: é o que define working/idle no escritório.
            case 'session.execution.started':
            case 'session.step.started': {
              working.add(id)
              s.agent = str(d.agent) || s.agent
              if (typeof d.model === 'string') s.model = d.model
              touch(id)
              schedule(id)
              break
            }

            case 'session.execution.succeeded':
            case 'session.execution.failed':
            case 'session.idle': {
              working.delete(id)
              markIdle(id)
              // O sinal de 'acabou' que o parser do Claude Code le para tirar o personagem de 'working'.
              // A falha tem `error` e vai com a mensagem: sem ela o escritorio nunca sabia o que deu errado.
              if (type === 'session.execution.failed' && d.error != null) markTurnError(s, failureText(d))
              else markTurnEnd(s, type === 'session.execution.succeeded' ? 'end_turn' : 'interrupted', d.assistantMessageID)
              schedule(id)
              break
            }

            case 'session.step.ended': {
              // Fecha a linha da mensagem com uso e custo (o texto já veio no text.ended).
              const cost = num(d.cost)
              const t = num(d.tokens && (d.tokens.input || d.tokens.inputTokens))
              const o = num(d.tokens && (d.tokens.output || d.tokens.outputTokens))
              if (cost !== undefined || t || o) {
                const last = s.lines.length ? s.lines[s.lines.length - 1] : undefined
                if (last && last.type === 'assistant') {
                  last.cost = cost || last.cost || 0
                  last.message.model = s.model || last.message.model
                  last.message.usage = {
                    input_tokens: t || 0,
                    output_tokens: o || 0,
                    cache_read_input_tokens: 0,
                  }
                  s.dirty = true
                }
              }
              schedule(id)
              break
            }

            case 'session.deleted':
            case 'session.removed': {
              cancelIdle(id)
              working.delete(id)
              sessions.delete(id)
              try {
                rmSync(join(OPEN, `${id}.lock`), { force: true })
              } catch {
                /* já sumiu */
              }
              tell('SessionEnd', { session_id: id })
              break
            }

            default:
              break
          }
        }
      } catch (err) {
        log('stream:', err.message)
      }
    })()

    return async () => {
      closed = true
      clearInterval(beat)
      clearInterval(msgPoll)
      if (unwrapQuestion) {
        try {
          await unwrapQuestion()
        } catch {
          /* já sumiu */
        }
      }
      for (const t of idleTimers.values()) clearTimeout(t)
      idleTimers.clear()
    }
  },
}