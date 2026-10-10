# 006 — Correlação das mensagens para evitar balões duplicados

**Data:** 2026-10-10
**Status:** aceito

## Contexto

Ao enviar uma mensagem, o widget mostra um balão otimista com `clienteId`. O servidor grava a mensagem e publica o eco via Postgres antes de terminar o envio ao DataCrazy e responder com o `ack`. O eco só continha o ID do banco; por isso o widget criava um segundo balão e só o removia quando recebia o `ack`.

## Decisão

- Gravar o `clienteId` em `mensagens.cliente_id`, coluna opcional `varchar(128)` criada pela migration `005_cliente_id_mensagens.sql`.
- Aceitar identificadores com letras, números, hífen e sublinhado, de 1 a 128 caracteres. Clientes anteriores podem omitir o identificador; valores inválidos não são armazenados.
- Incluir o identificador na serialização comum ao eco, histórico e confirmação. O widget já reconcilia mensagens por ID persistido ou `clienteId`; o primeiro eco passa a atualizar o balão existente.
- Ao recarregar o histórico durante um envio, remover da lista de pendentes os balões já representados no espelho, mantendo a ordem do histórico e os envios ainda não gravados.
- Preservar publicação entre abas/réplicas e o envio otimista imediato. O campo serve para correlação visual, não como autorização ou garantia de idempotência no servidor.
- Adicionar Playwright apenas como dependência de desenvolvimento e teste de regressão `npm run test:ui`. A imagem de produção continua instalando apenas dependências de execução.

## Alternativas Consideradas

- Ocultar o eco de toda mensagem do aluno: impediria sincronização entre abas e navegadores.
- Correlacionar pelo texto e horário: fundiria envios legítimos com o mesmo conteúdo e seria ambíguo para anexos.
- Esperar o DataCrazy antes de mostrar o balão: pioraria o tempo de resposta percebido.
- Enviar a correlação apenas no NOTIFY: não resolveria a recarga do histórico antes do `ack`.

## Consequências

- O eco e o `ack` atualizam um só balão, independentemente da ordem de chegada.
- Mensagens existentes permanecem sem `cliente_id`; nenhuma alteração destrutiva do histórico.
- Uma pequena coluna adicional é armazenada por mensagem do aluno; não precisa de índice porque não é consultada no banco.
- A confirmação de envio ao CRM mantém seu comportamento atual.

## Resultado

A regressão foi reproduzida com `SIMULAR_ECO_SEM_ID=1 npm run test:ui`: dois balões antes da confirmação. Com o novo contrato, passaram os cinco cenários de navegador: eco antes do ack, ack antes do eco, primeiro envio com recarga de histórico, anexo e dois textos iguais. Dez testes unitários passaram, incluindo a preservação do identificador na serialização e compatibilidade com mensagens anteriores.

### Publicação

Backup do banco validado em `/root/backups/webchat/pre-cliente-id-20261010-171857.sql.gz`. Imagem anterior preservada como `rhino-webchat:pre-correlacao-20261010`. Publicado na VPS Mapeamento, com atualização concluída e `webchat_app` em 2/2 réplicas. A migration e a coluna `varchar(128)` foram confirmadas no banco. Os hashes do widget e dos três módulos de backend conferem com os arquivos locais nas duas réplicas. `/health`, `/chat` e `/widget.js` responderam HTTP 200; formulário real carregado em desktop e celular.

Rollback de aplicação: `docker service update --image rhino-webchat:pre-correlacao-20261010 --force webchat_app`. Manter a coluna opcional no banco; a imagem anterior a ignora. Conferir réplicas e `/health` após o rollback.

Os cinco cenários de regressão também passaram com `WEBCHAT_WIDGET_URL=https://webchat.engrenatec.com.br/widget.js npm run test:ui` (widget público com transportes simulados). Essa verificação não envia mensagens ao DataCrazy. Para instalar o navegador de testes: `cd app && npx playwright install chromium`.
