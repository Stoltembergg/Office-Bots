# Office Bots Desktop — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, quando essa skill estiver disponível. Execute uma tarefa por vez e registre evidências antes de marcar seus itens.

**Goal:** Transformar o Habblaud importado em um aplicativo Windows e macOS que permite conversar com agentes próprios baseados no Pi SDK e acompanhar seu trabalho no escritório em pixel art.

**Architecture:** Electron para janela, ciclo de vida e integrações do sistema; processo Node isolado para o Pi SDK; contratos internos independentes do runtime. Preservar o monitoramento existente de Claude Code/Codex. Adicionar cliente ACP em uma fase posterior usando os mesmos contratos de conversa e eventos.

**Tech Stack:** TypeScript, Vite e canvas existentes; Electron; Pi SDK; Vitest; Playwright para os fluxos desktop; Electron Forge para empacotamento inicial. Fixar versões compatíveis após a qualificação técnica, incluindo a versão Node embutida no Electron.

**Spec:** Seções 1–4 deste documento constituem a especificação de produto e arquitetura deste plano.

Data: 2026-10-24. Estado: planejamento; nenhuma funcionalidade desktop ou integração Pi foi implementada por este documento.
Base examinada: Habblaud 1.0.3, main em faa1a012b5fbf632c66dc6801c5383e53a542406. Revalidar o HEAD ao iniciar a execução.
Destino: https://github.com/Stoltembergg/Office-Bots (repositório independente, renomeado de habblaud).

## 1. Produto e limites

### Experiência pretendida

Instalar o app, selecionar uma pasta de projeto, conectar um provedor permitido, escolher explicitamente um modelo e conversar com um agente dentro do app. Mensagens, ferramentas, aprovações, erros e conclusão atualizam o chat e o personagem do escritório. Fechar e reabrir o app permite continuar a conversa persistida.

O escritório em pixel art é a identidade do produto. Reaproveitar canvas, personagens, salas, animações e interface existentes. Não migrar para React nem reescrever a simulação para entregar o desktop.

### Três origens de sessão

| Origem | Execução | Controle |
| --- | --- | --- |
| managed-pi | Pi SDK no worker do app | Criar, conversar, cancelar e retomar sessões próprias |
| observed-cli | Claude Code/Codex externos, detectados pelas fontes atuais | Observar; mensagens e permissões apenas quando a integração existente confirmar suporte |
| external-acp | Agente iniciado/conectado por adaptador ACP, fase posterior | Capacidades negociadas; retomada e listagem somente se suportadas |

Pi com um modelo Claude não é Claude Code; Pi com um modelo do provedor Codex não é Codex CLI. Não identificar personagens Pi como instâncias desses produtos. Importar um transcript como contexto não equivale a retomar a sessão original. ACP não garante anexação a um processo já ativo em outro terminal.

### MVP

- Windows x64 e macOS arm64/x64; suporte mínimo de versões de sistema definido na qualificação e publicado antes da beta.
- Instalador independente de Node, npm e Docker na máquina do usuário.
- Um runtime Pi; múltiplas conversas, um turno ativo por conversa; no máximo dois turnos simultâneos no MVP, com fila visível.
- Chat em streaming, ferramentas, permissões, cancelamento, histórico persistente, seleção de projeto/provedor/modelo.
- Monitoramento legado preservado e opcional; não instalar hooks sem solicitação do usuário.
- Autenticação conforme o suporte técnico e as condições de cada provedor. A primeira conversa real pode usar uma API key; OAuth tem qualificação própria e não é pré-requisito do shell desktop.
- Sem conta obrigatória do nosso produto e sem backend de inferência próprio.

### Fora do MVP

ACP, coordenação automática de subagentes, colaboração entre máquinas, marketplace, cobrança, aplicativo móvel, sincronização em nuvem, migração de Electron para Tauri e servidor World próprio. Preservar recursos legados, mas não expandi-los nesta entrega.

