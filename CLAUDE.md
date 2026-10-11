# Rhino-web-chat

Webchat de suporte para a área do aluno do portal **Eduno** (HotSystems), ligado ao **DataCrazy CRM** do grupo **RJ Global** pela **Conexão Universal**. O DataCrazy é a caixa de atendimento e a base de leads; o webchat é só mais um canal, igual ao WhatsApp.

> **Começando uma conversa nova?** Leia este arquivo inteiro, depois as ADRs [003](docs/decisions/003-producao-mapeamento-identidade-cpf.md), [007](docs/decisions/007-boas-vindas-nativo-menus-por-atendimento.md), [008](docs/decisions/008-payload-text-body.md), [009](docs/decisions/009-menus-do-crm-sem-alterar-fluxo-original.md) e [010](docs/decisions/010-transporte-original-sem-ack-e-recuperacao-da-fila.md). Leia também as ADRs [011](docs/decisions/011-anexos-no-cdn-datacrazy.md) (upload no CDN) e [012](docs/decisions/012-retencao-historico-72-horas.md) (retenção de 72h). O histórico das decisões está em `docs/decisions/` (001 → 012).

**Repositório:** https://github.com/tiagolau/rhino-web-chat (privado, branch `main`). Commits só quando o Tiago pedir; para funcionalidade nova, criar branch a partir da `main`. O deploy (`app/deploy/deploy.sh`) envia a pasta local, não o que está no GitHub: confira se está na branch certa antes de publicar.

## Estado atual (2026-10-10)

- **Em produção** em `https://webchat.engrenatec.com.br` (VPS Mapeamento, stack `webchat`, 2 réplicas + Postgres).
- **Validado de ponta a ponta** com um aluno real no portal (`ava07.eduno.com.br`): texto e arquivo nos dois sentidos, tempo real entre réplicas, vínculo ao lead existente pelo CPF.
- **Só a faculdade de teste está cadastrada:** `iguacu` → conexão "Webchat Iguaçu (teste)" (instância `6aca6a619ab27fb81a32e33e`).
- **O widget ainda não está no portal para todos os alunos.** No teste foi injetado à mão no navegador do Tiago. Página própria já disponível em `/chat`.
- **ADR 007:** implementou o v2 temporário e o contrato de encerramento reconhecido pela sessão do robô. Após a ativação do original por Tiago, esse ACK deixou de ser requisito na Iguaçu (ADR 010). Menus por atendimento e vínculo antes do webhook continuam no backend, na branch `feat/compatibilidade-boas-vindas`.
- **Payload (ADR 008):** na Iguaçu o webhook e os templates de resposta usam `text: { body: "..." }`; condições leem `[Message-1]text.body`. Tiago ativou a automação original compartilhada. O callback aceita também `text` string para compatibilidade.
- **Boas-vindas original:** só Tiago pode alterar esse fluxo e suas subautomações, inclusive gatilhos e ativação/desativação. Tiago adicionou o gatilho do webchat e ativou o original após o commit `3e4d718`. O original não implementa o ACK do v2; usar `confirmar_encerramento=false` (ADR 010). A homologação completa do ciclo do robô continua pendente em [compatibilidade](docs/compatibilidade-boas-vindas-iguacu.md).
- **ADR 009 em produção:** `iguacu.menus_crm=true`; o backend recupera botões reais pela REST sem exigir `▸` no original. Prova controlada no aluno fictício (atendimento 25) confirmou persistência, atualização por WebSocket, seleção e encerramento. O original ainda não está homologado no webchat.

- **ADR 011 em produção:** anexos dos alunos transferidos ao CDN do DataCrazy, com verificação de tamanho/SHA-256 e registro no lead antes de remover a cópia local. Seis arquivos migrados/validados; volume de anexos com zero arquivos após a validação. O histórico de mensagens continua no Postgres local, com janela de 72 horas (ADR 012).

- **Retenção (ADR 012):** histórico/API/envio limitados a 72h; exclusão física na subida e a cada minuto, com aviso para pendências vencidas. Estado mínimo de atendimento preserva a continuidade do robô. Backups locais do webchat também expiram após 72h.

## Próximos passos (em ordem)

