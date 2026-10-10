# Rhino-web-chat

Webchat de suporte para a área do aluno do portal **Eduno** (HotSystems), ligado ao **DataCrazy CRM** do grupo **RJ Global** pela **Conexão Universal**. O DataCrazy é a caixa de atendimento e a base de leads; o webchat é só mais um canal, igual ao WhatsApp.

> **Começando uma conversa nova?** Leia este arquivo inteiro, depois a [ADR 003](docs/decisions/003-producao-mapeamento-identidade-cpf.md). O histórico das decisões está em `docs/decisions/` (001 → 003).

**Repositório:** https://github.com/tiagolau/rhino-web-chat (privado, branch `main`). Commits só quando o Tiago pedir; para funcionalidade nova, criar branch a partir da `main`. O deploy (`app/deploy/deploy.sh`) envia a pasta local, não o que está no GitHub: confira se está na branch certa antes de publicar.

## Estado atual (2026-10-10)

- **Em produção** em `https://webchat.engrenatec.com.br` (VPS Mapeamento, stack `webchat`, 2 réplicas + Postgres).
- **Validado de ponta a ponta** com um aluno real no portal (`ava07.eduno.com.br`): texto e arquivo nos dois sentidos, tempo real entre réplicas, vínculo ao lead existente pelo CPF.
- **Só a faculdade de teste está cadastrada:** `iguacu` → conexão "Webchat Iguaçu (teste)" (instância `6aca6a619ab27fb81a32e33e`).
- **O widget ainda não está no portal para todos os alunos.** No teste foi injetado à mão no navegador do Tiago. Página própria já disponível em `/chat`.

## Próximos passos (em ordem)

1. **Conexões definitivas por faculdade** (Iguaçu, Facuvale, Faculeste, Educaminas, FAME). Passo a passo em [docs/faculdade-nova.md](docs/faculdade-nova.md).
2. **Backup** dos volumes `webchat_files` e `webchat_pg` na Mapeamento (ainda não existe).
3. **Distribuição:** linha do widget no template do Eduno (pedir à HotSystems) e/ou divulgar `https://webchat.engrenatec.com.br/chat`.
4. **Limpar os testes** depois da Iguaçu definitiva: conexão "Webchat Iguaçu (teste)" e lead "Aluno Teste Webchat" (`eb6b57c3-fb5f-4af1-bfb4-d92d44e6d28d`).

Ideias levantadas, não priorizadas: painel administrativo web (hoje só a API `/admin`), retenção automática de mensagens e anexos (12 meses, ADR 002), horário de atendimento e mensagem fora do horário no widget.

## Restrições do Tiago (não reabrir)

- **Não depender da HotSystems** (fornecedor do Eduno, pouco flexível) para nada além de, opcionalmente, incluir a linha do widget.
- **Não usar template da Meta / OTP.** O aluno é identificado só pelos dados do Eduno, principalmente o **CPF** (sempre existe, é o login). O celular pode faltar.
- **Uma Conexão Universal por faculdade**, para separar permissões no DataCrazy.
- **Lead:** procurar o existente (CPF, depois celular); só criar se não achar.
- **Volume:** ~100 alunos/hora no máximo. Não superdimensionar (sem Redis, sem worker separado).
- Backend em VPS própria (Mapeamento). A VPS RJ Global será desativada.

## Contexto técnico

- **Tenant DataCrazy:** RJ Global, `8e176de2-5471-4de9-8da7-3bfdb02d6b9e`, chave `DATACRAZY_API_KEY_RJGLOBAL` (em `~/.claude/.env`). REST liberada (30 req/min por tenant, compartilhados); **MCP desabilitado**. Usar User-Agent de navegador (o Cloudflare barra o do Python). Painel em `https://crm.datacrazy.io`.
- **Portal Eduno:** página renderizada no servidor (Laravel + jQuery + Bootstrap 5), sem CSP. Dados do aluno em `window.eduno.aluno` (`id, nome, cpf, email, celular`); faculdade no texto de `#hot-footer`. A API Eduno não tem consulta de aluno. Ver [docs/eduno-estrutura.md](docs/eduno-estrutura.md).
- **Conexão Universal:** referência de campos e comportamento validado em [docs/datacrazy-conexao-universal.md](docs/datacrazy-conexao-universal.md).
- **Produção:** VPS Mapeamento `173.212.205.156` (Swarm + Portainer + Traefik, rede `Mapeamento`, certresolver `letsencryptresolver`). SSH com a chave `~/Devs/RhinoCRM/Portainer Tecminas/secrets/vps-tecminas.key`. DNS `webchat.engrenatec.com.br` na Hostinger (`HOSTINGER_API_TOKEN`).

## Como funciona (resumo)

```
Portal Eduno ── widget.js ──(HTTPS + WebSocket)──► webchat-api (2 réplicas) ──(webhook HMAC)──► DataCrazy
                                                     │  ▲                                          │
                                                     │  └────(POST /dc/:slug/send, X-Api-Key)──────┘  resposta do atendente
                                                     ▼
                                       Postgres: alunos, espelho de mensagens, fila, LISTEN/NOTIFY
```

1. O widget lê o aluno e o rodapé → `POST /api/sessao` → token do navegador (sessão + dispositivo).
2. Mensagem do aluno → WebSocket → grava no espelho → envia ao webhook da faculdade (HMAC-SHA256, header `X-Signature`); se falhar, vai pela fila.
3. Na primeira sessão, a fila roda `vincular_lead`: CPF → celular → criar (a Conexão Universal **não** cria lead).
4. O atendente responde → o DataCrazy chama `/dc/:slug/send` → grava → `NOTIFY` → a réplica que tem o socket do aluno entrega.