O backend do Habblaud World não está neste repositório. No perfil desktop novo, World fica desligado por padrão e sem reutilização automática da conta anterior. Não alterar silenciosamente a configuração de instalações web existentes.

## 2. Estado atual e reaproveitamento

- client/: TypeScript/Vite, canvas e interface; não há shell Electron.
- server/index.ts: inicialização atual; extrair ciclo de vida reutilizável sem alterar o modo web.
- server/model/office.ts e server/sources/registry.ts: modelo e fontes de atividade.
- server/messages/registry.ts: entrega legada; Claude usa plugin/inbox; Codex usa codex queue em server/messages/codex.ts.
- server/permissions/: pedidos legados. Não reaproveitar IDs sem namespace de runtime/sessão.
- server/pty/: terminal opcional e código específico de plataforma; qualificar o node-pty para a ABI Electron quando necessário.
- server/updates/checker.ts: consulta releases; não instala atualizações.
- .github/workflows/ci.yml: validação Ubuntu. Ainda não comprova instaladores Windows/macOS.
- package.json: Node >=22.12, metadados ainda apontam ao upstream. Pi atual pode exigir versão maior; atualizar engines e CI juntos após qualificar.

A afirmação antiga de servidor sem dependências de runtime deixará de descrever o perfil desktop com Pi. Atualizar documentação e manifestos sem fingir que Pi é apenas ferramenta de build.

## 3. Arquitetura e contratos propostos

### Processos

1. Renderer: interface, canvas e estado de apresentação; sem Node, filesystem, tokens ou import de Pi.
2. Main/preload: janela, seletor nativo de pasta, cofre de credenciais, validação de IPC, menus, notificações e supervisor.
3. Worker local: sessões Pi, execução de ferramentas, eventos e persistência de contexto. Falha do worker não derruba a janela.
4. Servidor legado: serviço gerenciado pelo supervisor, com adaptador explícito para eventos Pi. Preservar execução web independente.

Decisão proposta: manter os recursos web legados via loopback e abrir a janela apenas após readiness; porta dinâmica no desktop, porta 4747 preservada no modo web. As operações Pi e credenciais passam por preload/IPC; não ficam expostas nas rotas legadas nem no acesso remoto. O worker comunica com o main por canal privado de processo, não por porta pública.

### Estrutura nova

| Caminho | Responsabilidade |
| --- | --- |
| desktop/main.ts, preload.ts, window.ts | Bootstrap e ponte mínima |
| desktop/supervisor.ts, ipc.ts | Ciclo de processos e autorização de mensagens |
| desktop/credentials.ts, auth.ts | Cofre do sistema e autenticação |
| desktop/forge.config.ts | Empacotamento e makers |
| server/app.ts | startServer(options) e stop() extraídos do bootstrap |
| server/agents/runtime.ts, manager.ts | Fachada e coordenação de sessões |
| server/agents/pi/runtime.ts, worker.ts | Integração exclusiva com SDK e processo worker |
| server/agents/pi/tools.ts, permissions.ts | Ferramentas controladas e aprovações |
| server/agents/sessions.ts, office-source.ts | Índice persistente e projeção de atividade |
| shared/agents/contracts.ts, validation.ts | Tipos e validação dos envelopes |
| client/src/agents/transport.ts | Ponte desktop; ausência detectável no modo web |
| client/src/ui/chat/ | Conversa, compositor, ferramentas e permissões |
| tests/desktop/ | Smoke e fluxos do app empacotado |
| docs/desktop/ | Evidências, matriz de compatibilidade e guias |

Não criar pastas vazias nesta tarefa de documentação. Confirmar nomes/assinaturas reais do SDK no marco 0.

### Contrato interno v1

Definir em shared/agents/contracts.ts, sem exportar tipos privados do SDK:

