# 003 — Produção na VPS Mapeamento, identidade por CPF e anexos

**Data:** 2026-10-10
**Status:** aceito. Substitui a ADR 002.

## Contexto

Depois da ADR 002, o Tiago mudou premissas:

1. **A VPS RJ Global será desativada.** O backend vai para a **VPS Mapeamento** (`173.212.205.156`).
2. **O CPF sempre existe** (é o login do Eduno); o celular pode faltar no painel.
3. **Sem template da Meta.** A identificação usa só os dados que já estão no Eduno, principalmente o CPF.
4. **Volume:** no máximo **~100 alunos por hora** entram em contato.
5. **Domínio:** `webchat.engrenatec.com.br`.
6. **Anexos:** o ideal é que fiquem no próprio DataCrazy.

Medições e testes feitos em 2026-10-10:

- **VPS Mapeamento:** 12 vCPU, 47 GB de RAM (40 GB livres), 206 GB de disco livres, load ~5 (apurações). Docker Swarm + Portainer + Traefik, rede overlay `Mapeamento`.
- **DNS:** `engrenatec.com.br` está na Hostinger (`dns-parking.com`), sem registro curinga. Registro A `webchat` → `173.212.205.156` criado em 2026-10-10 pela API da Hostinger (`overwrite: false`, TTL 300).
- **CPF no DataCrazy:** numa amostra de 200 leads do RJ Global, **123 têm `taxId`** (62%), contra 19 com e-mail. O formato dominante é só dígitos (118). Há exceções: 1 formatado e 1 com 10 dígitos, que perdeu o zero à esquerda. **`GET /api/v1/leads?filter[taxId]=<cpf>` faz busca exata**; o `search` livre só acha a versão formatada.
- **Anexos:** a Conexão Universal **não copia o arquivo**. Ela grava a URL que recebemos (`attachments[].url` ficou apontando para a origem). Não existe API pública de upload no DataCrazy: o CDN `g1cdn1.datacrazy.io/<tenant>/flow-attachments` só recebe uploads feitos pelo painel.

## Decisão

### Infraestrutura

- **Stack Swarm na VPS Mapeamento**, publicada pelo Traefik existente em `https://webchat.engrenatec.com.br`.
- **DNS:** registro A `webchat` → `173.212.205.156` na Hostinger (feito).

### Volume e simplificação

Com ~100 alunos/hora, o pior caso é ~3 chamadas REST por aluno novo, ou seja, ~5 req/min, contra o limite de 30. A ADR 002 trazia Redis, worker separado e token bucket para um volume que não existe. Fica assim:

| Peça | Papel |
|---|---|
| `webchat-api` (Node + Fastify + WebSocket), 2 réplicas | Widget/página, WebSocket do aluno, `/dc/:faculdade/send`, fila REST interna |
| Postgres (serviço próprio da stack) | Alunos, vínculos, espelho de mensagens, config por faculdade, **fila de jobs** (`SELECT … FOR UPDATE SKIP LOCKED`) e **pub/sub entre réplicas** (`LISTEN/NOTIFY`) |
| Volume de anexos | Arquivos enviados pelos alunos (ver abaixo) |

**Sem Redis.** O Postgres cobre fila, pub/sub e travas nesse volume. As 2 réplicas existem para disponibilidade, não para carga. Se um dia o volume crescer 10×, entra Redis no lugar do `LISTEN/NOTIFY`, sem mudar o resto.

### Identidade do aluno

- **Chave:** CPF (o login do Eduno), junto com a faculdade e o `id` do Eduno.
- **O CPF passa a sair do navegador:** vai para o nosso backend, sobre HTTPS, e é gravado no lead do DataCrazy como `taxId`. No banco do backend, guardamos um **hash do CPF** (HMAC com segredo) para a busca e o CPF cifrado só se for preciso reenviar. **O CPF não aparece em logs.**
- `contactId` continua `eduno:<slug-faculdade>:<idAluno>`.

### Vínculo com o lead (ordem de busca)

