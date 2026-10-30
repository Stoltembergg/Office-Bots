# Qualificação de dependências e plataformas

Verificação M0 em 2026-10-24, sobre `main` importado em `11ba85e986383ad0cbf0e4e66f4b81b62b9a1bbd`. Esta qualificação usa versões fixas para iniciar M1; uma atualização de major exige repetir as provas abaixo.

## Decisão de início

| Componente | Versão inicial | Requisito relevante | Resultado |
| --- | --- | --- | --- |
| Pi SDK (`@earendil-works/pi-coding-agent`) | `1.4.0` | Node `>=22.19.0` | Aprovado para o worker, com ferramentas controladas pelo app e carregamento explícito de extensões. |
| Electron | `45.0.0` | Incorpora Node `24.22.0`; Windows 10+; macOS 13+ | Compatível com o requisito do Pi. Builds e smoke em Windows/macOS ainda precisam rodar em runners nativos. |
| Electron Forge | `8.0.1` | Notas da versão 8 indicam Node `>=22.17.0`; metadado npm da CLI `8.0.1` indica `>=22.13.0` | Compatível com a linha de base `>=22.19.0` que o Pi exige. |

Manter `engines.node >=22.19.0` no projeto e no CI quando M1 adicionar essas dependências. O `.npmrc` atual contém `engine-strict=true`, então instalar Pi com o limite antigo de `22.12` falharia. Usar Node 24 no CI para aproximar as ferramentas do Node embutido no Electron. O Electron 45 está no início da janela de suporte; acompanhar atualizações de segurança e repetir as provas ao atualizar. O Node nativo do Electron é incluído no app final, sem exigir Node do usuário.

## Prova do Pi SDK

O pacote fixo `@earendil-works/pi-coding-agent@1.4.0` foi instalado em diretório temporário, sem mudar dependências ou lockfile do projeto. A versão declara `engines.node >=22.19.0` e exporta `createAgentSession`, `ModelRuntime`, `SessionManager` e `DefaultResourceLoader`.

Um processo Node isolado, com `fauxProvider` do próprio `@earendil-works/pi-ai@1.4.0`, passou estas provas sem conta, credenciais ou chamada a um modelo pago:

- `session.prompt()` completou e `session.subscribe()` recebeu `text_delta` e uso do assistente;
- retornos `tool_call` com `{ block: true }` negaram `bash` e `write` antes de criar/sobrescrever o arquivo marcador;
- `session.abort()` encerrou uma resposta em streaming e deixou a sessão ociosa;
- `SessionManager.open()` reabriu o arquivo persistido, recuperou o histórico e aceitou novo prompt.

Resultado: `PASS Pi 1.4.0 isolated process: prompt, text deltas, usage, denied bash and write before effects, cancellation, session resume`.

O gate M0 de interceptação antes do efeito foi comprovado para `bash` e `write`. M3 ainda precisa testar cada ferramenta habilitada, chamadas aninhadas e negação/cancelamento no broker do app. A extensão que recebe `tool_call` roda com as permissões do processo Pi; isso não é sandbox de sistema operacional. A documentação do SDK também informa que mutações feitas por extensões aos argumentos não são revalidadas. Portanto, a implementação deve usar extensões escritas pelo app, não carregar plugins do usuário automaticamente, não mutar argumentos de execução e validar caminhos dentro de cada ferramenta.

`ModelRuntime.create()` aceita um `CredentialStore` próprio e um caminho explícito de autenticação. M3 deve conectar o armazenamento ao cofre do sistema; não usar o `auth.json` padrão de `~/.pi/agent` como cofre do produto nem deixar uma persistência em texto puro como fallback.

## Autenticação por provedor

| Provedor | O que a versão verificada expõe | Decisão para o produto |
| --- | --- | --- |
| Anthropic / Claude | Pi expõe API key e OAuth tecnicamente. A chave de API usa a conta Anthropic Console. | Qualificar API key da Console. Não oferecer login/rate limits de `claude.ai` sem aprovação explícita: a documentação oficial da Anthropic veda essa oferta por terceiros salvo aprovação prévia. |
| OpenAI API | Pi expõe API key (`OPENAI_API_KEY`) e OAuth no provedor `openai`; o uso de chave é cobrado conforme a API. | API key da OpenAI Platform é a opção inicial qualificada. |
| OpenAI Codex | `ModelRuntime` 1.4.0 contém o provedor `openai-codex` com OAuth técnico e sem API key própria. Não testamos um login real. | Não transportar tokens do Codex CLI nem distribuir o fluxo OAuth até confirmar elegibilidade para um app terceiro. A documentação oficial encontrada descreve o login com ChatGPT nos clientes Codex oficiais, mas não estabelece autorização para este cliente independente. Esta é uma decisão conservadora diante da falta de autorização explícita, não uma afirmação de proibição geral. |