- RuntimeKind = 'pi' | 'acp'; SessionOrigin = 'managed-pi' | 'observed-cli' | 'external-acp'.
- ModelSelection = {providerId: string; modelId: string; accountId: string; thinkingLevel?: string}.
- SessionConfig = {projectId: string; cwd: string; selection: ModelSelection}.
- SessionInfo = {id: string; origin: SessionOrigin; runtimeSessionId: string; projectId: string; selection: ModelSelection; state: SessionState}.
- SessionState = 'idle' | 'running' | 'waiting-permission' | 'cancelling' | 'interrupted' | 'error' | 'closed'.
- PromptInput = {messageId: string; text: string}; reenvio do mesmo messageId não inicia outro turno.
- AgentEvent = {schemaVersion: 1; sessionId: string; runId: string; seq: number; at: string; type: AgentEventType; payload: unknown}.
- AgentEventType = 'message-start' | 'text-delta' | 'message-end' | 'tool-start' | 'tool-end' | 'permission-request' | 'state' | 'usage' | 'error'. Implementar união discriminada para payloads por tipo antes de expor IPC.
- RuntimeCapabilities = {resume: boolean; list: boolean; permissions: boolean; attachments: boolean; modelSelection: boolean}.
- AgentRuntime: capabilities(); create(config): Promise<SessionInfo>; resume(id): Promise<SessionInfo>; prompt(id, input): Promise<void>; cancel(id): Promise<void>; close(id): Promise<void>; subscribe(listener): () => void.
- SessionManager: list(projectId?); get(id); create(config); resume(id); prompt(id,input); cancel(id); close(id). Roteia por runtime e valida capacidades.
- PermissionDecision = {requestId: string; sessionId: string; runId: string; decision: 'allow-once' | 'deny'}.
- CredentialStore: get(accountId): Promise<Credential | null>; set(accountId, credential): Promise<void>; delete(accountId): Promise<void>. Credential nunca atravessa o renderer.

A API session.prompt resolve ao fim do turno; recibo de aceitação e eventos são separados. seq ordena eventos por sessão; um turno tem apenas um estado terminal. Uso desconhecido permanece ausente, sem valores inventados.

Persistência: SDK é fonte de verdade do contexto Pi; índice próprio guarda referências, metadados e versão de esquema. Não manter duas cópias concorrentes do contexto. Usar app.getPath('userData'), escritas atômicas e um writer por sessão. Não abrir arquivos de sessões das CLIs com o SessionManager do Pi.

### Alternativas consideradas

- Codex App Server + Claude Agent SDK: preserva os runtimes específicos, mas exige duas integrações; manter como opção futura se houver requisito explícito.
- ACP desde o início: reduz diferenças entre agentes externos, mas adiciona negociação e gestão de adaptadores ao primeiro lançamento.
- Pi SDK primeiro: abordagem adotada para este plano; agente próprio e eventos comuns para provedores diferentes. Requer implementar políticas de ferramentas e não herda os recursos completos das CLIs.

## 4. Regras globais

- Usuário escolhe provedor, conta e modelo. Nunca trocar automaticamente ou fazer fallback não configurado.
- OAuth autentica; Pi/ACP define como o agente opera. Não expor uma falsa escolha excludente 'OAuth ou ACP'.
- Credenciais somente no cofre do sistema ou armazenamento cifrado protegido por ele. Falha do cofre bloqueia persistência; nunca salvar em texto puro silenciosamente.
- BrowserWindow: nodeIntegration=false, contextIsolation=true, sandbox=true; preload com allowlist, validação de remetente e payload; sem shell/exec genérico exposto.
- Workspace aprovado explicitamente; resolver realpath, symlinks e limites antes de cada operação de arquivo. Política de ferramentas não equivale a sandbox de sistema operacional.
- MVP: leitura dentro do workspace; gravação e comandos exigem aprovação por execução. Negações, timeout de 120 s, fechamento e cancelamento não podem aprovar ferramentas.
- Uma aprovação vale para requestId + sessionId + runId + argumentos imutáveis. Pedido resolvido ou expirado não pode ser reaplicado.
- Login no navegador do sistema por fluxo suportado; nenhum segredo em logs, URLs de diagnóstico, snapshots do escritório ou renderer. Redigir logs não substitui separação de processos.
- Não prometer uso comercial de OAuth por simples presença no SDK. Registrar suporte e condições por provedor; documentação Anthropic consultada contém divergências sobre login de terceiros, a resolver antes de oferecer esse fluxo no produto.
- Frontend usa tr('texto em PT'); traduções en/es/fr; mudanças visíveis em Não lançado no CHANGELOG.md.
- Preservar LICENSE MIT, atribuições upstream, modo web, fontes legadas e seus controles de acesso.
- Demo não chama modelos, não lê credenciais reais e não envia atividade fictícia ao World.

