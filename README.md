# Rhino Webchat

Chat de suporte para a área do aluno do portal **Eduno** (HotSystems), atendido pela equipe no **DataCrazy CRM** do grupo **RJ Global** (Facuvale, Iguaçu, Faculeste, Educaminas, FAME).

O aluno conversa por um widget dentro do portal ou pela página `/chat`. A conversa cai na mesma caixa de atendimento do DataCrazy que a secretaria já usa para o WhatsApp, vinculada ao lead do aluno, encontrado pelo CPF. Para o DataCrazy, o webchat é só mais um canal, ligado pela **Conexão Universal**.

> **Projeto doado ao grupo RJ Global** por Tiago Lau em outubro de 2026, sob a [licença MIT](LICENSE). Se você vai assumir o código, comece pela [passagem do projeto](docs/passagem-rj-global.md): estado atual, o que não está no git, como migrar a produção e pendências.

## Como funciona

```
Portal Eduno ── widget.js ──(HTTPS + WebSocket)──► webchat-api (2 réplicas) ──(webhook HMAC)──► DataCrazy
                                                     │  ▲                                          │
                                                     │  └────(POST /dc/:slug/send, X-Api-Key)──────┘  resposta do atendente
                                                     ▼
                                       Postgres: alunos, espelho de mensagens, fila, LISTEN/NOTIFY
```

1. O widget lê o aluno logado (`window.eduno.aluno`) e o rodapé do portal, que identifica a faculdade. Chama `POST /api/sessao` e recebe um token assinado (sessão + dispositivo).
2. A mensagem do aluno vai por WebSocket, é gravada no espelho local e enviada ao webhook da Conexão Universal da faculdade, assinada com HMAC-SHA256. Se falhar, segue pela fila.
3. Na primeira sessão, a fila procura o lead no DataCrazy pelo CPF, depois pelo celular, e acrescenta o canal do webchat. Só cria lead se não achar.
4. O atendente responde no DataCrazy, que chama `POST /dc/:slug/send`. O backend grava e avisa por `NOTIFY` a réplica que tem o socket do aluno.

Cada faculdade tem a **sua** Conexão Universal, para separar permissões no DataCrazy. Anexos dos alunos vão para o CDN do DataCrazy; o histórico local guarda só 72 horas.

## Stack

Node 22 · Fastify 5 · `@fastify/websocket` · PostgreSQL 16 (`pg`) · Docker Swarm + Traefik · widget em JavaScript puro (ES5) com Shadow DOM · gerador de automações em Python 3 (sem dependências).

Não há Redis nem worker separado: as réplicas se coordenam pelo Postgres (fila com `SKIP LOCKED` e `LISTEN/NOTIFY`). O volume esperado é de ~100 alunos/hora.

## Começando

Requisitos: Node 22+, PostgreSQL 16 local e Python 3, este último só para o gerador de automações.

```bash
cd app
cp .env.example .env     # preencha SESSION_SECRET, CPF_PEPPER, CPF_ENC_KEY e ADMIN_API_KEY
                         # (openssl rand -hex 32); DATACRAZY_API_TOKEN aceita qualquer valor sem CRM
createdb rhino_webchat
npm install
npm run dev              # node --env-file=.env --watch src/server.js
curl -s localhost:3000/health
```

As migrations rodam sozinhas na subida. Abra `http://localhost:3000/chat` para ver a página do aluno.

Para conversar de verdade, cadastre uma faculdade com `POST /admin/faculdades` ([faculdade-nova.md](docs/faculdade-nova.md)). Para o DataCrazy alcançar o servidor local, use um túnel HTTPS, como `cloudflared` ou `ngrok`, numa **conexão de teste**. Nunca use a conexão de produção de uma faculdade.

## Configuração