1. **Conexões definitivas por faculdade** (Iguaçu, Facuvale, Faculeste, Educaminas, FAME). Passo a passo em [docs/faculdade-nova.md](docs/faculdade-nova.md).
2. **Backup periódico** do `webchat_pg` e dos anexos pendentes no `webchat_files`. Foi feito dump pontual antes da ADR 007; ainda falta rotina de backup.
3. **Distribuição:** linha do widget no template do Eduno (pedir à HotSystems) e/ou divulgar `https://webchat.engrenatec.com.br/chat`.
4. **Limpar os testes** depois da Iguaçu definitiva: conexão "Webchat Iguaçu (teste)", as automações dela (boas-vindas, roteador legado, atendimento finalizado e POCs desativadas), lead "Aluno Teste Webchat" (`eb6b57c3-fb5f-4af1-bfb4-d92d44e6d28d`) e, se não for mais usada, a tag "Teste Webchat".

Ideias levantadas, não priorizadas: painel administrativo web (hoje só a API `/admin`), horário de atendimento e mensagem fora do horário no widget.

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

- **Correlação de mensagens (ADR 006):** `clienteId` do envio fica em `mensagens.cliente_id` e volta no eco, histórico e ack. O widget reconcilia pelo ID ou pela correlação, inclusive ao recarregar histórico antes do ack; nunca deduplicar por conteúdo. Playwright é dependência só de desenvolvimento (`npm run test:ui`).
- **Interface (ADR 005):** página `/chat` com apresentação RJ Global e montagem em `#chat-mount`; widget e página compartilham tokens visuais no Shadow DOM, ícones SVG próprios e fontes locais. Formulário móvel com rolagem natural; widget do portal em tela cheia no celular. Redesign publicado em 2026-10-10 a partir de `feat/redesign-webchat`, com duas réplicas e validação da página pública em desktop e celular.
- **Atendimentos (ADR 004):** no widget cada suporte é um atendimento (`atendimentos`, um aberto por aluno); no DataCrazy a conversa é uma só e cada atendimento é uma "thread". Encerramento pelo aluno → job `finalizar_no_datacrazy` (limpeza da sessão nativa + `/finish` + anotação interna). Encerramento no DataCrazy → automação "atendimento finalizado" → `POST /dc/:slug/evento`. Nome do atendente → job `identificar_atendente` (REST `histories`, no máximo 1 consulta/min por atendimento). Avisos na linha do tempo são mensagens `direcao = 'sistema'`.
- **Automações (ADR 007):** gerar com `--modo nativo` a partir do export WhatsApp e importar no painel. A Universal não envia metadados de botões, mas a sessão **retoma pelo rótulo exato**. Linhas `▸` exibem opções; o widget envia `{menuId, opcaoId}`, o servidor valida o menu atual e encaminha o rótulo canônico. Nunca indexar navegação globalmente por texto.
- **Sessão nativa:** `faculdades.fluxo_nativo` habilita a entrada. Apenas um boas-vindas deve estar ativo por conexão. Nenhuma automação cria lead ou coleta nome/CPF. Guardas `conversation-has-attendant-condition` verificam o humano no estado atual do CRM, antes dos ramos e timeouts.
- **Encerramento nativo:** `/finish` não limpa esperas. O job envia o controle `Atendimento encerrado` e espera `POST /dc/:slug/evento` com `sessao_encerrada` e o ID do atendimento antes de finalizar e liberar a próxima mensagem. A opção de controle existe nos botões nativos, mas não nas opções visíveis. As esperas terminais também reconhecem seu fim. Migrations 006/007 são aditivas.
- **Envio ao CRM:** aguardar vínculo do lead e conclusão do encerramento anterior; conservar a ordem das mensagens pendentes pela fila existente.
- **Contrato de texto:** `src/payload.js` adapta a fronteira com o CRM. `faculdades.texto_estruturado` (migration 008, padrão false) habilita o envio `text.body` por conexão; preparar o mapeamento e as condições antes de habilitar. Respostas `/dc/:slug/send` aceitam string ou `{body: string}` e recusam outros tipos com 400. Widget, WebSocket e mensagens persistidas usam string.
- **Botões do CRM (ADR 009):** `faculdades.menus_crm` (migration 009, padrão false) permite recuperar `messages[].buttons` pela REST para callbacks sem menu textual. Job `sincronizar_menu`, atraso de 2 s, consulta das últimas 20 mensagens pelo limitador existente, aproveitada para identificar o humano. Correlação pelo ID do CRM; `src/menus-crm.js` aplica opções sob trava do atendimento e não reativa menus respondidos/superados/encerrados. O widget atualiza o mesmo balão e conserva opções inativas no histórico. Essa preparação não troca a automação ativa.
- **Contrato de encerramento (ADR 010):** `faculdades.confirmar_encerramento` (migration 010, padrão true) habilita o ACK particular do v2. Para o original compartilhado, false: concluir pela REST, sem controle artificial ou ACK fictício. Essa configuração não cancela esperas do original nem garante o reinício delas. Mensagens na fila de atendimentos já encerrados viram notas internas com horário/anexo e marcador por mensagem (deduplicação nas últimas 1.000 mensagens); atendimento aberto continua pelo webhook. O status de entrega é publicado por NOTIFY e a fila aparece no widget.


