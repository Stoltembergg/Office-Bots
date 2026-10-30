# Configuração de login e repositórios web

O login do GitHub confirma a identidade. A GitHub App concede acesso granular às instalações e aos repositórios selecionados; são etapas separadas. O Office Bots lista apenas os repositórios que o token de usuário da App consegue acessar e exige que o ID retornado pelo GitHub corresponda à sessão Office.

## Variáveis de ambiente do servidor

Configure estas variáveis nas funções Node da Vercel:

| Variável | Valor |
| --- | --- |
| `OFFICE_BOT_APP_ORIGIN` | Origem HTTPS do site, sem caminho, por exemplo `https://office-bots.example` |
| `GITHUB_OAUTH_CLIENT_ID` | Client ID usado para o login GitHub |
| `GITHUB_OAUTH_CLIENT_SECRET` | Segredo usado para o login GitHub |
| `GITHUB_OAUTH_CALLBACK_URL` | URL exata: `<origem>/api/auth/github/callback` |
| `GITHUB_APP_SLUG` | Slug da GitHub App, usado para abrir a tela de instalação |
| `GITHUB_APP_CLIENT_ID` | Client ID da GitHub App usada para listar repositórios |
| `GITHUB_APP_CLIENT_SECRET` | Segredo da GitHub App usado para trocar o código OAuth no servidor |
| `GITHUB_APP_CALLBACK_URL` | URL exata: `<origem>/api/github/app/callback` |
| `GITHUB_APP_ID` | ID numérico da GitHub App usado para assinar JWTs do servidor |
| `GITHUB_APP_PRIVATE_KEY` | Chave privada PEM da GitHub App, exclusiva do ambiente servidor |
| `OFFICE_BOTS_DATABASE_URL` | Connection string do usuário de runtime do Postgres no Supabase, pelo pooler de transação, com `sslmode=require` |

Todas são variáveis somente do servidor. O login pode usar a mesma GitHub App ou um OAuth App separado; se forem separados, use os client IDs e segredos correspondentes a cada fluxo.

## GitHub App

Cadastre a URL de callback exata em `GITHUB_APP_CALLBACK_URL`. O fluxo usa a autorização OAuth explícita com `state`, PKCE S256 e cookie temporário vinculado à sessão Office. Não é necessário ativar “Request user authorization (OAuth) during installation”: a pessoa instala a App, volta ao Office e autoriza a sincronização pelo botão **Conectar GitHub App**. Configure a URL pós-instalação para `<origem>/` para retornar ao Office.

Para listar e escolher repositórios, a permissão necessária é **Metadata: read-only**. Para listar PRs abertos, habilite também **Pull requests: read-only** e atualize a autorização da instalação quando o GitHub solicitar. Na tela de instalação, a pessoa escolhe se a App terá acesso a todos os repositórios ou apenas a alguns. O Office mostra somente os repositórios compartilhados pela instalação autorizada.

Ao abrir a lista de PRs, o servidor assina um JWT curto com `GITHUB_APP_ID` e `GITHUB_APP_PRIVATE_KEY`, solicita ao GitHub um token de instalação com a permissão `pull_requests: read` e restringe esse token ao único repositório selecionado. O servidor confirma o ID e o nome do repositório no GitHub e retorna até os 100 PRs abertos mais recentes. O token é descartado ao fim da chamada; não fica no banco, navegador ou logs. Essa etapa lê somente metadados de PR, sem baixar diffs, enviar código a modelos, comentar ou alterar o repositório. Se a chave privada não estiver configurada, login e seleção de repositório continuam disponíveis, mas a lista de PRs não.

## Banco de dados

As migrações criam o schema privado `office_bots_private` e o papel sem login `office_bots_auth_runtime`. Ele acessa apenas as tabelas de estado OAuth, sessão, metadados de repositório e escolha atual. Depois de aplicar todas as migrações no projeto Supabase escolhido, crie um usuário de login com senha gerada para o ambiente:

```sql
CREATE ROLE office_bots_auth_login LOGIN PASSWORD '<senha-aleatoria>' IN ROLE office_bots_auth_runtime;
```

Use esse usuário no connection string do pooler de transação e salve a URL completa em `OFFICE_BOTS_DATABASE_URL` na Vercel. Não use o usuário `postgres` nem uma chave `service_role` na aplicação. Nenhum papel `anon` ou `authenticated` recebe acesso às tabelas privadas.

O banco guarda apenas o hash da sessão, o state/verificador OAuth de curta duração, metadados necessários para exibir a lista e o repositório escolhido. O token de usuário do GitHub é usado apenas no callback para validar a identidade e ler instalações/repositórios; ele e eventuais tokens de atualização não são persistidos nem enviados ao navegador. A escolha fica associada ao ID numérico da conta GitHub. Uma sincronização que detecta que o repositório deixou de estar acessível remove seus metadados e escolha.

Ainda não há um projeto Supabase vinculado a este repositório. Escolha ou crie o projeto do Office Bots antes de vincular a CLI e aplicar as migrações. Os projetos existentes da conta não foram alterados.

## Rotas web

- `GET /api/auth/github/start` e `GET /api/auth/github/callback`: login com GitHub.
- `GET /api/session` e `POST /api/logout`: sessão Office e logout da mesma origem.
- `GET /api/github/app/authorize` e `GET /api/github/app/callback`: autorização e sincronização segura dos metadados.
- `GET /api/github/app/install`: redireciona apenas para a GitHub App configurada.
- `GET /api/github/repositories`: lista os metadados da conta autenticada.
- `PUT /api/github/repositories/selected`: escolhe ou remove a seleção, sempre verificando a propriedade da conta no backend e a origem do pedido.
- `GET /api/github/pull-requests`: lista metadados dos PRs abertos do repositório selecionado; não aceita IDs de repositório enviados pelo navegador.

O OAuth do login dura cinco minutos e é de uso único. Sessões do Office duram sete dias e usam cookies opacos `HttpOnly`, `Secure` e `SameSite=Lax`. A sincronização de repositórios também usa `state` curto, PKCE e cookie vinculado ao navegador; o callback confere novamente a sessão antes de aceitar o resultado.