O app deve apresentar provedor, conta e modelo de forma explícita, manter sessões identificadas como `managed-pi` e nunca trocar para uma conta/modelo alternativo. Os testes M0 não fizeram login, refresh real ou chamadas faturáveis. OAuth de Anthropic/Codex fica condicionado a qualificação atualizada antes da distribuição.

## Matriz de plataformas

| Alvo | Requisito baseado no Electron 45 | Evidência local | Estado |
| --- | --- | --- | --- |
| Windows x64 nativo | Windows 10 ou posterior; pacote 64-bit | Host de qualificação Linux; nenhum build ou smoke Windows | Requer CI e validação em Windows nativo antes de declarar suporte. |
| WSL x64 | Não é alvo de distribuição Electron separado | Nenhuma execução WSL/WSLg; `node-pty` não foi instalado nesta máquina | Não suportado até existir prova específica de UI e ABI em WSL. |
| macOS Intel x64 | macOS 13 Ventura ou posterior; Electron publica `x64` | Sem host Intel/macOS | Requer CI e smoke em macOS Intel. |
| macOS Apple Silicon arm64 | macOS 13 Ventura ou posterior; Electron publica `arm64` | Sem host Apple Silicon/macOS | Requer CI e smoke em Apple Silicon. |

Esses mínimos vêm das notas atuais do Electron. O teste local não demonstra execução, assinatura, notarização, `node-pty` nem instaladores em nenhum desses sistemas. O modo web existente continua independente do Electron.

## Linha de base

Ambiente: Linux `6.18.55` x86_64, Node `24.19.0`, npm `11.9.0`, base `11ba85e`.

| Comando | Resultado |
| --- | --- |
| `npm ci` | Passou; o npm exibiu aviso de ambiente `http-proxy` desconhecido. |
| `npm run typecheck` | Passou. |
| `npm test` | 158 arquivos, 1.882 testes passaram e 2 ficaram skipped. |
| `npm run build` | Passou. Vite manteve o aviso existente de bundle principal acima de 500 kB. |
| `npm run i18n:check` | O wrapper `tsx` falhou ao abrir `/tmp/tsx-0/17.pipe` (`EPERM`) neste ambiente. O mesmo script passou por `node --import tsx/esm scripts/i18n-check.ts`: 2.982/2.982 traduções em en, es e fr. |

## Fontes oficiais consultadas

- Pi [SDK](https://pi.dev/docs/latest/sdk), [providers](https://pi.dev/docs/latest/providers) e [extensions](https://pi.dev/docs/latest/extensions); pacote [`@earendil-works/pi-coding-agent@1.4.0`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.4.0).
- Electron [releases](https://releases.electronjs.org/), [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes) e [Forge 8.0.1](https://github.com/electron/forge/releases/tag/v8.0.1).
- Anthropic [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) e [legal and compliance](https://docs.anthropic.com/en/docs/claude-code/legal-and-compliance).
- OpenAI [Codex authentication](https://developers.openai.com/codex/auth).

## Refinamento M2.5 — carregamento de recursos

A implementação do worker revelou que `DefaultResourceLoader` 1.4.0 lê `APPEND_SYSTEM.md` mesmo com `noContextFiles:true` e interpreta um `systemPrompt` que coincide com caminho existente como arquivo. O produto usa um `ResourceLoader` próprio, sem discovery/recursos, com instruções literais, runtime de extensões vazio e settings em memória sem confiança no projeto. Testes com marcadores reproduziram o vazamento antes da correção e passaram depois. As flags do loader padrão sozinhas não são uma fronteira adequada de privacidade.

O worker deste incremento não autoriza contas de produção, não consulta credenciais das CLIs e não habilita ferramentas. Provas com fauxProvider do SDK não qualificam autenticação real, aprovação de ferramentas nem o lançamento final usando o Node do Electron. Esses gates permanecem M2/M3.

## M2.6 — Node embutido e ASAR

Em Linux x64, o executável Electron do pacote (Node observado 24.22.0) iniciou `app.asar/dist/desktop/pi-worker.mjs` com `ELECTRON_RUN_AS_NODE=1`; o SDK real carregou, criou e fechou sessão sintética, sem prompt, antes de encerrar o processo. O teste de runtime também usa o executável Electron instalado, em vez de Node externo no filho. Não houve autenticação/chamada de modelo real.

O smoke da janela no CI agora exige o marcador do worker e SDK, além do cliente web. Essa prova headless local não substitui o smoke GUI nos SOs alvo, nem assinatura/notarização. O launcher define apenas o executável incluído pelo app e um ambiente restrito; não habilita caminhos/executáveis controláveis pelo renderer.