- `contactId` = `eduno:<slug>:<20 primeiros hex do HMAC do CPF>`. O mesmo aluno cai na mesma conversa vindo do portal ou de `/chat`.
- **CPF:** no banco só o hash (`cpf_hash`) e a cópia cifrada AES-GCM (`cpf_cifrado`, para gravar no `taxId` do lead). **Nunca em logs.** `CPF_PEPPER` e `CPF_ENC_KEY` não podem mudar depois de em uso.
- **Vínculo de lead** (`src/leads.js`): `filter[taxId]` (11 dígitos → formatado → 10 dígitos); depois `search=<celular>` com filtro local por DDD + 8 dígitos, sem vincular se o lead tiver outro CPF; `PATCH contacts` é **aditivo**.
- **REST do DataCrazy:** só pelo limitador de `src/datacrazy.js` (10 req/min por réplica). Histórico vem do espelho local, nunca da REST.
- **Anexos do aluno (ADR 011):** `ANEXOS_NO_CRM=true` transfere pelo job `transferir_arquivo` ao CDN do CRM, verifica tamanho/SHA-256, registra no lead e só então remove a cópia local. O volume serve como temporário/fallback; `/f/<token>/<nome>` redireciona arquivos verificados e preserva links antigos. Varredura recupera anexos antigos e retries esgotados. `/admin/status` informa bytes locais e pendências acima de 72 horas; não apagar arquivos não confirmados por idade. Anexos do atendente chegam pelo Endpoint Adicional "Anexos"; `buscar_anexo` é o fallback REST.
- **Upload no CDN do CRM (2026-10-10):** a rota interna `POST https://crm.g1.datacrazy.io/api/crm/files/upload/file/lead-attachments?sourceId=<leadId>` aceita a chave REST atual, multipart campo `file`, e retorna URL do CDN. Registrar depois em `/api/v1/leads/<leadId>/attachments`, com `fileSize` inteiro. TXT sintético: upload 201, download 200 com SHA-256 igual e registro persistido no lead fictício. Contrato, evidência e limitações em [docs/datacrazy-conexao-universal.md](docs/datacrazy-conexao-universal.md). Integração na ADR 011; manter o suporte de redirecionamento mesmo ao desabilitar novas transferências. A rota interna não tem contrato público de quotas/retenção homologado.
- **Histórico local (ADR 012):** `src/retencao.js` limpa a janela de 72h; mensagens vencidas, inclusive pendentes, deixam de ser exibidas/enviadas e são apagadas. `primeira_mensagem_id` no atendimento conserva a condição de primeira entrada sem guardar o conteúdo antigo. Menus usam FK com `ON DELETE SET NULL`. `/admin/status.retencao` mostra atrasos da limpeza. Cron `webchat-retencao-backups` aplica 72h aos snapshots locais. Metadados de identidade/arquivos/atendimentos permanecem.
- **Migrations:** novo arquivo `src/migrations/NNN_nome.sql`, aplicado na subida com advisory lock. Nunca editar uma migration já aplicada.
- **Jobs:** `registrar("tipo", fn)` em `server.js` + `enfileirar("tipo", payload, { chave })` (a chave deduplica).
- Código e comentários em português, no estilo dos arquivos existentes; front-end do widget em JS puro (ES5) dentro de Shadow DOM.