## Review Focus

1. Fechamento/crash durante escrita: contexto consistente, turno interrompido e nenhum reenvio automático de comando.
2. Caminhos com espaços, acentos, symlinks, UNC e WSL: seleção correta ou incompatibilidade explícita, sem escapar do workspace.
3. OAuth cancelado/token expirado/cofre indisponível: erro recuperável e nenhuma credencial vazada ou fallback de cobrança.
4. Eventos atrasados/duplicados e aprovação de outra sessão: sem duplicar mensagem, execução ou conclusão.
5. Atualização com sessão ativa ou pacote inválido: preservar dados e trabalho; instalação bloqueada até estado seguro.

## 5. Marcos, dependências e execução

Ordem: M0 → M1 → M2 → M3 → M4 → M5 → M6. ACP é M7 e não bloqueia o MVP. Cada tarefa deve terminar com commit focado e evidência; itens começam desmarcados.

### M0 — Qualificar dependências e estabelecer a base

**Arquivos:** criar docs/desktop/qualification.md; inspecionar package.json, package-lock.json, .npmrc, tsconfig.json, server/tsconfig.json, vitest.config.ts, scripts/build-server.mjs e server/index.ts.
**Interfaces produzidas:** matriz de versões Electron/Node/Pi, capacidades de autenticação por provedor, plataformas e comandos reproduzíveis.

- [ ] Rodar npm ci, npm run typecheck, npm test, npm run build e npm run i18n:check; registrar falhas preexistentes separadas.
- [ ] Qualificar uma versão fixa de Pi em diretório temporário, confirmar exports e hooks de ferramentas/permissão. Documentar alterações necessárias de versão Node e políticas de instalação do .npmrc.
- [ ] Provar em processo isolado: prompt, text-delta, uso, ferramenta negada, cancelamento e retomada em workspace temporário; teste real somente com conta e custo explicitamente autorizados.
- [ ] Preencher matriz Windows nativo/WSL/macOS Intel/Apple Silicon e versão mínima de SO suportada pelo Electron escolhido; WSL sem evidência permanece não suportado.
- [ ] Documentar por provedor: API key/OAuth, endpoints oficiais, refresh, logout, elegibilidade e distribuição. Não transportar tokens de apps terceiros para endpoints não documentados.
- [ ] Commit: docs: qualify desktop and Pi integration. Gate: SDK permite interceptar toda escrita/comando antes do efeito; caso contrário usar ferramentas customizadas ou bloquear integração até resolver.

### M1 — Aplicativo Electron executável

**Arquivos:** criar desktop/{main,window,preload,supervisor,ipc}.ts, desktop/forge.config.ts, desktop/tsconfig.json; criar server/app.ts; modificar server/index.ts, package.json e scripts/build-server.mjs; testes desktop/supervisor.test.ts e desktop/ipc.test.ts.
**Interfaces:** startServer({host,port,dataDir,profile}): Promise<{url:string;stop():Promise<void>}>; supervisor.start()/stop(); profile='web'|'desktop'.

