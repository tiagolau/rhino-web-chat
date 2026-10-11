# 010 — Transporte do fluxo original sem ACK e recuperação da fila

**Data:** 2026-10-10
**Status:** aceito

## Contexto

Tiago adicionou o gatilho do webchat e ativou o boas-vindas original. Às 22:26,
o atendimento 9 dessa conversa foi encerrado pelo aluno. O backend ainda esperava
`sessao_encerrada`, contrato exclusivo do v2 temporário. O original não envia
esse reconhecimento. Dez mensagens dos atendimentos seguintes ficaram na fila,
com `aguardando encerramento da sessão anterior`; não chegaram ao webhook.

A REST confirmou recebimento até 22:26:59, mensagens originais com botões sem
marcação e ausência dos envios posteriores. O histórico também mostrou respostas
do original e do v2 na mesma entrada anterior, às 22:24. No painel, consultado
somente para leitura, o original já tinha dois gatilhos. Tiago confirmou a
ativação manual. Não é erro de payload `text.body`, assinatura ou deploy.

## Decisão

- Separar a capacidade de navegação nativa do contrato particular de encerramento.
  Migration 010 acrescenta `faculdades.confirmar_encerramento`, true por padrão
  para preservar instalações do v2. A Iguaçu com o original usa false.
- Quando o contrato estiver desligado, o encerramento usa a REST `/finish` e
  grava `dc_encerramento_concluido_em`, sem enviar texto artificial de controle e
  sem exigir callback inexistente. Não preencher `dc_sessao_limpa_em`: finalizar
  a thread não prova o cancelamento de esperas do robô.
- Conservar a barreira até a conclusão real da chamada REST, a ordenação da fila,
  o vínculo do lead, os menus por mensagem e o contrato `text.body`.
- Recuperar mensagens retidas de atendimentos já encerrados como notas internas
  na conversa do CRM, com texto, número do atendimento, horário original e URL
  de anexo, se existir. Não iniciar o robô para atendimentos antigos. Mensagens
  do atendimento aberto seguem pelo webhook normalmente.
- Acrescentar marcador estável `[webchat:<id>]` à nota e conferir até as últimas
  1.000 mensagens antes de repetir o POST. Essa janela evita duplicação em retries
  usuais, inclusive quando o CRM gravou a nota e a resposta HTTP se perdeu;
  não constitui garantia ilimitada de exatamente uma escrita no serviço externo.
- Publicar a atualização de status quando a fila entrega. O widget mostra
  `aguardando envio…` durante a retenção e atualiza o mesmo balão ao concluir.
- Manter o original e suas subautomações sob controle exclusivo do Tiago.

## Alternativas Consideradas

- Alterar o original para implementar o ACK: reservado exclusivamente ao usuário.
- Simular `sessao_encerrada` no banco: registraria uma limpeza que não ocorreu.
- Desligar toda a navegação nativa: mistura transporte, menus e encerramento.
- Reenviar mensagens de atendimentos antigos ao gatilho: pode reiniciar menus
  e encaminhar respostas para uma espera diferente da original.
- Descartar a fila: perderia mensagens que o aluno já enviou.

## Consequências

O transporte do original não depende de um callback que ele não possui. As
mensagens antigas ficam visíveis para a equipe como registros internos; a
mensagem ativa continua sendo uma mensagem recebida do aluno.

Com `confirmar_encerramento=false`, o webchat não promete que uma espera nativa
foi cancelada. Reinício de menus, timeouts, proteção de humano e Manter Janela
ainda pertencem ao fluxo compartilhado e precisam de homologação/configuração
por Tiago. A capacidade do CRM de receber mensagens é separada dessa garantia.
Consultas de recuperação passam pelo limitador REST existente.

## Resultado

Publicado na Mapeamento em 2026-10-10, com duas réplicas saudáveis. Migration
010 aplicada antes da atualização das réplicas, sob o mesmo advisory lock do
migrador, junto com o flag false da Iguaçu, para evitar iniciar uma réplica
com o contrato antigo em cache. Backup em
`/root/backups/webchat/pre-incidente-ack-20261010-224513.sql.gz`; imagem anterior
preservada como `rhino-webchat:pre-incidente-ack-20261010-224513`.

As dez mensagens foram recuperadas: oito notas internas dos atendimentos
10–14 e duas mensagens recebidas do atendimento 15. A REST confirmou uma nota
por marcador e as duas mensagens por texto, direção e timestamp original;
não apenas o HTTP 200 do webhook. Nenhum job pendente, executando ou em erro
restou na conferência. Os jobs retidos tiveram seu agendamento antecipado
durante a recuperação, sem apagar mensagens ou simular limpeza de sessão.

O aluno fictício, atendimento 26, recebeu boas-vindas e botões do original,
selecionou Secretaria, recebeu anexo e resposta de fora do horário e encerrou.
A finalização REST foi concluída; `dc_sessao_limpa_em` continuou vazio.
Esse teste não homologa o encerramento de uma espera aberta nem o reinício dela.

Passaram 17 testes unitários, integração em Postgres descartável e nove casos
de UI tanto com o widget local quanto com o público. A integração verifica os
dois contratos de encerramento, ausência de ACK artificial, preservação de
texto/anexo, retry sem nota duplicada e novo envio. Evidências sem conteúdo
das mensagens em [010-recuperacao-fila.json](../evidencias/010-recuperacao-fila.json).
O original e suas subautomações não foram alterados pelo agente. A primeira
publicação do incidente incluiu a correção local da ADR 010 sobre o commit
`3e4d718`, antes do versionamento. Após o pedido de Tiago de commit e deploy,
essa correção passa a ser versionada e republicada pelo mesmo script, sem
mudança adicional de código, configuração do CRM ou migration.

## Reversão

Reativar `confirmar_encerramento` somente quando a automação ativa implementar
o reconhecimento da ADR 007. O flag tem cache de até 60 s por réplica. Notas
recuperadas permanecem no histórico; não removê-las nem reenviá-las ao gatilho.
Não remover a migration aplicada.