## Armadilhas já encontradas

- **Universal:** não confiar no modo do gatilho para proteger o humano. O datasource (inclusive `text.body` e `com_atendente`) conserva o payload inicial após uma espera. Não decide ramos posteriores. Testes antigos sobre ausência de espera foram corrigidos pela ADR 007: havia interferência de outro menu.
- **O `/finish` do aluno volta como evento** ("atendimento finalizado") em ~0,2 s: o backend ignora pelo `dc_finalizado_em` (30 s).
- **O webhook do DataCrazy responde 200 mesmo quando rejeita** (ex.: `INVALID_SIGNATURE`). O erro real só aparece na aba **Logs** da conexão (TTL de 1 h).
- **Campos sensíveis do painel** (Segredo de Validação, valor das Credenciais) não salvam por preenchimento automático: colar à mão. Para conferir, `GET /api/v1/instances` devolve o segredo mascarado (`99d****138`).
- **A conexão não é editável pela REST** (`PATCH`/`PUT` em `/api/v1/instances/{id}` dão 404). Só pelo painel.
- **O VIP do Swarm derruba conexões ociosas (~15 min) em silêncio.** Matou o `LISTEN` em produção. Por isso o Postgres usa `endpoint_mode: dnsrr`, o `pg` usa keepalive e o `LISTEN` tem batimento de 30 s.
- **`~/.npm` tem arquivos de root:** usar `npm install --cache /tmp/npm-cache-rhino`.
- **O Chrome não aceita JavaScript por AppleScript**, nem ativar a opção por clique automatizado. Para injetar o widget num navegador, use o console, o Claude no Chrome ou o userscript em `ferramentas/`.

## Estrutura do repositório

- `app/`: backend em produção (Node 22, Fastify, `@fastify/websocket`, `pg`).
  - `src/server.js`: rotas (`/api/sessao`, `/api/historico`, `/api/atendimentos`, `/api/atendimentos/encerrar`, `/api/arquivos`, `/ws`, `/f/:token/:nome`, `/dc/:slug/send`, `/dc/:slug/evento`, `/admin/*`).
  - `src/leads.js` (vínculo), `src/atendimentos.js` (abrir/encerrar, atendente), `src/fila.js` (fila no Postgres), `src/tempo-real.js` (`LISTEN/NOTIFY`), `src/mensagens.js`, `src/datacrazy.js`, `src/identidade.js` (CPF, telefone, token), `src/faculdades.js`, `src/arquivos-crm.js` (transferência e verificação de anexos).
  - `public/widget.js` (modo portal ou `data-modo="pagina"`), `public/chat.html`.
  - `src/migrations/`, `test/` (unitários), `scripts/e2e.mjs`, `scripts/conversa.mjs` (conversa como aluno de teste, para testar o roteador) e `scripts/ouvir-atendente.mjs`.
  - `deploy/stack.yml`, `deploy/deploy.sh`; segredos em `deploy/.env.production` (600, **não versionado**).
- `datacrazy/`: gerador das automações do webchat (boas-vindas nativo ou roteador legado + atendimento finalizado). Saída em `datacrazy/gerado/` (fora do git: leva a `api_key`).
- `docs/`: levantamentos, ADRs e passo a passo.
- `ferramentas/webchat-eduno.user.js`: userscript para testar o widget no portal.
- `poc/`: prova de conceito da Conexão Universal (só referência histórica).

## Comandos

```bash
# testes unitários
cd app && npm test

# regressão de UI (API/WebSocket simulados, sem CRM)
cd app && npx playwright install chromium && npm run test:ui

# integração com Postgres real descartável e CRM simulado
cd app && node scripts/test-integracao-menus.mjs

# anexos com Postgres descartável e CRM/CDN simulados
cd app && node scripts/test-integracao-arquivos.mjs

# retenção de 72h, expiração e continuidade com Postgres descartável
cd app && node scripts/test-integracao-retencao.mjs

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
