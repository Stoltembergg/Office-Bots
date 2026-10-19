# Uso do plano Cursor no topo do Habblaud — plano

Branch: `feat/cursor-adapter`.  
Design: `docs/hrq/2026-10-19-cursor-usage-design.md`.

## Tasks

1. Estender `AccountUsage.source` com `'cursor'` em `shared/types.ts` (+ timeline se precisar).
2. Implementar `server/sources/cursor/usage.ts` + testes de parse.
3. Ligar poll de uso no `CursorSource` (`usagePollMs` default 60s, `authPath` / env).
4. Cliente: rótulos CM/OM, `SOURCE_LABEL.cursor`, tip Cursor, `providerOf` no cartão.
5. `npm test` e `npm run typecheck`.

## Fora deste plano

- Refresh automático do `refreshToken`.
- Enterprise Analytics / Admin API.
- Montagem Docker do `auth.json` (só host Node por enquanto).
