# 002 — Arquitetura de produção e plano de escala

**Data:** 2026-10-10
**Status:** substituído por 003 (VPS, identidade, volume e anexos mudaram). O vínculo de lead por celular e o espelho de mensagens continuam valendo.

## Contexto

A PoC (ADR 001) validou o canal Webchat ↔ DataCrazy pela Conexão Universal. Para produção, o Tiago definiu:

1. **O backend roda numa das VPS próprias**, não em serverless.
2. **Lead:** procurar o aluno pelo celular. Se existir lead, vincular o webchat a ele; se não, criar um novo.
3. **Planejar para escala desde já.**

Medições e testes feitos em 2026-10-10:

- **VPS RJ Global** (`72.60.245.114`, EasyPanel/Swarm): 4 vCPU, 15 GB de RAM (11 GB livres), 153 GB de disco livres, load ~0,1. Já tem Postgres (`postgresql-rjglobal`) e Traefik. O plano do EasyPanel permite só 3 projetos.
- **Busca de lead por telefone** (`GET /api/v1/leads?search=`) casa pelos **últimos 8 dígitos**. Funciona com ou sem o 9º dígito, mas pode trazer outra pessoa de outro DDD.
- **`PATCH /api/v1/leads/{id}` com `contacts` é aditivo:** acrescenta o contato UNIVERSAL e mantém WhatsApp e e-mail.

## Decisão

### Onde roda

**VPS RJ Global.** É a infraestrutura do próprio cliente, tem folga de CPU e memória e já tem Postgres e Traefik. O deploy é feito como serviços Swarm dentro de um projeto existente do EasyPanel, contornando o limite de 3 projetos, como já foi feito com o `disparos_cortes`.

### O gargalo que define o desenho

A REST do DataCrazy tem **30 req/min por tenant**, compartilhados com as outras integrações do RJ Global. Com milhares de alunos, ler o histórico ou buscar o lead pela REST a cada mensagem esgota esse limite em segundos.

Por isso, **o DataCrazy continua sendo o sistema de atendimento, mas o backend guarda um espelho das mensagens**:

- O backend vê os dois sentidos da conversa (envia as mensagens do aluno e recebe as do atendente), então monta o histórico sem chamar a REST.
- Na prática, a REST só é chamada **uma vez por aluno**, no primeiro contato: buscar o lead e depois fazer `PATCH` ou `POST`. São cerca de 2 chamadas.
- Essas chamadas passam por uma **fila com orçamento compartilhado** (token bucket no Redis, ~20 req/min, deixando folga para as outras integrações). O aluno conversa normalmente enquanto o vínculo com o lead acontece em segundo plano, porque a Conexão Universal cria a conversa sem precisar do lead.

### Componentes

```
                  ┌──────────────────────── VPS RJ Global (Swarm) ───────────────────────┐
Portal Eduno      │                                                                      │      DataCrazy
┌────────────┐    │  Traefik ──► webchat-api (N réplicas, Node/Fastify + WebSocket)      │    ┌──────────────┐
│ widget.js  │◄─WS──►   │            │  /ws        conversa em tempo real              │    │ Conexão Univ.│
│ ou página  │    │      │            │  /dc/:fac/send  ◄── resposta do atendente ─────┼────│ (1 por fac.) │
└────────────┘    │      │            │  /auth/otp   verificação por código            │    └──────────────┘
                  │      │            ▼                                                │           ▲
                  │      │      Redis: pub/sub entre réplicas, fila REST (token        │           │ webhook
                  │      │             bucket), OTP com TTL, idempotência              │           │ HMAC
                  │      │      Postgres: alunos, vínculos lead/conversa, espelho      │           │
                  │      │             de mensagens, config por faculdade              │           │
                  │      └──► worker (mesma imagem): fila REST DataCrazy, envio ao ────┼───────────┘
                  │           webhook com retry, vínculo de lead                       │
                  │      Storage de anexos (MinIO ou R2): URL pública para o DataCrazy │
                  └──────────────────────────────────────────────────────────────────────┘
```

| Componente | Papel | Escala |
|---|---|---|
| `webchat-api` | WebSocket com o aluno; endpoint `/dc/:faculdade/send` para as respostas do atendente; emissão e validação de token | Stateless: aumentar réplicas. Um processo Node segura milhares de sockets |
| Redis | Pub/sub (a resposta chega a qualquer réplica e é entregue na que tem o socket do aluno), fila REST com orçamento, OTP, idempotência | Uma instância pequena (256–512 MB) aguenta muito antes de precisar de cluster |
| `worker` | Consome a fila REST (busca, `PATCH`/`POST` de lead), envia ao webhook do DataCrazy com retry e backoff | Escala em réplicas, mas o teto real é o orçamento REST |
| Postgres | Alunos, vínculos, espelho de mensagens, configuração por faculdade | Banco novo dentro do `postgresql-rjglobal`, com índices por `contact_id` e `created_at` |
| Storage de anexos | O aluno envia arquivo e o DataCrazy precisa de URL pública | MinIO na VPS ou bucket R2 |

### Fluxos

**Primeira mensagem do aluno**
1. O widget lê `window.eduno.aluno` e o rodapé, e pede o código de verificação (ver abaixo).
2. Com o token válido, abre o WebSocket. A mensagem é gravada no espelho e enfileirada para o webhook da faculdade (HMAC).
3. O worker vincula o lead (abaixo) e grava `lead_id` no aluno. Isso acontece uma única vez.

