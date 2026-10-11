# 009 — Recuperar botões do CRM sem alterar o fluxo original

**Data:** 2026-10-10
**Status:** aceito

## Contexto

Tiago quer compartilhar o boas-vindas original entre WhatsApp e webchat e
reservou exclusivamente para si as alterações desse fluxo e suas subautomações.
O contrato `text.body` já foi publicado (ADR 008), mas a Conexão Universal não
transmite os botões pelo callback. Exigir linhas `▸` acrescentaria alterações
ao original; um catálogo extraído do export também ficaria desatualizado.

Uma consulta de leitura à conversa de teste confirmou que a REST conserva os
botões em `messages[].buttons`, com `name`, `description` e `url`.

## Decisão

- Migration 009 acrescenta `faculdades.menus_crm`, false por padrão. Quando
  habilitado, callbacks sem menu textual e com ID do CRM agendam
  `sincronizar_menu` na fila existente, com atraso de dois segundos.
- Consultar as últimas 20 mensagens pelo limitador REST existente e correlacionar
  exclusivamente pelo ID do CRM. A mesma consulta identifica o atendente humano.
  Jobs de mensagens superadas terminam sem HTTP. Mensagens com menu já persistido
  também não precisam de consulta adicional.
- Converter somente botões de resposta de automação em opções locais. Links,
  mensagens recebidas, internas ou humanas não são menus. Rejeitar rótulos
  ambíguos/inválidos. No modo nativo, ocultar o controle `Atendimento encerrado`.
- Persistir as opções na própria mensagem, sem reescrever seu texto. A seleção
  continua validada pelo atendimento e usa o rótulo canônico (ADR 007).
- Aplicar os dados numa transação curta, depois do HTTP, com a trava do
  atendimento. Não ativar menu de atendimento encerrado, com humano, de mensagem
  superada ou que já recebeu uma resposta do aluno. Preservar as opções no
  histórico quando a resposta chegou antes da consulta.
- Publicar a atualização pelo mecanismo LISTEN/NOTIFY existente. O widget
  atualiza a mensagem pelo ID; menus inativos aparecem como texto no histórico.
- Não modificar gatilhos, blocos, estados ou subautomações do original.
  Esta preparação não muda qual automação atende a conexão de teste.

## Alternativas Consideradas

- Acrescentar `▸` ao original: exige alterações que o usuário reservou para si.
- Manter um catálogo de botões baseado no export: duplica configuração e pode
  encaminhar uma opção incorreta depois de uma edição no CRM.
- Consultar toda a conversa continuamente: desperdício da cota REST do tenant.
- Usar apenas `/finish` para trocar a automação: não cancela esperas nativas,
  conforme a homologação da ADR 007.

## Consequências

O widget pode mostrar os botões do original sem exigir mudanças no texto.
As opções podem aparecer alguns segundos depois da mensagem. Consultas extras
compartilham a cota REST com vínculo e anexos; o limitador permanece em 10/min
por réplica. Em carga alta, a fila pode aumentar a demora. Mensagens superadas
não gastam uma consulta, mas respostas espaçadas podem exigir mais de uma.

A migração completa ainda depende de configuração manual por Tiago: gatilho,
proteção de atendimento humano, tratamento de identidade/Manter Janela por canal
e encerramento confirmado das esperas. O v2 permanece até essa homologação.

## Resultado

Validação local: 17 testes unitários; oito cenários de interface; integração
com Postgres descartável, callback HTTP real e REST simulada. Foram verificados
botões sem marcações, rótulo validado, ausência de balão duplicado, histórico,
jobs superados e proteção contra resposta, encerramento e transferência humana.

Publicado na Mapeamento em 2026-10-10: duas réplicas convergidas, migration 009
aplicada, saúde pública 200 e widget público idêntico ao arquivo local.
`iguacu` está com `menus_crm=true`, `texto_estruturado=true` e `fluxo_nativo=true`.
Os oito cenários de interface também passaram usando o widget baixado da produção.

Backup anterior: `/root/backups/webchat/pre-menus-crm-20261010-221326.sql.gz`.
Imagem anterior: `rhino-webchat:pre-menus-crm-20261010-221326`.

Homologação real com o aluno fictício: atendimento 23 recebeu saudação,
Secretaria → Declarações e imagem, encerrando em espera terminal. Atendimento
24 abriu uma sessão nova e encerrou com menu aberto. Ambos tiveram limpeza da
sessão e conclusão confirmadas no Postgres.

No atendimento fictício 25, somente a mensagem do espelho local foi preparada
sem as linhas `▸` e sem metadados, simulando o callback do original. Nenhuma
mensagem, automação ou espera do CRM foi editada para essa prova. O job publicado
consultou a REST real, recuperou os quatro botões, persistiu o menu e publicou
a atualização da mesma mensagem por WebSocket. A seleção validada de Secretaria
retomou a sessão nativa; o encerramento também foi confirmado. Trata-se de uma
prova controlada do adaptador em produção com o v2, não de homologação do original.
[Evidência estruturada](../evidencias/009-menu-crm-producao.json).

Ao concluir, atendimentos 23/24/25 encerrados e com sessão limpa; nenhum job
pendente/em execução com erro. Restava uma identificação de atendente agendada,
sem tentativas ou erro, que não bloqueia a operação. O fluxo original e suas
subautomações não foram alterados, e o v2 permanece atendendo a conexão de teste.

## Reversão

Desabilitar `menus_crm` na faculdade (cache de até 60 s por réplica). Jobs
pendentes respeitam o flag antes do HTTP. Menus já gravados continuam no
histórico e as linhas `▸` do v2 permanecem compatíveis. Não remover a migration.
