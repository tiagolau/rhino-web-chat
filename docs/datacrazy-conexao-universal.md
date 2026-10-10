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

## Lacunas da extração

- Campos extras de **Bearer Token** não confirmados.
- Subformulário de **Endpoints Adicionais** não aberto.
- Valores listados como "placeholder" são sugestões visuais do formulário, não valores obrigatórios.
