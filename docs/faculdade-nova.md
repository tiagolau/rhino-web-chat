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
  "text": { "body": "${message.body}" },
  "dcMessageId": "${message.id}"
}
```

**Endpoint Adicional:** nome `Anexos`, tipo **Todos**, `POST`, caminho `/dc/<slug>/send`, body:

```json
{
  "contactId": "${contact.contactId}",
  "name": "${contact.name}",
  "text": { "body": "${message.body}" },
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
| Caminho do Corpo da Mensagem | `text.body` |
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
    "api_key": "<API_KEY>",
    "texto_estruturado": true
  }'
```

O mesmo comando atualiza uma faculdade já cadastrada. Para desativar, mande `"ativo": false`.
Em uma conexão existente, alinhe primeiro o mapeamento e as condições para
`text.body` e então habilite `texto_estruturado`. Consulte a [ADR 008](decisions/008-payload-text-body.md).

## 5. Automações do webchat (setores e encerramento)

Na Conexão Universal os metadados dos botões não chegam, mas a sessão nativa retoma pelo rótulo. Usar a adaptação da [ADR 007](decisions/007-boas-vindas-nativo-menus-por-atendimento.md), homologada na Iguaçu. A entrada de outra faculdade precisa de revisão: o gerador identifica pontos específicos da Iguaçu para excluir coleta de identidade. Exporte no painel o fluxo do WhatsApp da faculdade **com todas as automações** (boas-vindas, menus de setor e subfluxos) e gere:

```bash
WEBCHAT_API_KEY=<API_KEY> python3 -I datacrazy/gerar_automacoes_webchat.py \
  --export <export do fluxo.json> --slug <slug> \
  --instancia <id da instância> --faculdade "<Nome da Faculdade>" \
  --tag-teste 507ad07e-130c-4aa9-908e-64eba143a0d6 --modo nativo
```

O arquivo sai em `datacrazy/gerado/webchat-<slug>-nativo.json` (fora do git, porque leva a `API_KEY`), com duas automações importadas **desativadas**:

- **Webchat <faculdade>: boas-vindas:** saudação, menus e subfluxos nativos. Todos os menus têm um controle interno para encerrar a espera; o callback de reconhecimento leva a mesma chave. Mudou o WhatsApp, exporte e gere de novo. Desative e preserve o fluxo anterior para reversão.
- **Webchat <faculdade>: atendimento finalizado:** confira se o header `X-Api-Key` do bloco HTTP tem a `API_KEY` (se o painel não gravar, **colar à mão**).

Cadastre `"fluxo_nativo": true` e `"texto_estruturado": true` na configuração da faculdade, com a conexão mapeada para `text.body`. Ative um único boas-vindas e uma única automação de finalização. Para atualizar apenas a entrada, use `--somente-entrada`; não duplique o evento de encerramento. A tag "Teste Webchat" no lead de teste pula a checagem de horário.

## 6. Testar

Para testar o fluxo como aluno: `cd app && node scripts/conversa.mjs "Olá" "!escolher:Secretaria" "!escolher:Declarações"` (aluno de teste, só na Iguaçu; para outra faculdade, ajuste o rodapé no script).

1. Abra `https://webchat.engrenatec.com.br/chat`, escolha a faculdade e mande uma mensagem com um CPF de teste válido (ex.: `529.982.247-25`).
2. No DataCrazy, a conversa deve aparecer na instância nova. Se não aparecer, olhe a aba **Logs** da conexão: o webhook responde 200 mesmo quando rejeita.
3. Responda pelo painel, com texto e com um arquivo, e veja a resposta chegar no chat. O cabeçalho do widget deve mostrar "<seu nome> está te atendendo" (até 1 min depois).
4. Finalize o atendimento no painel: o widget mostra "Atendimento encerrado". Abra outro e encerre pelo botão do widget: a conversa fica finalizada no DataCrazy, com uma anotação interna.
5. Encerre com um menu aberto e novamente após uma resposta com espera por texto. A próxima primeira mensagem deve receber a saudação; a fila só libera o envio depois do reconhecimento da sessão anterior.
6. Assuma como humano: escolhas posteriores não devem disparar o robô.
7. `GET /admin/status` não deve ter erros novos.

Depois do teste, apague o lead de teste no DataCrazy, se tiver sido criado um.
