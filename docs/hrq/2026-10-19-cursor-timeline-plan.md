# Linha do tempo do agente Cursor — plano

Branch: `feat/cursor-adapter`.  
Design: `docs/hrq/2026-10-19-cursor-timeline-design.md`.

## Tasks

1. Docs `docs/hrq/2026-10-19-cursor-timeline-{design,plan}.md`.
2. `server/sources/cursor/transcript.ts` — `parseCursorStore(path)` → `{ activities, title?, stats?, maxRowId }`; fixture `store.db` + testes.
3. `CursorSource` — tracker com `storePath` / `lastRowId` / `seenIds`; no poll, se mtime mudou, parse incremental; boot `mergeHistory`, live `addActivity`; `applyTranscript` com `stats.toolCalls` quando possível.
4. `npm test` e `npm run typecheck`.

## Fora deste plano

- Decrypt da árvore / `blobEncryptionKey`.
- Terminal SSE / `transcriptPathOf` real.
- Hooks e aprovações (fase 3).
- Leitura de `~/.cursor/projects/**/agent-transcripts`.