Todas as variáveis estão em [`app/.env.example`](app/.env.example). As obrigatórias derrubam o processo na subida, com mensagem clara.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Conexão do Postgres. Na stack é montada a partir de `POSTGRES_PASSWORD` |
| `SESSION_SECRET` | sim | Assina o token do navegador |
| `CPF_PEPPER` | sim | HMAC do CPF (hash de busca e `contactId`). **Não pode mudar** depois de em uso |
| `CPF_ENC_KEY` | sim | AES-256-GCM da cópia cifrada do CPF, 64 caracteres hex. **Não pode mudar** depois de em uso |
| `DATACRAZY_API_TOKEN` | sim | Chave REST do tenant RJ Global |
| `PUBLIC_URL` | | URL pública do backend (padrão `http://localhost:3000`) |
| `PORT` | | Porta HTTP (padrão `3000`) |
| `SESSION_DAYS` | | Validade do token do navegador (padrão `90`) |
| `ALLOWED_ORIGINS` | | Origens que podem carregar o widget, separadas por vírgula. A `PUBLIC_URL` é sempre aceita |
| `ANEXOS_NO_CRM` | | `true` transfere anexos dos alunos ao CDN do DataCrazy ([ADR 011](docs/decisions/011-anexos-no-cdn-datacrazy.md)) |
| `FILES_DIR`, `MAX_UPLOAD_MB` | | Pasta dos anexos (padrão `./data/files`) e tamanho máximo (padrão `15`) |
| `DATACRAZY_API_BASE`, `DATACRAZY_UPLOAD_BASE`, `DATACRAZY_CDN_BASE` | | Endereços do DataCrazy (padrões do cluster `g1`) |
| `DC_REST_PER_MINUTE` | | Orçamento da REST por réplica (padrão `10`; o tenant tem 30/min no total) |
| `DEVICE_CPF_LIMIT`, `IP_CPF_LIMIT_PER_HOUR` | | Anti-abuso: CPFs diferentes por dispositivo (padrão `3`) e por IP/hora (padrão `30`) |
| `ADMIN_API_KEY` | | Libera as rotas `/admin/*`. Vazia, elas ficam desligadas |
| `LOG_LEVEL` | | Nível do log do Fastify (padrão `info`) |

As variáveis só de produção (`POSTGRES_PASSWORD`, `WEBCHAT_DOMAIN`, `TRAEFIK_*`, `WEBCHAT_SSH_*`) estão em [docs/deploy.md](docs/deploy.md).

## Testes

```bash
cd app
npm test                                    # 17 testes unitários (node --test)
node scripts/test-integracao-menus.mjs      # Postgres descartável + CRM simulado
node scripts/test-integracao-arquivos.mjs   # anexos com CRM/CDN simulados
node scripts/test-integracao-retencao.mjs   # retenção de 72h e continuidade
npx playwright install chromium && npm run test:ui   # regressão de UI do widget

# gerador de automações, com um export real do fluxo do WhatsApp feito no painel
python3 -I ../datacrazy/test_gerador.py <export.json>
```

Os testes de integração criam e apagam um banco próprio. Por padrão usam `postgresql://localhost/postgres`; aponte `POSTGRES_TEST_ADMIN_URL` para outro Postgres com permissão de `CREATE DATABASE`.

Contra um servidor rodando, com o aluno fictício de CPF `529.982.247-25`:

```bash
node app/scripts/e2e.mjs [URL]                                   # ponta a ponta (padrão localhost:3000)
node app/scripts/conversa.mjs [URL] "Olá" "!escolher:Secretaria"  # testa menus e automações
node app/scripts/ouvir-atendente.mjs [URL] [segundos]            # ouve as respostas do atendente
```

## Deploy e operação

Em resumo: preencha `app/deploy/.env.production` e rode `app/deploy/deploy.sh`. Requisitos, primeiro deploy, rollback, backup, logs e o que olhar no `/admin/status` estão em [docs/deploy.md](docs/deploy.md).

## Rotas

