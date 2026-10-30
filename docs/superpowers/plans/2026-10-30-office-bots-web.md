# Office Bots — direção web e plano inicial

**Estado:** decisão de produto, não descrição de funcionalidades já entregues. Em 30/10/2026, o usuário decidiu substituir a direção desktop pelo produto web. Os registros históricos do desktop não comprovam capacidades web.

## Produto

Um site com escritório em pixel art no qual o usuário entra com GitHub, escolhe um repositório autorizado, conecta um provedor de IA e solicita revisões separadas por segurança, performance, testes e design. Os personagens devem refletir tarefas reais, não atividade inventada. Uma integração opcional com GitHub Actions pode ser avaliada depois do MVP.

## Decisões iniciais

- Serviço web com identidade e autorização por usuário e repositório; o servidor local legado não é infraestrutura multiusuário e não deve ser exposto como tal.
- GitHub App é a integração proposta para acesso granular a repositórios e eventos. Login do usuário, instalação da app e permissões concedidas são etapas distintas. Começar com acesso de leitura e pedir permissões adicionais apenas para ações explícitas.
- O serviço SaaS terá entrada e roteamento próprios, com lista explícita de rotas; não encaminhará requisições para as APIs locais legadas. Identidade GitHub e sessão do serviço não concedem por si só acesso a instalações ou repositórios: a autorização será verificada no backend por usuário, instalação e repositório em cada operação e job.
- A Vercel pode hospedar uma prévia estática do produto enquanto o SaaS é desenvolvido. A prévia não deve expor o servidor legado nem anunciar login, revisões ou atividade de agentes como funcionalidades prontas. O backend SaaS e sua persistência ainda precisam de desenho e implantação próprios.
- O usuário escolheu Supabase como banco de dados. O Postgres deve fornecer persistência compartilhada para sessões, estado OAuth e dados futuros do SaaS; detalhes de conexão, permissões, região e operação ainda precisam ser qualificados. A escolha não autoriza criar projetos, credenciais ou despesas automaticamente.
- Primeira integração de IA proposta: chave de API do usuário para OpenAI ou Anthropic, com provedor e modelo escolhidos explicitamente. Assinatura de ChatGPT ou Claude não equivale a acesso à API; OAuth depende de elegibilidade e termos atuais, não deve ser prometido antecipadamente. Credenciais somente no backend, cifradas e com gestão de chaves apropriada; nunca no navegador ou logs.
- MVP proposto: selecionar manualmente um PR, gerar relatório das quatro categorias e visualizar achados; sem executar código do repositório, publicar automaticamente, modificar arquivos ou disparar Actions. Comentários no GitHub ficam para etapa posterior e exigem ação explícita e permissão adicional.
- Enviar código ao provedor somente após consentimento claro, identificando provedor, escopo e custos. Definir retenção e exclusão de dados antes de armazenar código ou habilitar clientes reais. Evitar armazenar código além do necessário.
- Conteúdo de repositórios, PRs e saída de modelos é não confiável. Instruções nesses dados não concedem permissões. Validar resultados e, antes de publicar, conferir referência a arquivo e linhas no diff efetivo. Achados são sugestões, não garantia de segurança ou correção.

## Marcos

1. **Fundação verificável:** registrar esta direção e definir um contrato de relatório validado com testes sintéticos. Não é uma revisão funcional.
2. **Identidade e acesso:** sessão web segura, instalação GitHub App e seleção de repositórios autorizados; testes com dois usuários e checagem de autorização em toda leitura e job. Definir persistência e operação antes de escolher dependências.
3. **Revisão manual:** obter PR e diff com escopo limitado, integrar provedor permitido, processar tarefas com limites de uso e exibir relatórios. Testar com serviços falsos, inclusive falhas, cancelamento e ausência de permissão.
4. **Eventos e publicação:** webhooks autenticados, deduplicação e tratamento de falhas; comentários apenas mediante ação explícita. Testar revogação e eventos repetidos.
5. **Automação opcional:** avaliar Actions e execução em ambientes isolados, permissões, segredos, custos e riscos de código não confiável antes de habilitar qualquer execução. Nenhuma capacidade de sandbox é presumida.

## Limites e verificação

Não publicar como serviço multiusuário até provar isolamento de dados e autorização com usuários distintos, gestão de segredos, proteção de sessão e política de privacidade apropriada. Webhooks precisam validar assinatura; trabalhos precisam de isolamento por usuário/repositório e controle de custos. Integrações reais exigem configuração e credenciais autorizadas, mas testes de rotina devem usar dados sintéticos e provedores falsos.

Para o login GitHub, o callback usará endereço configurado fixo e `state` aleatório, de curta duração e uso único. A troca de código ocorrerá no backend; a identidade usará o ID estável do GitHub. Sessões devem ser revogáveis e usar cookies HttpOnly, Secure e SameSite, com proteção contra CSRF nas operações relevantes. Testar falhas de rede, state inválido ou reutilizado, sessão expirada e ausência de configuração. Persistência, cifragem, rotação e comportamento em múltiplas instâncias devem ser decididos antes de disponibilizar o serviço em produção; armazenamento em memória para testes não resolve essas exigências.

O canvas, tipos puros e partes do runtime podem ser avaliados para reuso; catálogo local, IPC Electron, sessões locais e API remota legada não devem ser considerados seguros para SaaS sem revisão. Preservar compatibilidade legada enquanto não houver decisão explícita de removê-la. O histórico de `docs/desktop/` permanece como registro do trabalho anterior.