- [ ] Escrever testes: readiness antes de abrir janela; porta ocupada não mata serviço alheio; segundo lançamento foca instância existente; remetente IPC externo é recusado.
- [ ] Extrair bootstrap e implementar supervisor com cleanup; portar recursos estáticos para pacote/ASAR e respeitar diretórios graváveis separados.
- [ ] Criar scripts desktop:dev, desktop:build, desktop:package e desktop:test; incluir typecheck desktop. Não renomear scripts web existentes.
- [ ] Executar npm run desktop:test e npm run desktop:package em Windows e macOS; abrir build sem Node externo e registrar logs/evidência.
- [ ] Commit: feat: add Electron desktop shell. Gate: escritório legado abre no pacote, encerra processos próprios e mantém npm start funcional.

### M2 — Contrato de sessões e worker Pi

**Arquivos:** criar shared/agents/{contracts,validation}.ts; server/agents/{runtime,manager,sessions}.ts; server/agents/pi/{runtime,worker}.ts; testes adjacentes manager.test.ts, sessions.test.ts e pi/runtime.test.ts.
**Consome:** contratos da seção 3 e supervisor M1. **Produz:** AgentRuntime Pi e SessionManager, sem UI dependente de tipos Pi.

- [ ] Testar com runtime falso: mensagem duplicada inicia um turno; terceiro turno global entra em fila; duas mensagens na mesma sessão não concorrem; cancelar fila não executa prompt.
- [ ] Implementar adaptador SDK somente no worker; correlacionar runId/seq e normalizar eventos. Não carregar extensões arbitrárias do usuário automaticamente.
- [ ] Testar persistência: reabrir histórico, migração de índice, arquivo truncado em quarentena e referência inválida; sessões running após crash viram interrupted.
- [ ] Implementar índice atômico, locks, recuperação e seleção persistente. Mudança de modelo apenas por ação explícita em sessão ociosa; nunca migrar contexto silenciosamente.
- [ ] Rodar npx vitest run server/agents e npm run typecheck; registrar resultado e commit feat: add managed Pi sessions.

### M3 — Ferramentas, aprovações e autenticação

**Arquivos:** criar server/agents/pi/{tools,permissions}.ts, desktop/{credentials,auth}.ts, shared/agents/auth.ts; testes adjacentes e fixtures sintéticas.
**Interfaces:** AuthService.listMethods(providerId), begin(providerId,method), cancel(attemptId), status(accountId), logout(accountId); begin retorna attemptId e eventos públicos sanitizados. Broker.request({sessionId,runId,tool,args}): Promise<'allow-once'|'deny'>; resolve(PermissionDecision).

- [ ] Testar leitura/escrita fora do workspace, escape por symlink e mudança de destino entre validação e operação; impedir efeitos fora do escopo aprovado.
- [ ] Testar comando/gravação negados antes da execução, aprovação cruzada, replay, timeout 120 s, cancelamento com pedido aberto e processo filho após abort.
- [ ] Implementar ferramentas controladas com apresentação dos argumentos/diff, cwd fixo e rastreamento de processos. Não alegar sandbox forte para comandos autorizados que podem acessar o sistema.
- [ ] Testar auth cancelado, state inválido, callback não permitido, refresh concorrente e falha do cofre; renderer só recebe identificação sanitizada e status.
- [ ] Implementar API key e OAuth apenas para métodos qualificados em M0; delegar fluxo suportado ao SDK quando disponível. Não criar cliente OAuth usando identidade emprestada de outro aplicativo. Logout remove segredo local e informa separadamente eventual revogação remota.
- [ ] Verificar testes com provedor falso e inspeção de logs/IPC; teste pago real é opt-in. Commit feat: add controlled tools and provider authentication.

### M4 — Chat dentro do escritório

**Arquivos:** criar client/src/agents/transport.ts; client/src/ui/chat/{controller,view,composer,tools,permissions}.ts e chat.css; modificar client/src/ui/{drawer,settings,spawn}.ts e client/src/app.ts; criar server/agents/office-source.ts; integrar server/model/office.ts e server/sources/registry.ts conforme interfaces reais; atualizar shared/locales e CHANGELOG.md.
**Interfaces:** transport expõe métodos tipados de SessionManager, AuthService e assinatura AgentEvent pelo preload; web sem ponte retorna capability indisponível, sem endpoint público substituto.