**Vínculo de lead** (decisão 2 do Tiago)
1. Normaliza o celular para `55 + DDD + 8 dígitos finais`.
2. `GET /api/v1/leads?search=<celular>` e **filtra localmente**: só aceita o lead cujo telefone normalizado tenha o mesmo DDD e os mesmos 8 dígitos finais.
3. **Achou um:** `PATCH` com `contacts: [{platform: "UNIVERSAL", contactId, instanceId}]` (aditivo).
4. **Achou vários:** usa o atualizado mais recentemente e registra a ambiguidade.
5. **Não achou:** `POST /api/v1/leads` com nome, e-mail, telefone, `sourceReferral` e o contato UNIVERSAL.

**Resposta do atendente**
1. O DataCrazy chama `/dc/:faculdade/send` (com `X-Api-Key`). O backend grava no espelho, publica no Redis e responde `{ok, id}` na hora, bem antes do timeout de 30 s.
2. A réplica que tem o socket do aluno entrega a mensagem. Se o aluno estiver offline, ele vê o histórico ao voltar.

**Verificação de identidade (OTP)**
- Código de 6 dígitos com TTL de 5 min e no máximo 5 tentativas, enviado ao celular do aluno.
- **Canal recomendado: a Cloud API da Meta direto, com template de categoria AUTHENTICATION** em cada WABA da faculdade. Mandar pela REST do DataCrazy consumiria o orçamento de 30 req/min, e mensagem iniciada pela empresa fora da janela de 24h exige template aprovado. A Iguaçu e a FAME já têm token System User (`FB_ACCESS_TOKEN_IGUACU`, `FB_ACCESS_TOKEN_FAME`).
- Depois de validado, o backend emite um token assinado de longa duração (ex.: 90 dias) atrelado a `contactId` + celular, guardado no navegador.

### Configuração por faculdade (tabela `faculdades`)

`slug`, texto do rodapé para casar, URL do webhook, segredo HMAC, API key de entrada, `instanceId` da conexão, WABA e phone_id para o OTP, ativo ou inativo. Adicionar uma faculdade é criar a conexão no DataCrazy e uma linha nessa tabela.

### Capacidade e caminho de crescimento

Premissas a confirmar com o Tiago: total de alunos ativos e pico de conversas simultâneas.

| Fase | Configuração | Ordem de grandeza |
|---|---|---|
| Início | 2 réplicas da api + 1 worker + Redis na VPS RJ Global | milhares de sockets simultâneos; ~1.200 alunos novos/hora vinculados (limitado pela REST) |
| Crescimento | Mais réplicas da api; Postgres com particionamento de mensagens por mês | dezenas de milhares de alunos |
| Grande | Segundo nó no Swarm (ou VPS dedicada) para a api; Redis e Postgres separados | — |

O teto que não depende de nós é o **orçamento REST do DataCrazy**. Se o volume de alunos novos passar disso, a saída é habilitar o MCP do tenant (o rate limit é outro e é mais rápido para escrita) ou pedir aumento de limite ao DataCrazy.

### LGPD

- O CPF nunca sai do navegador.
- O espelho de mensagens guarda só o necessário, com política de retenção (ex.: 12 meses).
- Logs sem conteúdo de mensagem.

## Alternativas Consideradas

- **Cloudflare Worker + Durable Object** (proposta da ADR 001): descartado porque o Tiago quer o backend nas VPS próprias.
- **Histórico só pela REST do DataCrazy** (sem espelho): não escala com 30 req/min.
- **Sempre criar lead novo:** substituído pela busca por celular, por decisão do Tiago. Evita leads duplicados do mesmo aluno.
- **Vincular pelo primeiro resultado da busca:** perigoso, porque a busca casa só pelos últimos 8 dígitos. Por isso há a filtragem por DDD.
- **OTP enviado pelo DataCrazy:** consome o orçamento REST e cai na regra de template da Meta do mesmo jeito.
- **Sticky sessions no Traefik em vez de pub/sub:** não resolve a entrega quando a resposta chega por HTTP numa réplica diferente da que tem o socket.

## Consequências

**Positivas**
- A REST do DataCrazy é usada quase só uma vez por aluno, então o volume de mensagens não pressiona o rate limit.
- Escala horizontal simples (réplicas stateless + Redis).
- O aluno é vinculado ao lead que a secretaria já conhece, com o histórico do WhatsApp e do webchat juntos.

**Negativas**
- Há uma cópia das mensagens fora do DataCrazy, o que exige retenção e cuidado de LGPD.
- O OTP pelo WhatsApp exige criar e aprovar um template AUTHENTICATION por WABA, e tem custo por mensagem na Meta.
- Mais peças para operar (Redis, worker, storage) do que na PoC.

## Pendências

1. Números reais: alunos ativos por faculdade e pico esperado.
2. Tokens Meta com escrita para as WABAs da Facuvale, Faculeste e Educaminas (para o template de OTP).
3. Escolher o storage de anexos (MinIO na VPS ou R2).
4. Domínio do backend e do widget (ex.: `webchat.<domínio do grupo>`).
5. Como colocar no portal (widget ou página própria). Não afeta o backend.