| Rota | Quem chama | Autenticação |
|---|---|---|
| `GET /chat`, `GET /widget.js` | navegador | — |
| `POST /api/sessao` | widget | dados do aluno (CPF válido) |
| `GET /api/historico`, `GET /api/atendimentos`, `POST /api/atendimentos/encerrar`, `POST /api/arquivos` | widget | `Authorization: Bearer <token>` |
| `GET /ws?token=` | widget | token na URL |
| `GET /f/:token/:nome` | qualquer um com o link | token secreto na URL |
| `POST /dc/:slug/send` | DataCrazy (resposta do atendente) | `X-Api-Key` da faculdade |
| `POST /dc/:slug/evento` | automações do DataCrazy (encerramento) | `X-Api-Key` da faculdade |
| `GET /admin/status`, `GET\|POST /admin/faculdades` | equipe | `X-Admin-Key` |
| `GET /health` | orquestrador | — |

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `app/src/server.js` | Rotas, WebSocket e registro dos jobs |
| `app/src/leads.js` | Vínculo ao lead (CPF → celular → criar) |
| `app/src/atendimentos.js` | Abrir/encerrar atendimentos e identificar o atendente |
| `app/src/fila.js`, `tempo-real.js` | Fila de jobs e `LISTEN/NOTIFY` no Postgres |
| `app/src/datacrazy.js` | Cliente REST com limitador de taxa |
| `app/src/identidade.js` | CPF (hash/cifra), telefone e token do navegador |
| `app/src/payload.js`, `menus.js`, `menus-crm.js` | Contrato de texto com o CRM e menus/botões |
| `app/src/arquivos-crm.js`, `retencao.js` | Anexos no CDN e limpeza de 72h |
| `app/src/migrations/` | SQL aplicado na subida, em ordem |
| `app/public/` | `widget.js` (modo portal ou página) e `chat.html` |
| `app/test/`, `app/scripts/` | Testes unitários, integração, e2e e ferramentas de teste |
| `app/deploy/` | `stack.yml`, `deploy.sh` e limpeza de backups |
| `datacrazy/` | Gerador das automações do webchat a partir do fluxo do WhatsApp |
| `docs/` | Guias, referências, ADRs e evidências de homologação |
| `ferramentas/` | Userscript para testar o widget no portal sem depender da HotSystems |
| `poc/` | Prova de conceito inicial da Conexão Universal (só referência) |

## Documentação

- [Passagem do projeto](docs/passagem-rj-global.md): **comece por aqui** se for assumir o projeto.
- [Deploy e operação](docs/deploy.md).
- [Ligar uma faculdade](docs/faculdade-nova.md): Conexão Universal, cadastro no backend, automações e roteiro de teste.
- [Instalação do widget no Eduno](docs/instalacao-widget-eduno.md): texto para enviar à HotSystems.
- [Estrutura do portal Eduno](docs/eduno-estrutura.md) e [referência da Conexão Universal](docs/datacrazy-conexao-universal.md).
- [Compatibilidade com o boas-vindas da Iguaçu](docs/compatibilidade-boas-vindas-iguacu.md): homologação em andamento.
- [`CLAUDE.md`](CLAUDE.md): padrões e armadilhas do código, também lido por agentes de IA (`AGENTS.md` é um link para ele).

### Decisões de arquitetura (ADRs)

| ADR | Decisão |
|---|---|
| [001](docs/decisions/001-webchat-eduno-via-conexao-universal-datacrazy.md) | Webchat no Eduno via Conexão Universal do DataCrazy |
| [002](docs/decisions/002-arquitetura-producao-escala.md) | Arquitetura de produção e plano de escala |
| [003](docs/decisions/003-producao-mapeamento-identidade-cpf.md) | Produção em VPS própria, identidade por CPF e anexos |
| [004](docs/decisions/004-atendimentos-encerramento-atendente-setores.md) | Atendimentos, encerramento, nome do atendente e setores |
| [005](docs/decisions/005-redesign-central-do-aluno.md) | Redesign da central do aluno e do widget |
| [006](docs/decisions/006-correlacao-mensagens-sem-balao-duplicado.md) | Correlação de mensagens sem balão duplicado |
| [007](docs/decisions/007-boas-vindas-nativo-menus-por-atendimento.md) | Boas-vindas nativo e menus por atendimento |
| [008](docs/decisions/008-payload-text-body.md) | Payload `text.body` na Conexão Universal |
| [009](docs/decisions/009-menus-do-crm-sem-alterar-fluxo-original.md) | Botões do CRM sem alterar o fluxo original |
| [010](docs/decisions/010-transporte-original-sem-ack-e-recuperacao-da-fila.md) | Fluxo original sem ACK e recuperação da fila |
| [011](docs/decisions/011-anexos-no-cdn-datacrazy.md) | Anexos no CDN do DataCrazy |
| [012](docs/decisions/012-retencao-historico-72-horas.md) | Histórico local limitado a 72 horas |
| [013](docs/decisions/013-doacao-codigo-rj-global.md) | Doação do código ao grupo RJ Global |

Mudança de arquitetura, integração ou padrão ganha uma ADR nova em `docs/decisions/NNN-titulo.md`.

## Licença

[MIT](LICENSE) © 2026 Tiago Lau.
