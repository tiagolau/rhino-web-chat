# Datacrazy CRM — Conexão Universal: referência de campos

**Data do levantamento:** 2026-10-10
**Origem:** Configurações → Integrações → Conexões → Criar → aba **Universal** ("Cadastrar conexão").
**Método:** inspeção do formulário no painel (via Claude no Chrome). Nada foi salvo; a conexão "Teste" não foi finalizada.

O formulário tem 3 partes: **Nome da conexão**, aba **Envio** e aba **Recebimento**.

Variáveis de template disponíveis (URL, headers, body, query): `${contact.contactId}`, `${contact.name}`, `${message.body}`, `${credentials.xxx}`.

## 1. Geral

| Campo | Tipo | Observação |
|---|---|---|
| Nome da conexão | Texto | Identificação da conexão (ex.: "Teste") |

## 2. Aba Envio

| Campo | Tipo de campo | Valores / padrão | Observação |
|---|---|---|---|
| URL Base | Texto | placeholder `https://api.example.com` | URL raiz da API |
| Método (Endpoint de Envio de Texto) | Select | POST (padrão), GET, PUT, PATCH, DELETE | |
| Caminho | Texto | placeholder `/send` | Path concatenado à URL Base |
| Template do Body | Editor de código (JSON, multilinha) | padrão: `{"to": "${contact.contactId}", "message": "${message.body}"}` | Aceita as variáveis acima |
| Content-Type | Select | application/json (padrão), application/x-www-form-urlencoded, text/plain, multipart/form-data | |
| Timeout (ms) | Número | padrão 30000 | |

### Autenticação

| Campo | Tipo de campo | Valores |
|---|---|---|
| Tipo de Autenticação | Select | Nenhuma (padrão), Bearer Token, API Key, Basic Auth, Headers Customizados |

Campos exibidos conforme o tipo escolhido:

| Tipo | Campos extras |
|---|---|
| Nenhuma | — |
| Bearer Token | Não confirmado (a opção não manteve a seleção na interface) |
| API Key | **Header da API Key** (texto, placeholder `X-API-Key`) e **Chave da API Key** (texto, placeholder `apiKey`) |
| Basic Auth | **Chave do Usuário** (texto, placeholder `username`) e **Chave da Senha** (texto, placeholder `password`) |
| Headers Customizados | Nenhum campo extra; usa a seção Headers |

Os campos de API Key e Basic Auth guardam o *nome* da credencial a referenciar, não o segredo em si.

### Credenciais (lista dinâmica, botão "Adicionar Credencial")

| Campo | Tipo | Observação |
|---|---|---|
| Nome da variável | Texto | Referenciada como `${credentials.nomeDaChave}` |
| Valor | Texto mascarado (com botão mostrar/ocultar) | Tokens, chaves de API e outros valores sensíveis |

Cada linha tem botão de excluir.

### Headers (lista dinâmica, botão "Adicionar Header")

| Campo | Tipo | Observação |
|---|---|---|
| Chave | Texto | Padrão pré-preenchido: `Content-Type` |
| Valor | Texto | Padrão pré-preenchido: `application/json` |

### Parâmetros de Query (lista dinâmica, botão "Adicionar Parâmetro")

| Campo | Tipo |
|---|---|
| Chave | Texto |
| Valor | Texto |

### Mapeamento de Resposta

| Campo | Tipo | Padrão (placeholder) |
|---|---|---|
| Caminho do ID da Mensagem | Texto (JSON path) | `id` |
| Caminho do Sucesso | Texto (JSON path) | `ok` |

### Endpoints Adicionais (botão "Adicionar Endpoint")

Para envio de mídia, documentos ou outros tipos de anexo. **Campos deste subformulário ainda não inspecionados** (a ação de adicionar foi bloqueada); abrir manualmente e complementar.

## 3. Aba Recebimento (webhook de entrada)

| Campo | Tipo de campo | Placeholder / padrão |
|---|---|---|
| Habilitar recebimento de mensagens | Switch (liga/desliga) | Ligado por padrão |