1. **CPF:** `filter[taxId]=<11 dígitos>`, depois a versão formatada, e, se o CPF começar com 0, a versão de 10 dígitos.
2. **Celular**, se o painel tiver: `search=<celular>` e filtro local por DDD + 8 dígitos finais.
   - Se o lead encontrado tiver **outro CPF** no `taxId`, **não vincula** (pode ser um celular da família) e segue para o passo 3.
   - Se o lead não tiver `taxId`, vincula e grava o CPF nele.
3. **Não achou:** `POST /api/v1/leads` com nome, e-mail, celular (se houver), `taxId` = CPF e o contato UNIVERSAL.
4. **Achou:** `PATCH` com o contato UNIVERSAL (aditivo).

### Segurança sem verificação externa (risco aceito)

Sem template da Meta e sem API do Eduno que confirme a sessão, **o backend não consegue provar que quem está no navegador é o dono do CPF**. Um aluno logado que edite `window.eduno.aluno` com o CPF e o `id` de outro conseguiria falar em nome dele. Mitigações adotadas:

- **Histórico ligado ao dispositivo:** o histórico anterior só aparece em navegadores que já abriram o chat daquele aluno (token emitido no primeiro uso e guardado no navegador). Num dispositivo novo, o aluno vê só a conversa a partir dali. Os atendentes continuam vendo tudo no DataCrazy.
- **Detecção de troca de identidade:** o mesmo navegador (token) ou o mesmo IP alternando entre CPFs diferentes é bloqueado e registrado.
- **Validação do CPF:** dígitos verificadores conferidos no backend.
- **Procedimento de atendimento:** pedidos sensíveis (cancelamento, financeiro, documentos) seguem com a conferência de identidade que a secretaria já faz no WhatsApp.

### Anexos

O DataCrazy **não hospeda** o arquivo que vem pela Conexão Universal: ele guarda a URL. Por isso:

- **Aluno → atendente:** o backend recebe o upload (limite de tamanho, lista de tipos permitidos), grava no volume da stack e manda ao DataCrazy uma **URL permanente e impossível de adivinhar** (`https://webchat.engrenatec.com.br/f/<token de 32 bytes>/<nome>`). O arquivo precisa ficar disponível enquanto a conversa existir no CRM. Retenção: igual à do espelho de mensagens.
- **Atendente → aluno:** o DataCrazy envia `${attachment.url}` (que já aponta para o CDN dele). O widget só exibe. Para isso, a conexão de cada faculdade precisa de um **Endpoint Adicional** do tipo "Todos" com `${attachment.url}`, `${attachment.mimeType}` e `${attachment.filename}` no body.

## Alternativas Consideradas

- **VPS RJ Global:** será desativada.
- **OTP pelo WhatsApp com template AUTHENTICATION:** recusado pelo Tiago. Identificação só com dados do Eduno.
- **Redis + worker separado** (ADR 002): superdimensionado para ~100 alunos/hora. O Postgres resolve.
- **Hospedar anexos no CDN do DataCrazy:** não há API pública de upload.
- **Anexos com URL temporária:** quebraria o anexo no CRM depois que expirasse, porque o DataCrazy não copia o arquivo.
- **Busca por celular primeiro:** o CPF é mais confiável (é único e está em 62% dos leads), e o celular pode faltar.

## Consequências

**Positivas**
- Menos peças: só app + Postgres + volume.
- O CPF casa com o lead da secretaria na maioria dos casos, e o aluno vê a conversa unificada com o atendimento de WhatsApp.
- Nenhuma dependência da HotSystems nem da Meta.

**Negativas**
- **Risco aceito de falsificação de identidade** por aluno logado com conhecimento técnico (mitigado, não eliminado).
- O CPF passa a trafegar até o backend e o DataCrazy. Os controles de LGPD ficam no backend (hash, sem logs, HTTPS).
- Os anexos dos alunos ficam na VPS Mapeamento, acessíveis por URL secreta. Exigem backup e retenção.
- **A VPS Mapeamento passa a hospedar dado pessoal de alunos**, junto com as stacks de campanha que já rodam lá.