## Padrões do código

- `contactId` = `eduno:<slug>:<20 primeiros hex do HMAC do CPF>`. O mesmo aluno cai na mesma conversa vindo do portal ou de `/chat`.
- **CPF:** no banco só o hash (`cpf_hash`) e a cópia cifrada AES-GCM (`cpf_cifrado`, para gravar no `taxId` do lead). **Nunca em logs.** `CPF_PEPPER` e `CPF_ENC_KEY` não podem mudar depois de em uso.
- **Vínculo de lead** (`src/leads.js`): `filter[taxId]` (11 dígitos → formatado → 10 dígitos); depois `search=<celular>` com filtro local por DDD + 8 dígitos, sem vincular se o lead tiver outro CPF; `PATCH contacts` é **aditivo**.
- **REST do DataCrazy:** só pelo limitador de `src/datacrazy.js` (10 req/min por réplica). Histórico vem do espelho local, nunca da REST.
- **Anexos do aluno:** volume da stack com URL permanente e impossível de adivinhar (`/f/<token>/<nome>`), porque o DataCrazy guarda só a URL. Anexos do atendente chegam pelo Endpoint Adicional "Anexos"; se a mensagem vier vazia, o job `buscar_anexo` busca o arquivo pela REST (fallback).
- **Migrations:** novo arquivo `src/migrations/NNN_nome.sql`, aplicado na subida com advisory lock. Nunca editar uma migration já aplicada.
- **Jobs:** `registrar("tipo", fn)` em `server.js` + `enfileirar("tipo", payload, { chave })` (a chave deduplica).
- Código e comentários em português, no estilo dos arquivos existentes; front-end do widget em JS puro (ES5) dentro de Shadow DOM.

## Armadilhas já encontradas

- **O webhook do DataCrazy responde 200 mesmo quando rejeita** (ex.: `INVALID_SIGNATURE`). O erro real só aparece na aba **Logs** da conexão (TTL de 1 h).
- **Campos sensíveis do painel** (Segredo de Validação, valor das Credenciais) não salvam por preenchimento automático: colar à mão. Para conferir, `GET /api/v1/instances` devolve o segredo mascarado (`99d****138`).
- **A conexão não é editável pela REST** (`PATCH`/`PUT` em `/api/v1/instances/{id}` dão 404). Só pelo painel.
- **O VIP do Swarm derruba conexões ociosas (~15 min) em silêncio.** Matou o `LISTEN` em produção. Por isso o Postgres usa `endpoint_mode: dnsrr`, o `pg` usa keepalive e o `LISTEN` tem batimento de 30 s.
- **`~/.npm` tem arquivos de root:** usar `npm install --cache /tmp/npm-cache-rhino`.
- **O Chrome não aceita JavaScript por AppleScript**, nem ativar a opção por clique automatizado. Para injetar o widget num navegador, use o console, o Claude no Chrome ou o userscript em `ferramentas/`.

## Estrutura do repositório

- `app/`: backend em produção (Node 22, Fastify, `@fastify/websocket`, `pg`).
  - `src/server.js`: rotas (`/api/sessao`, `/api/historico`, `/api/arquivos`, `/ws`, `/f/:token/:nome`, `/dc/:slug/send`, `/admin/*`).
  - `src/leads.js` (vínculo), `src/fila.js` (fila no Postgres), `src/tempo-real.js` (`LISTEN/NOTIFY`), `src/mensagens.js`, `src/datacrazy.js`, `src/identidade.js` (CPF, telefone, token), `src/faculdades.js`.
  - `public/widget.js` (modo portal ou `data-modo="pagina"`), `public/chat.html`.
  - `src/migrations/`, `test/` (unitários), `scripts/e2e.mjs` e `scripts/ouvir-atendente.mjs`.
  - `deploy/stack.yml`, `deploy/deploy.sh`; segredos em `deploy/.env.production` (600, **não versionado**).
- `docs/`: levantamentos, ADRs e passo a passo.
- `ferramentas/webchat-eduno.user.js`: userscript para testar o widget no portal.
- `poc/`: prova de conceito da Conexão Universal (só referência histórica).

## Comandos

```bash
# testes unitários
cd app && npm test

# dev local (Postgres local `rhino_webchat`; app/.env não versionado, ver app/.env.example)
cd app && npm install --cache /tmp/npm-cache-rhino && node --env-file=.env src/server.js

# deploy na Mapeamento (rsync + build no servidor + docker stack deploy)
app/deploy/deploy.sh

# teste de ponta a ponta contra a produção (aluno fictício, CPF de teste 529.982.247-25)
node app/scripts/e2e.mjs https://webchat.engrenatec.com.br

# saúde e status
curl -s https://webchat.engrenatec.com.br/health
curl -s https://webchat.engrenatec.com.br/admin/status -H "X-Admin-Key: <ADMIN_API_KEY de app/deploy/.env.production>"
```

## Documentação obrigatória

Mudança de arquitetura, integração ou padrão → nova ADR em `docs/decisions/NNN-titulo.md` (template nas diretrizes globais do Tiago) e atualização deste arquivo. Tarefas triviais não precisam de ADR.