### Mapeamento de Campos (caminhos no payload recebido)

| Campo | Tipo | Placeholder |
|---|---|---|
| Caminho do ID do Contato | Texto | `from` |
| Caminho do Corpo da Mensagem | Texto | `text` |
| Caminho do ID da Mensagem | Texto | `message_id` |
| Caminho do Nome do Contato | Texto | `from_name` |
| Caminho do Timestamp | Texto | `timestamp` |
| Caminho do ID Externo da Mensagem | Texto | `external_id` |
| Caminho da URL do Anexo | Texto | `media.url` |
| Caminho do Tipo do Anexo | Texto | `media.type` |
| Caminho do From Me | Texto | `fromMe` |

### Validação do Webhook

| Campo | Tipo de campo | Valores |
|---|---|---|
| Header de Assinatura | Texto | placeholder `X-Signature` |
| Algoritmo | Select | SHA-256, SHA-1, HMAC-SHA256, Static Token |
| Segredo de Validação | Texto mascarado (senha) | "Insira o segredo para validação do webhook" |

### Filtros

| Campo | Tipo | Placeholder | Descrição |
|---|---|---|---|
| Campo Obrigatório | Texto | `message.type` | Caminho do campo que deve existir no payload para processar a mensagem |
| Ignorar Mensagens Próprias | Texto | `fromMe` | Caminho do campo booleano que indica se a mensagem foi enviada pelo próprio sistema |

## Comportamento validado na prova de conceito (2026-10-10)

Detalhes e contexto: ADR `docs/decisions/001-webchat-eduno-via-conexao-universal-datacrazy.md`.

- **Assinatura:** com `HMAC-SHA256`, o DataCrazy aceita a assinatura em hex do corpo bruto no header configurado (`X-Signature`).
- **Falhas silenciosas:** o webhook responde sempre `200 {"success":true}`. Os erros (ex.: `INVALID_SIGNATURE: Signature validation failed`) só aparecem na aba **Logs**.
- **Segredo vazio:** com algoritmo selecionado e segredo vazio, toda mensagem é rejeitada, inclusive as que chegam sem assinatura.
- **Campos sensíveis:** o Segredo de Validação e o Valor das Credenciais precisam ser digitados ou colados à mão. O preenchimento automatizado não salvou. Para conferir, `GET /api/v1/instances` mostra `config.receive.validation.secret` mascarado (`99d****138`) quando o valor está gravado.
- **Cloudflare:** o webhook devolve 403 para o User-Agent padrão do Python. Use User-Agent de navegador.
- **Sem lead automático:** a mensagem recebida cria **contato** (`platform: UNIVERSAL`) e **conversa**, mas **não cria lead**. O lead é criado pela REST com `contacts: [{"platform": "UNIVERSAL", "contactId": "...", "instanceId": "<id da conexão>"}]` e fica vinculado à conversa.
- **Telefone no lead:** preencher `phone`/`email` no `POST /api/v1/leads` gera também contatos `WHATSAPP`/`EMAIL` no lead.
- **Histórico:** `GET /api/v1/conversations/{id}/messages` devolve as mensagens (`received`, `status` = `RECEIVED`/`SENT`, `body`, `attachments`).
- **Envio:** `${message.id}` existe e é substituído pelo ID interno da mensagem no DataCrazy. A autenticação API Key envia o header configurado com o valor da credencial. A mensagem fica `SENT` quando a resposta tem `ok: true` e `id`.
- **Anexo do atendente sem Endpoint Adicional:** o DataCrazy usa o endpoint de texto como fallback, mas **sem as variáveis de anexo**. Chegam só `${message.body}` (a legenda, ou vazio) e `${message.id}`, e o arquivo se perde. O backend do webchat contorna isso para mensagens vazias, buscando o anexo pela REST, mas o caminho completo (arquivo com legenda) é configurar o Endpoint Adicional.
- **A conexão não é editável pela REST:** `PATCH` e `PUT` em `/api/v1/instances/{id}` dão 404 (o `OPTIONS` anuncia os métodos, mas a rota não existe). Toda mudança de configuração é pelo painel.
- **Achar a conversa de um contato:** `GET /api/v1/conversations?search=<contactId>` devolve a conversa exata. Os parâmetros `filter[contactId]` e `filter[contact.contactId]` são ignorados e devolvem a lista toda.
- **Enviar como atendente pela REST:** `POST /api/v1/conversations/{id}/messages` com `{"body": "...", "attachments": [{"url", "fileName", "mimeType", "type"}]}` dispara o envio pela Conexão Universal. Útil para testes.
- **Instância:** a conexão aparece em `GET /api/v1/instances` com `platform`/`provider` = `UNIVERSAL`/`UNIVERSAL_CONNECTION` e o campo `webhook` com a URL de recebimento.

