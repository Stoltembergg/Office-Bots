# Uso do plano Cursor no topo do Habblaud — design

Branch: `feat/cursor-adapter`.  
Contexto: `docs/hrq/CONTEXTO.md` (passo 3).  
Depende do MVP de observação Cursor já na pasta `server/sources/cursor/`.

## Objetivo

Mostrar no cartão da conta `.cursor` (barra superior de uso) os dois pools do plano
legado Cursor — **Cursor Models** e **Other Models** — alinhados ao dashboard Spending.

## Decisões

| Tema | Escolha |
| --- | --- |
| Fonte | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Auth | `~/.config/cursor/auth.json` (`accessToken`), só no host; nunca no snapshot |
| Override | `HABBLAUD_CURSOR_AUTH` |
| Poll | ~60 s (+ uma leitura no boot da fonte) |
| Medidores | `fiveHour` ← `autoPercentUsed` (rótulo CM); `sevenDay` ← `apiPercentUsed` (rótulo OM) |
| `resetsAt` | `billingCycleEnd` nos dois |
| `AccountUsage.source` | `'cursor'` |
| Refresh de token | Fora do MVP; 401 → usage disabled/stale sem derrubar agentes |
| Token no cliente | Proibido |

## Arquitetura

1. `server/sources/cursor/usage.ts` — lê auth, chama a API, normaliza para `AccountUsage`.
2. `CursorSource` — timer de uso + `accounts.setUsage('.cursor', usage)`.
3. Cliente `usage.ts` — se `provider === 'cursor'`, rótulos CM/OM e tip de login do CLI.

## Critério de pronto

Cartão Cursor no topo com % dos dois pools; idade coerente; token ausente do snapshot.
