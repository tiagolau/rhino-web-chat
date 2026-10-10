# Ligar uma faculdade ao webchat

Cada faculdade tem a **sua própria Conexão Universal** no DataCrazy (tenant RJ Global), para separar as permissões dos atendentes. O backend precisa conhecer essa conexão por uma linha na tabela `faculdades`.

Tempo estimado: 15 minutos por faculdade.

## 1. Gerar os segredos

Gere dois valores, um para cada direção:

```bash
openssl rand -hex 32   # SEGREDO_HMAC  (webchat → DataCrazy)
openssl rand -hex 16   # API_KEY       (DataCrazy → webchat)
```

Escolha também o **slug** (só `a-z`, `0-9` e hífen, ex.: `facuvale`) e o **trecho do rodapé** do portal que identifica a faculdade (ex.: `FACULDADE IGUAÇU`). O rodapé aparece no fim da área do aluno, antes de "Eduno EAD | HotSystems".

## 2. Criar a conexão no DataCrazy

Painel `https://crm.datacrazy.io` → Configurações → Integrações → Conexões → Criar → aba **Universal**.

**Nome:** `Webchat <Faculdade>`

### Aba Envio

| Campo | Valor |
|---|---|
| URL Base | `https://webchat.engrenatec.com.br` |
| Método | `POST` |
| Caminho | `/dc/<slug>/send` |
| Content-Type | `application/json` |
| Tipo de Autenticação | API Key. Header: `X-Api-Key`. Chave: `apiKey` |
| Credencial | nome `apiKey`, valor = `API_KEY` (**colar à mão**) |
| Caminho do ID da Mensagem | `id` |
| Caminho do Sucesso | `ok` |

Template do Body (endpoint de texto):

```json
{
  "contactId": "${contact.contactId}",
  "name": "${contact.name}",
  "text": "${message.body}",
  "dcMessageId": "${message.id}"
}
```

**Endpoint Adicional:** nome `Anexos`, tipo **Todos**, `POST`, caminho `/dc/<slug>/send`, body:

```json
{
  "contactId": "${contact.contactId}",
  "name": "${contact.name}",
  "text": "${message.body}",
  "dcMessageId": "${message.id}",
  "attachmentUrl": "${attachment.url}",
  "mimeType": "${attachment.mimeType}",
  "filename": "${attachment.filename}"
}
```

### Aba Recebimento

| Campo | Valor |
|---|---|
| Habilitar recebimento | ligado |
| Caminho do ID do Contato | `contact.id` |
| Caminho do Corpo da Mensagem | `text` |
| Caminho do ID da Mensagem | `message_id` |
| Caminho do Nome do Contato | `contact.name` |
| Caminho do Timestamp | `timestamp` |
| Caminho da URL do Anexo | `media.url` |
| Caminho do Tipo do Anexo | `media.type` |
| Caminho do From Me | `fromMe` |
| Header de Assinatura | `X-Signature` |
| Algoritmo | `HMAC-SHA256` |
| Segredo de Validação | `SEGREDO_HMAC` (**colar à mão**) |
| Campo Obrigatório | `message_id` |
| Ignorar Mensagens Próprias | `fromMe` |

Clique em **Finalizar** e copie a **URL do Webhook** que aparece.

> ⚠️ O Segredo de Validação e o valor da Credencial **não salvam por preenchimento automático** (Claude no Chrome, extensões). Cole à mão. Ao reabrir a conexão, esses campos aparecem vazios, mas os valores continuam gravados.

## 3. Descobrir o id da instância

```bash
curl -s https://api.g1.datacrazy.io/api/v1/instances \
  -H "Authorization: Bearer $DATACRAZY_API_KEY_RJGLOBAL" -H "User-Agent: Mozilla/5.0" \
  | python3 -c "import json,sys; [print(i['id'], i['name']) for i in json.load(sys.stdin)['data'] if i.get('platform')=='UNIVERSAL']"
```

Confira também se o segredo foi gravado: no mesmo JSON, `config.receive.validation.secret` deve vir mascarado (ex.: `abc****xyz`), e não vazio.

## 4. Cadastrar no backend

```bash
curl -s -X POST https://webchat.engrenatec.com.br/admin/faculdades \
  -H "X-Admin-Key: <ADMIN_API_KEY de app/deploy/.env.production>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "<slug>",
    "nome": "<Nome da Faculdade>",
    "rodape": "<TRECHO DO RODAPÉ>",
    "instance_id": "<id da instância>",
    "webhook_url": "<URL do Webhook>",
    "webhook_secret": "<SEGREDO_HMAC>",
    "api_key": "<API_KEY>"
  }'
```

O mesmo comando atualiza uma faculdade já cadastrada. Para desativar, mande `"ativo": false`.

## 5. Testar

1. Abra `https://webchat.engrenatec.com.br/chat`, escolha a faculdade e mande uma mensagem com um CPF de teste válido (ex.: `529.982.247-25`).
2. No DataCrazy, a conversa deve aparecer na instância nova. Se não aparecer, olhe a aba **Logs** da conexão: o webhook responde 200 mesmo quando rejeita.
3. Responda pelo painel, com texto e com um arquivo, e veja a resposta chegar no chat.
4. `GET /admin/status` não deve ter erros novos.

Depois do teste, apague o lead de teste no DataCrazy, se tiver sido criado um.