## Resultado (2026-10-10)

- **DNS** criado e **stack `webchat` no ar** na Mapeamento: `webchat_app` (2/2) + `webchat_postgres` (1/1), TLS emitido pelo Traefik.
- **Código** em `app/` (Node 22 + Fastify + `ws` + `pg`), deploy reproduzível com `app/deploy/deploy.sh`.
- **`contactId` mudou para `eduno:<slug>:<20 primeiros hex do HMAC do CPF>`**, em vez do ID do Eduno. Assim o mesmo aluno cai na mesma conversa vindo do widget no portal ou da página `/chat`, que não tem o ID do Eduno.
- **Página própria (plano B) já disponível** em `https://webchat.engrenatec.com.br/chat`. O widget para o portal é `<script src="https://webchat.engrenatec.com.br/widget.js" defer></script>`.
- **Teste de ponta a ponta em produção** (`app/scripts/e2e.mjs`): sessão pelo rodapé, WebSocket através do Traefik, texto, anexo, download do anexo, histórico e retomada por token. Vínculo de lead pelo CPF confirmado (lead de teste `eb6b57c3…`).
- A faculdade de teste `iguacu` está cadastrada apontando para a conexão "Webchat Iguaçu (teste)".
- **Problema encontrado e corrigido: o VIP do Swarm derruba conexões ociosas.** Depois de ~15 min, as respostas do atendente deixaram de chegar quando o WebSocket do aluno estava em outra réplica. O `pg_stat_activity` mostrou que **nenhuma réplica estava mais em `LISTEN`**: o balanceador IPVS do Swarm (`10.0.4.4`) tinha derrubado as conexões ociosas sem avisar nenhum dos lados. Correção em três camadas:
  - `endpoint_mode: dnsrr` no Postgres (sai do VIP);
  - TCP keepalive no `pg`;
  - batimento de 30 s na conexão de `LISTEN`, que reabre se não houver resposta.
  
  Revalidado com 2 respostas enviadas pela REST do DataCrazy (`POST /api/v1/conversations/{id}/messages`) e entregues em tempo real.
- **Fallback de anexo do atendente** (migration `002_conversa_dc.sql`, job `buscar_anexo`). Sem o Endpoint Adicional "Anexos", o arquivo chega pelo endpoint de texto sem URL. Quando a mensagem do atendente vem vazia e sem anexo, o backend acha a conversa com `search=<contactId>` (o id fica em cache em `alunos.dc_conversation_id`), lê o anexo da mensagem pelo `dcMessageId` e atualiza o widget. Validado: o anexo aparece ~2 s depois da mensagem. **Limitação:** arquivo com legenda não dispara o fallback; para isso é preciso o Endpoint Adicional no painel (a REST não edita conexões).

- **Teste real no portal (2026-10-10):** widget injetado na aba logada do `ava07.eduno.com.br`. Ele leu `window.eduno.aluno` e o rodapé (Faculdade Iguaçu). A conversa chegou ao DataCrazy e o aluno foi **vinculado pelo CPF ao lead que já existia** (criado em 2025-12-11), que ganhou o contato UNIVERSAL e manteve WhatsApp e e-mail. Texto e imagem do aluno chegaram ao atendente, e as respostas do atendente chegaram ao aluno.
- **Endpoint Adicional "Anexos"** criado no painel (o JSON salvo usa `attachmentTypes: ["ALL"]`). Arquivo com legenda enviado pelo atendente chega inteiro e na hora, sem precisar do fallback.

## Próximos passos

1. Criar as conexões definitivas por faculdade (Envio + Recebimento + Endpoint "Anexos"), cadastrar cada uma em `POST /admin/faculdades` e excluir a conexão e os leads de teste.
2. Backup do volume `webchat_files` e do banco `webchat_pg`.
3. Colocar o widget no portal para todos os alunos (template do Eduno pela HotSystems) ou divulgar a página `/chat`. A injeção feita no teste vale só para o navegador de quem a fez.