- [ ] Testar clique em personagem abre a conversa correta; text-delta fora de ordem não corrompe resposta; mensagens são renderizadas como conteúdo sem HTML executável.
- [ ] Implementar seletor de projeto por diálogo nativo, conta/provedor/modelo, nova conversa, histórico, envio, fila, cancelamento e estados de autenticação.
- [ ] Mostrar comandos, diffs, resultados e botões de permissão vinculados ao pedido exato; desabilitar respostas expiradas; conservar rascunho após erro recuperável.
- [ ] Testar projeção Pi → escritório: running/trabalhando, waiting-permission/precisa de você, idle/ocioso, erro e encerramento; deduplicar IDs por origem e não duplicar personagem pelo watcher legado.
- [ ] Projetar apenas eventos confirmados; não simular status de ferramentas como fatos. Manter comportamento social visual e modo demo independentes da execução.
- [ ] Rodar testes de client/src/ui/chat, server/agents e i18n:check; validar visualmente demo e execução de fixture em janelas pequenas/HiDPI. Commit feat: add managed agent chat to office.

### M5 — Confiabilidade e experiência de instalação

**Arquivos:** criar desktop/{tray,notifications,diagnostics}.ts e testes; completar desktop/supervisor.ts; criar docs/desktop/{privacy,compatibility,qa}.md; atualizar READMEs e metadados de package.json para Office-Bots sem apagar atribuições upstream.
**Interfaces:** diagnóstico sanitizado, lifecycle do worker e configurações persistidas versionadas.

- [ ] Testar suspensão/retomada, reinício do worker, rede offline, credencial revogada, limite do provedor e encerramento com comando ativo; nenhuma ferramenta de efeito colateral é repetida automaticamente.
- [ ] Implementar bandeja/menu bar, notificações sem conteúdo sensível por padrão, abrir projeto e opção de inicialização no login. Fechar janela pede escolha quando há trabalho ativo; sair encerra apenas processos próprios.
- [ ] Fazer retenção/exclusão de histórico e export de diagnóstico explícitos; não incluir prompts, tokens, paths privados ou comandos completos em diagnóstico padrão.
- [ ] Atualizar privacidade: histórico permanece local, porém prompts/contexto necessários são enviados ao provedor escolhido. Não manter a antiga promessa absoluta de que nada sai da máquina no modo Pi.
- [ ] Qualificar terminal/node-pty com a ABI selecionada; omitir recurso no pacote somente com indicação clara e aceite registrado, nunca sucesso falso.
- [ ] Validar em contas limpas Windows/macOS e npm start legado. Commit feat: harden desktop lifecycle and onboarding.

### M6 — Distribuição e atualização

**Arquivos:** criar .github/workflows/desktop.yml e desktop-release.yml, desktop/updater.ts e updater.test.ts, docs/desktop/releases.md; modificar configuração Forge e scripts; integrar configuração de atualização sem executar o checker legado e o updater desktop em duplicidade.
**Interfaces:** Updater.check(), download(), installWhenIdle(); canais beta/stable; resultado de verificação apresentado na UI.

- [ ] CI: manter Ubuntu existente e adicionar Windows x64/macOS arm64/x64, cache por SO/arquitetura e smoke do pacote. Artefatos sem credenciais de contas reais.
- [ ] Gerar instalador Windows e DMG/ZIP macOS; assinar Windows, assinar e notarizar macOS antes da beta pública; segredos somente no ambiente de release.
- [ ] Escolher endpoint público de distribuição/update ou serviço autenticado próprio. Código privado pode permanecer privado; nunca embutir PAT do GitHub para acessar releases privadas.
- [ ] Testar pacote adulterado/assinatura inválida/arquitetura errada e atualização com tarefa ativa; instalação deve ser bloqueada nesses casos. Persistir dados antes de reiniciar e não retomar comandos automaticamente.
- [ ] Documentar estratégia de recuperação e compatibilidade do schema; se migração impede downgrade, bloquear retorno e preservar backup.
- [ ] Publicar beta somente após checklist manual de instalação limpa, chat, ferramenta aprovada/negada, cancelamento, restart, update e uninstall preservando dados por padrão.
- [ ] Commit build: add signed desktop release pipeline. Gate de lançamento depende de certificados e configuração reais; ausência desses itens deve ser reportada, não contornada.

