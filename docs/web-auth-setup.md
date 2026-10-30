# Configuração do login web

O OAuth do GitHub confirma apenas a identidade do usuário. A autorização de repositórios virá da instalação da GitHub App; o login não pede escopos de repositório e descarta o token do GitHub depois de obter o ID estável da conta.

## Variáveis de ambiente do servidor

Configure estas variáveis nas funções Node da Vercel:

| Variável | Valor |
| --- | --- |
| `OFFICE_BOT_APP_ORIGIN` | Origem HTTPS do site, sem caminho, por exemplo `https://office-bots.example` |
| `GITHUB_OAUTH_CLIENT_ID` | ID do OAuth App do GitHub |
| `GITHUB_OAUTH_CLIENT_SECRET` | Segredo do OAuth App do GitHub |
| `GITHUB_OAUTH_CALLBACK_URL` | URL exata: `<origem>/api/auth/github/callback` |
| `OFFICE_BOTS_DATABASE_URL` | Connection string do usuário de runtime do Postgres no Supabase, pelo pooler de transação, com `sslmode=require` |

Todas são variáveis somente do servidor. Não coloque esses valores no bundle do navegador nem em arquivos versionados.

## Banco de dados

As migrações criam o schema privado `office_bots_private` e o papel sem login `office_bots_auth_runtime`, com acesso apenas às tabelas de estado OAuth e sessão. Depois de aplicar as migrações no projeto Supabase escolhido, crie um usuário de login com senha gerada para o ambiente:

```sql
CREATE ROLE office_bots_auth_login LOGIN PASSWORD '<senha-aleatoria>' IN ROLE office_bots_auth_runtime;
```

Use esse usuário no connection string do pooler de transação e salve a URL completa em `OFFICE_BOTS_DATABASE_URL` na Vercel. Não use o usuário `postgres` nem uma chave `service_role` na aplicação.

O estado OAuth é curto e de uso único. O verificador PKCE fica no schema privado; o banco guarda somente o hash do token de sessão e permite sua revogação. Nenhum papel `anon` ou `authenticated` recebe acesso às tabelas.

Ainda não há um projeto Supabase vinculado a este repositório. Escolha ou crie o projeto do Office Bots antes de vincular a CLI e aplicar as migrações. Os projetos existentes da conta não foram alterados.

## OAuth do GitHub

Cadastre o callback HTTPS exato como `GITHUB_OAUTH_CALLBACK_URL`. O fluxo usa `state`, PKCE S256 e um cookie temporário vinculado ao navegador. A sessão do Office Bots dura sete dias e usa cookie opaco `HttpOnly`, `Secure` e `SameSite=Lax`. Logout exige `POST` da mesma origem.

As rotas desta etapa são `GET /api/auth/github/start`, `GET /api/auth/github/callback`, `GET /api/session` e `POST /api/logout`. A seleção de repositórios ainda depende da instalação e validação da GitHub App.
