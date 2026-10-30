# Office Bots — direção web e plano inicial

**Estado:** decisão de produto, não descrição de funcionalidades já entregues. Em 30/10/2026, o usuário decidiu substituir a direção desktop pelo produto web. Os registros históricos do desktop não comprovam capacidades web.

## Produto

Um site com escritório em pixel art no qual o usuário entra com GitHub, escolhe um repositório autorizado, conecta um provedor de IA e solicita revisões separadas por segurança, performance, testes e design. Os personagens devem refletir tarefas reais, não atividade inventada. Uma integração opcional com GitHub Actions pode ser avaliada depois do MVP.

## Decisões iniciais

- Serviço web com identidade e autorização por usuário e repositório; o servidor local legado não é infraestrutura multiusuário e não deve ser exposto como tal.
- GitHub App é a integração proposta para acesso granular a repositórios e eventos. Login do usuário, instalação da app e permissões concedidas são etapas distintas. Começar com acesso de leitura e pedir permissões adicionais apenas para ações explícitas.
- O serviço SaaS terá entrada e roteamento próprios, com lista explícita de rotas; não encaminhará requisições para as APIs locais legadas. Identidade GitHub e sessão do serviço não concedem por si só acesso a instalações ou repositórios: a autorização será verificada no backend por usuário, instalação e repositório em cada operação e job.
- O Office web substitui a página de prévia e reutiliza a arte procedural em pixel. A primeira tela mostra quatro agentes por área de revisão, sentados em suas estações; é um estado visual de espera, sem atividade ou histórico inventados. Login usa a sessão GitHub já disponível; seleção de repositório e revisões ainda dependem da GitHub App e dos próximos marcos.
- O usuário escolheu Supabase Postgres. Sessões e estado OAuth usam o schema privado `office_bots_private`; as funções Vercel conectam pelo pooler do Supabase com papel de banco limitado às tabelas de autenticação. A migração local não está aplicada a um projeto remoto.
- As rotas web usam funções Node da Vercel no mesmo host do Office. Segredos e a URL do banco ficam somente no ambiente servidor. O runtime não reutiliza APIs locais nem expõe o processo desktop como serviço multiusuário.
- Primeira integração de IA proposta: chave de API do usuário para OpenAI ou Anthropic, com provedor e modelo escolhidos explicitamente. Assinatura de ChatGPT ou Claude não equivale a acesso à API; OAuth depende de elegibilidade e termos atuais, não deve ser prometido antecipadamente. Credenciais somente no backend, cifradas e com gestão de chaves apropriada; nunca no navegador ou logs.
- Contrato de entrega decidido pelo usuário: cada tarefa solicitada para execução gera sua própria PR no repositório selecionado; tarefas independentes nunca são agrupadas, não há push direto à branch padrão nem merge automático. Para cumprir isso com segurança, a execução precisa de checkout isolado, limites de escopo e validação antes da abertura da PR.
- MVP proposto: selecionar manualmente um PR, gerar relatório das quatro categorias e visualizar achados. A revisão permanece somente leitura até a infraestrutura isolada de execução e criação de PR por tarefa ser implementada e validada; não disparar Actions. Comentários no GitHub ficam para etapa posterior e exigem ação explícita e permissão adicional.
- Enviar código ao provedor somente após consentimento claro, identificando provedor, escopo e custos. Definir retenção e exclusão de dados antes de armazenar código ou habilitar clientes reais. Evitar armazenar código além do necessário.
- Conteúdo de repositórios, PRs e saída de modelos é não confiável. Instruções nesses dados não concedem permissões. Validar resultados e, antes de publicar, conferir referência a arquivo e linhas no diff efetivo. Achados são sugestões, não garantia de segurança ou correção.

## Marcos

1. **Fundação verificável:** registrar esta direção e definir um contrato de relatório validado com testes sintéticos. Não é uma revisão funcional.
2. **Identidade e acesso:** em andamento. Login GitHub com PKCE, cookie vinculado ao navegador e sessão revogável têm handlers e persistência Supabase. A etapa da GitHub App agora inclui autorização OAuth vinculada à sessão Office, listagem dos repositórios das instalações acessíveis à conta e seleção persistida de um repositório por usuário. A integração ainda precisa de credenciais e migrações no projeto Supabase escolhido, além de validação de isolamento em ambiente integrado antes de ser publicada.
3. **Revisão e tarefas:** obter PR e diff com escopo limitado, integrar provedor permitido, processar tarefas com limites de uso e exibir relatórios. Quando o usuário pedir execução, cada tarefa deve gerar sua própria PR a partir de um checkout isolado. Testar com serviços falsos, inclusive falhas, cancelamento, isolamento entre tarefas e ausência de permissão.
4. **Eventos e publicação:** webhooks autenticados, deduplicação e tratamento de falhas; comentários apenas mediante ação explícita. Testar revogação e eventos repetidos.
5. **Automação opcional:** avaliar Actions e execução em ambientes isolados, permissões, segredos, custos e riscos de código não confiável antes de habilitar qualquer execução. Nenhuma capacidade de sandbox é presumida.

## Limites e verificação

Não publicar como serviço multiusuário até provar isolamento de dados e autorização com usuários distintos, gestão de segredos, proteção de sessão e política de privacidade apropriada. Webhooks precisam validar assinatura; trabalhos precisam de isolamento por usuário/repositório e controle de custos. Integrações reais exigem configuração e credenciais autorizadas, mas testes de rotina devem usar dados sintéticos e provedores falsos.

Para o login GitHub, o callback usa endereço HTTPS fixo e `state` aleatório, curto, de uso único e vinculado ao navegador. A troca de código ocorre no backend; a identidade usa o ID estável do GitHub. Sessões próprias são revogáveis, duram sete dias e usam cookies `HttpOnly`, `Secure` e `SameSite=Lax`; logout valida a origem. O banco grava apenas o hash da sessão e guarda o verificador PKCE temporariamente no schema privado. Testar falhas de rede, state inválido ou reutilizado, sessão expirada e ausência de configuração. Não disponibilizar o SaaS multiusuário antes de configurar credenciais, provar autorização e validar isolamento.

O canvas, tipos puros e partes do runtime podem ser avaliados para reuso; catálogo local, IPC Electron, sessões locais e API remota legada não devem ser considerados seguros para SaaS sem revisão. Preservar compatibilidade legada enquanto não houver decisão explícita de removê-la. O histórico de `docs/desktop/` permanece como registro do trabalho anterior.