## Atendente, finalização e anotações (validado em 2026-10-10)

Contexto: [ADR 004](decisions/004-atendimentos-encerramento-atendente-setores.md).

- **Não há variável de atendente nem de botões.** A [documentação oficial](https://docs.datacrazy.io/universal-connection/sending-messages) lista só `${message.body}`, `${message.id}`, `${contact.contactId}`, `${contact.name}`, `${attachment.*}` e `${credentials.*}`. A assinatura do atendente **não vem no corpo**: o espelho recebeu "testadp", não "*Tiago:* testadp".
- **O atendente está na REST.** `GET /api/v1/conversations/{id}/messages` devolve, além de `messages`, um array **`histories`**: `conversation-opened` e `attendant-added` com `params.attendantName`, e `conversation-finished`. Cada mensagem do atendente traz `attendant.name` e `signature`; as da automação não trazem nenhum dos dois.
- **Conversa:** `GET /api/v1/conversations?search=<contactId>` traz `finished`, `attendants` (com nome) e `currentThread` (o ticket do atendimento, com `code`). Depois de finalizada, `currentThread` some.
- **Finalizar pela REST:** `POST /api/v1/conversations/{id}/finish` deixa `finished: true` e grava `conversation-finished`. **Não envia nada ao aluno** pela conexão.
- **Anotação interna:** `POST /api/v1/conversations/{id}/messages` com `{"body": "...", "isInternal": true}` fica só no painel. **Não passa** pelo endpoint de envio da conexão.
- **Sem API de automações:** a OpenAPI não tem rotas de automação. Elas só entram por importação no painel.
- **`/finish` é idempotente** (201 numa conversa já finalizada) e **limpa o departamento** (grava `department-changed` junto com `conversation-finished`).

## Automações na Conexão Universal (validado em 2026-10-10)

- **Botões não são enviados.** Uma mensagem de automação com botões chega ao endpoint de envio só com o texto. O DataCrazy guarda os botões na mensagem (`buttons: [{name}]` na REST), mas não os passa pela conexão.
- **Correção na ADR 007:** a sessão nativa espera e retoma pelo rótulo exato. O ensaio anterior sofreu interferência de outro menu ativo. Manter apenas um fluxo de entrada. `/finish` e desativar/ativar automações não cancelam a espera; usar o protocolo de encerramento da ADR 007.
- **O gatilho `message-received` com `only-if-finished-service` dispara a cada mensagem do aluno**, inclusive **depois que um atendente assume** a conversa. Quem decide se o robô fala é a própria automação (no webchat, pelo campo `com_atendente` que o backend manda).
- **Payload do gatilho:** com `receiveJson: true`, o datasource tem **o nosso JSON cru** do webhook. Antes da ADR 008, `text` era string e `text.body` vinha vazio. Com `faculdades.texto_estruturado=true`, o webhook envia `text: {body: "..."}` e o campo passa a ser `[Message-1]text.body`; `novo_atendimento` e os demais campos continuam na raiz. O mapeamento de recebimento da conexão precisa usar `text.body`.
- `field-is-equal-condition` funciona como roteador (um bloco de condição com várias condições, cada uma com o seu `nextBlockId`, e `falseNextBlockId` para nenhuma). O caminho do parâmetro deve corresponder ao contrato habilitado na faculdade.
- **`thread-finished-trigger`** com a instância do webchat dispara quando o atendente finaliza, quando uma automação executa `finish-conversation-action` e quando o webchat chama o `/finish` (o eco chega em ~0,2 s). No bloco HTTP dele, `${conversationId}` e `${leadId}` chegam preenchidos.
- `change-conversation-department-action`, `add-tag-action`, `lead-has-tag-condition`, `lead-exists-condition`, `{Primeiro nome do lead|leadFirstName}` e `send-file-message` (vai pelo Endpoint Adicional "Anexos") funcionam normalmente.

## Upload para o armazenamento do CRM (validado em 2026-10-10)

O upload do painel foi identificado no código JavaScript servido pelo CRM e testado com a mesma chave REST (`DATACRAZY_API_TOKEN`) usada pelo backend, sem token de sessão do navegador. Isso complementa a ADR 003: a Conexão Universal continua guardando apenas URLs, mas existe uma rota interna separada capaz de hospedar o conteúdo no DataCrazy.

1. `POST https://crm.g1.datacrazy.io/api/crm/files/upload/file/lead-attachments?sourceId=<leadId>` com `Authorization: Bearer <chave da API>`, User-Agent de navegador e multipart/form-data, campo `file`.
2. Resposta HTTP 201: `{ "url": "https://g1cdn1.datacrazy.io/<tenant>/lead-attachments/<id>" }`.
3. `POST https://api.g1.datacrazy.io/api/v1/leads/<leadId>/attachments` com `attachmentUrl` retornada, `fileName`, `fileSize` **numérico** e `description` registra o anexo no lead. O exemplo da documentação pública usa string para `fileSize`, mas o teste retornou erro de validação; inteiro funcionou.

### Evidência

- O anexo inserido por Tiago no lead Tiago Lau Chaves foi encontrado no CDN do CRM; GET HTTP 200, image/jpeg, 640.067 bytes, tamanho igual ao registro.
- Upload de TXT sintético de 68 bytes no lead fictício Aluno Teste Webchat (`eb6b57c3-fb5f-4af1-bfb4-d92d44e6d28d`) retornou 201 com a chave de API.
- Download da URL do CDN sem autenticação retornou 200 e SHA-256 idêntico ao conteúdo enviado.
- Registro do anexo retornou 201; GET da lista confirmou ID e URL persistidos. Anexo de prova: `2d83d93d-eb1a-4cc0-b70b-42ea5469deb3`, nome `validacao-upload-webchat.txt`, sem dados pessoais. Mantido como evidência.
- O teste anterior com URL externa no endpoint público de anexos devolveu a mesma URL; esse endpoint sozinho não demonstrou cópia do arquivo.

### Limites da conclusão

Upload automático para o CRM é tecnicamente viável com a chave atual do tenant. A rota é interna, identificada no painel, e não consta como upload binário na documentação pública consultada. Não foram homologados limites de tamanho, formatos adicionais, rate limit, quotas do plano ou retenção do CDN. A validação inicial não alterou a produção. Posteriormente, a [ADR 011](decisions/011-anexos-no-cdn-datacrazy.md) integrou e publicou a transferência: cópias confirmadas são removidas logo após o registro no lead. A retenção de 72 horas do banco não foi implementada.

Na implementação futura, confirmar upload e integridade antes de liberar a cópia local. Preservar as URLs `/f/` já enviadas ao CRM, migrando sua resolução antes de apagar anexos antigos. Manter credenciais somente no servidor e utilizar o limitador existente para as chamadas de registro de anexos. A validação de upload não resolve, por si só, a retenção do espelho de mensagens e do estado operacional.

## Lacunas da extração

- Campos extras de **Bearer Token** não confirmados.
- Subformulário de **Endpoints Adicionais** não aberto.
- Valores listados como "placeholder" são sugestões visuais do formulário, não valores obrigatórios.