### M7 — ACP posterior, sem bloquear MVP

**Arquivos:** criar server/agents/acp/{client,runtime,process}.ts e testes; estender manager.ts e UI de conexões; docs/desktop/acp.md.
**Consome:** AgentRuntime e contratos M2. **Produz:** segundo runtime, separado de Pi.

- [ ] Qualificar versões fixas de protocolo/adaptadores e autenticação efetivamente suportada por Codex e Claude; não presumir OAuth pelo nome do adaptador.
- [ ] Testar handshake, capacidades ausentes, prompt, permissão, cancelamento, desconexão, replay e eventos inválidos com agente ACP falso por stdio.
- [ ] Implementar adaptador ACP; executar binário selecionado explicitamente e com versões verificáveis. Não executar downloads de adapters arbitrários automaticamente.
- [ ] Exibir criar/listar/retomar apenas quando disponíveis. Testar retomada com adaptadores reais separadamente de conexão a sessão ativa externa.
- [ ] Manter origin/runtimeSessionId distintos; não converter sessão Pi em Codex/Claude nem substituir o modelo escolhido.
- [ ] Rodar suíte de contrato para Pi e ACP e smoke dos adaptadores; commit feat: add optional ACP agent connections.

## 6. Critérios finais e acompanhamento

### Pronto para MVP

- [ ] Instalação limpa nos três alvos, sem runtime externo.
- [ ] Conta/provedor/modelo escolhidos explicitamente; login e logout funcionais nos métodos habilitados.
- [ ] Nova conversa, streaming, leitura, escrita/comando aprovado ou negado e cancelamento comprovados.
- [ ] Histórico retomado após restart e crash sem executar de novo efeitos colaterais.
- [ ] Personagem acompanha apenas eventos reais e não duplica sessões legadas.
- [ ] Modo web e testes atuais preservados; diferenças documentadas.
- [ ] Instaladores assinados, macOS notarizado, atualização verificada e canal acessível aos usuários.
- [ ] README, privacidade, licenças, diagnóstico e instruções de suporte atualizados.

Ao concluir cada marco, acrescentar evidências em docs/desktop/progress.md: commit, ambiente, comandos, resultado, captura/demo sem dados reais e limitações. Não marcar item por ter escrito código; marcar somente após verificar a entrega. Estimativas de calendário dependem da qualificação M0 e das credenciais de distribuição.

## 7. Fontes e decisões que precisam de revalidação

Consultadas em 2026-10-24; reler antes de fixar dependências ou distribuir autenticação:

- Pi SDK: https://pi.dev/docs/latest/sdk
- Provedores Pi: https://pi.dev/docs/latest/providers
- Pi upstream atual (redirecionamento do pi-mono): https://github.com/earendil-works/pi
- Segurança Electron: https://www.electronjs.org/docs/latest/tutorial/security
- Assinatura/notarização: https://www.electronjs.org/docs/latest/tutorial/code-signing
- ACP: https://agentclientprotocol.com/protocol/v1/overview
- Adaptador Codex: https://github.com/agentclientprotocol/codex-acp
- Adaptador Claude: https://github.com/agentclientprotocol/claude-agent-acp
- Claude SDK: https://code.claude.com/docs/en/agent-sdk/overview
- Uso do SDK com planos Claude: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

A presença de OAuth numa biblioteca não garante aprovação comercial do provedor. Essa verificação é um requisito de distribuição, sem impedir o desenvolvimento local das interfaces e dos testes simulados.
