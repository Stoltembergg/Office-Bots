# Progresso do desenvolvimento desktop

## M0 — qualificação de dependências e base

Estado: concluído em 2026-10-24. Base: `11ba85e986383ad0cbf0e4e66f4b81b62b9a1bbd`. Branch de trabalho: `feat/desktop-foundation`.

Registro completo de versões, fontes, matriz e limitações: [qualification.md](qualification.md). Commit focado: `docs: qualify desktop and Pi integration`.

Validação executada em Linux x86_64 com Node 24.19.0/npm 11.9.0: `npm ci`, `npm run typecheck`, `npm test` (1.882 passaram, 2 skipped) e `npm run build` passaram. `npm run i18n:check` encontrou uma restrição EPERM do IPC do `tsx`; o mesmo script passou por `node --import tsx/esm scripts/i18n-check.ts` (2.982/2.982 textos em en/es/fr). Pi SDK `1.4.0` passou o processo isolado com provedor falso para streaming, uso, bloqueio de bash e escrita antes de efeitos, cancelamento e retomada.

Limites: nenhuma chamada de modelo paga ou autenticação real; nenhum build/smoke em Windows, WSL, macOS Intel ou Apple Silicon. OAuth Claude.ai/Codex não está qualificado para distribuição conforme a matriz. Não declarar instaladores nem suporte de plataforma com base nesta máquina Linux.

## M1 — shell desktop Electron

Estado: concluído em 2026-10-24. PR: https://github.com/Stoltembergg/Office-Bots/pull/1. O shell inicia o servidor em `127.0.0.1` numa porta escolhida pelo sistema, espera o listener ficar pronto antes de criar a janela e guarda estado em `userData`. O perfil desktop desliga World, acesso remoto, atualização web e migração do diretório legado. A janela usa sandbox, context isolation e preload mínimo; o IPC só expõe a versão do app e valida origem, frame principal e `webContents`.

Commits do shell: `feat: add Electron desktop shell`. O CI identificou que o maker Squirrel não tinha o campo obrigatório de autores; `desktop/forge.config.ts` agora informa `authors: 'Office Bots contributors'` (commit `586493ea246ce310e4cde9e645f071a5761b79ef`).

O bootstrap passou para `server/app.ts`; `server/index.ts` continua sendo a entrada web de `npm start`. Foram adicionados os alvos `desktop:dev`, `desktop:build`, `desktop:package`, `desktop:test` e `desktop:typecheck`, Electron `45.0.0` e Forge `8.0.1`. O pacote inclui cliente, main e preload no ASAR; diretório de dados fica fora dele.

Validação local Linux x64, Node 24.19.0/npm 11.9.0: `npm run typecheck`, `npm run desktop:test` (11 testes), `npm test` (162 arquivos; 1.893 passaram, 2 skipped), `npm run desktop:package` e `npm start` em smoke web passaram. O Forge gerou um ZIP Linux. O ASAR contém `dist/client/index.html`, `dist/desktop/main.mjs`, `dist/desktop/preload.cjs` e `package.json`.

CI GitHub Actions, Node 22.19.0: `npm ci`, `npm run typecheck`, `npm run desktop:test`, `npm run desktop:package` e smoke do pacote passaram em Ubuntu x64, Windows x64, macOS arm64 e macOS Intel. O job `verificar` também passou (`npm test` e `npm run build`).

Limite local: a janela empacotada não pôde ser aberta neste container porque a política do sistema bloqueia o socket Unix usado por `app.requestSingleInstanceLock()` (`socket() failed: Operation not permitted`). O smoke do executável passou nos runners nativos da matriz. Assinatura dos instaladores, notarização macOS e QA manual de instalação permanecem para M6; estes checks não comprovam tais etapas. A revisão também corrigiu a ordem de cleanup na falha do Vite, a precedência de `dev: false` e o padrão web para `HABBLAUD_PORT=0`.

## M2.1 — catálogo persistente de projetos e agentes

Escopo: primeiro incremento do M2, na branch `feat/persistent-agent-catalog`, baseado no HEAD `f8896c7` do PR #1 (ainda aberto). Cadastro versionado em `catalog.json`, referências de projeto validadas, pasta canônica, política de modelo por agente, arquivamento preservando identidade e bloqueio de edição enquanto o runtime informar turno ativo. O consumidor deve fornecer a consulta síncrona de ocupação ao construir o store. Nenhuma inferência, conta, rota HTTP ou IPC foi adicionada.

Decisão: compartilhar um catálogo versionado para projetos e agentes, com lock exclusivo por diretório e substituição atômica por rename. Colisão de writer falha sem sobrescrever; lock deixado por crash requer resolução explícita após confirmar que o processo terminou. Arquivo inválido ou versão desconhecida é preservado e bloqueia gravações. Recuperação/quarentena e sessões serão entregues em incrementos posteriores.

M2 permanece em andamento: worker Pi, conversas, fila, deduplicação de mensagens e integração do guard de arquivamento ao início de turno ainda não foram implementados. O serviço de cadastro não está conectado à interface nesta etapa.

Validação M2.1 em Linux x64, Node 24.19.0/npm 11.9.0: teste novo falhou inicialmente pela ausência do catálogo; após implementação, 9/9 testes de catálogo passaram. `npm run typecheck`, `npm test` (1.902 passaram, 2 skipped) e `npm run build` passaram. `git diff --check` passou. O checker i18n encontrou somente a lacuna preexistente do M1 `Encerrando o servidor desktop/web…` nos três idiomas; o novo erro de cadastro tem traduções en/es/fr.

Revisão independente do incremento: sem achados bloqueantes. Limitações preservadas: rename fornece substituição atômica, sem garantia de durabilidade contra perda de energia (sem fsync); o futuro SessionManager deverá serializar admissão de turnos e mutações do catálogo — a consulta síncrona de ocupação sozinha não impede corrida com um turno iniciado durante a gravação assíncrona. A resolução de modelo na conversa, os locks de sessão e a recuperação continuam no M2.
