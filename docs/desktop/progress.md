# Progresso do desenvolvimento desktop

## M0 — qualificação de dependências e base

Estado: concluído em 2026-10-24. Base: `11ba85e986383ad0cbf0e4e66f4b81b62b9a1bbd`. Branch de trabalho: `feat/desktop-foundation`.

Registro completo de versões, fontes, matriz e limitações: [qualification.md](qualification.md). Commit focado: `docs: qualify desktop and Pi integration`.

Validação executada em Linux x86_64 com Node 24.19.0/npm 11.9.0: `npm ci`, `npm run typecheck`, `npm test` (1.882 passaram, 2 skipped) e `npm run build` passaram. `npm run i18n:check` encontrou uma restrição EPERM do IPC do `tsx`; o mesmo script passou por `node --import tsx/esm scripts/i18n-check.ts` (2.982/2.982 textos em en/es/fr). Pi SDK `1.4.0` passou o processo isolado com provedor falso para streaming, uso, bloqueio de bash e escrita antes de efeitos, cancelamento e retomada.

Limites: nenhuma chamada de modelo paga ou autenticação real; nenhum build/smoke em Windows, WSL, macOS Intel ou Apple Silicon. OAuth Claude.ai/Codex não está qualificado para distribuição conforme a matriz. Não declarar instaladores nem suporte de plataforma com base nesta máquina Linux.

## M1 — shell desktop Electron

Estado: implementação local pronta; verificação nativa Windows/macOS aguarda a matriz de CI após envio da branch. O shell inicia o servidor em `127.0.0.1` numa porta escolhida pelo sistema, espera o listener ficar pronto antes de criar a janela e guarda estado em `userData`. O perfil desktop desliga World, acesso remoto, atualização web e migração do diretório legado. A janela usa sandbox, context isolation e preload mínimo; o IPC só expõe a versão do app e valida origem, frame principal e `webContents`.

Commit do shell: `feat: add Electron desktop shell`.

O bootstrap passou para `server/app.ts`; `server/index.ts` continua sendo a entrada web de `npm start`. Foram adicionados os alvos `desktop:dev`, `desktop:build`, `desktop:package`, `desktop:test` e `desktop:typecheck`, Electron `45.0.0` e Forge `8.0.1`. O pacote inclui cliente, main e preload no ASAR; diretório de dados fica fora dele.

Validação Linux x64, Node 24.19.0/npm 11.9.0: `npm ci`, `npm run typecheck`, `npm run desktop:test` (11 testes), `npm test` (162 arquivos; 1.893 passaram, 2 skipped) e `npm run desktop:package` passaram. O Forge gerou um ZIP Linux. `npm start` iniciou numa porta web configurada e encerrou com SIGINT, preservando o modo web. O ASAR contém `dist/client/index.html`, `dist/desktop/main.mjs`, `dist/desktop/preload.cjs` e `package.json`.

Limite local: a janela empacotada não pôde ser aberta neste container porque a política do sistema bloqueia o socket Unix usado por `app.requestSingleInstanceLock()` (`socket() failed: Operation not permitted`). O smoke do executável foi adicionado a `.github/workflows/desktop.yml`, com Windows x64, macOS arm64 e Intel, além de Linux; os resultados ainda precisam ser observados depois do push. A revisão corrigiu a ordem de cleanup na falha do Vite, a precedência de `dev: false` e o padrão web para `HABBLAUD_PORT=0`. Isso não comprova suporte de plataforma até a matriz passar.
