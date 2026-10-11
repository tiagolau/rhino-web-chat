# 007 — Boas-vindas nativo e menus por atendimento

**Data:** 2026-10-10
**Status:** aceito

## Contexto

O roteador da ADR 004 reaproveitava o conteúdo do boas-vindas da Iguaçu, mas
indexava opções globalmente pelo texto. Dois botões chamados `Encerrar atendimento`
levavam ao mesmo ramo, embora no original Dispensa TCC agradeça antes de finalizar
e Orientação TCC finalize diretamente. A saudação e os atalhos da entrada também
haviam sido simplificados. O vínculo do lead pela fila podia terminar depois do
primeiro webhook, prejudicando decisões que dependessem do cadastro.

A prova em produção, exclusivamente com o aluno fictício e a tag Teste Webchat,
mostrou que a Conexão Universal **retoma botões nativos pelo rótulo exato**. O primeiro
ensaio havia recebido outro menu do roteador ativo, que sobrescreveu a espera.
Sem essa interferência, funcionaram botões e `text-input-message` com os dois
modos de inicialização testados. A ausência de botões no endpoint de saída não
significa ausência de sessão no motor.

Outro ensaio confirmou que `[Message-1]text` continua contendo a mensagem inicial
após uma coleta por `text-input-message`. Esses campos do gatilho não podem decidir
as escolhas seguintes nem detectar a entrada posterior de um humano.

## Decisão

- Gerar uma adaptação nativa do export original por `--modo nativo`, incorporando
  subautomações e preservando os destinos dos botões, textos, 14 arquivos e
  atalhos de entrada. Usar `only-if-finished-service`, na instância Universal.
- Manter os botões no CRM e acrescentar linhas `▸` aos textos para sua apresentação
  no widget. A seleção do navegador usa `{menuId, opcaoId}`; o servidor valida
  a opção do menu atual e envia o rótulo canônico à sessão nativa do DataCrazy.
- Persistir o menu por mensagem/atendimento na migration 006 e a confirmação
  de encerramento na migration 007. IDs são locais à
  mensagem e ao menu, sem roteamento global por texto. Histórico e WebSocket
  carregam os mesmos metadados. Não é necessário callback extra por menu.
- Recusar menus antigos, cliques após encerramento e cliques durante atendimento
  humano. Uma transação curta trava aluno/atendimento no Postgres, deduplica pelo
  `clienteId` e permite apenas uma seleção simultânea entre abas ou réplicas.
- Aguardar `lead_id` antes do webhook e conservar a ordem dos envios pendentes
  pela fila já existente. Mensagens novas abrem atendimento; cliques antigos e
  repetições não criam atendimentos vazios.
- Remover coleta de nome/CPF, criação de lead e Manter Janela. Os dados do Eduno
  e o vínculo do backend continuam sendo a fonte da identidade. Ações de mudança
  de departamento ficam limitadas à conversa atual, inclusive nos atalhos.
- Antes de entrar no fluxo e nos ramos de botão/timeout, consultar nativamente
  `conversation-has-attendant-condition`, com `attendantIds: []`, para respeitar
  o estado atual do CRM. O campo `com_atendente` fica como proteção adicional na
  entrada; não representa o estado atualizado de uma sessão já em espera.
- O backend encerra a espera nativa com o controle `Atendimento encerrado`.
  Todo menu tem uma opção nativa adicional, omitida das linhas visíveis, que
  termina a sessão e chama `sessao_encerrada` com o ID do atendimento. As seis
  esperas terminais por texto também chamam esse reconhecimento ao terminar.
  Uma sessão já terminada reconhece o controle na entrada, sem nova saudação.
- Só executar `/finish` e liberar os envios do próximo atendimento após esse
  reconhecimento. O job de encerramento também atende eventos do CRM; a
  confirmação fica no atendimento correspondente, sem afetar um atendimento
  mais novo. O controle aparece no CRM como registro do encerramento do webchat.
  Não gera balão de aluno no histórico local.
- Manter o modo `roteador` para reversão. `faculdades.fluxo_nativo` permite iniciar
  a sessão nativa na próxima mensagem de atendimentos automáticos já abertos.
  Os atendimentos com humano não são reiniciados pela migração.

## Alternativas Consideradas

- Interpretar o JSON inteiro no backend: duplicaria condições, departamentos,
  horários e ações já executados pelo CRM.
- Roteamento global por rótulo: não distingue opções iguais em menus diferentes.
- Decidir pelo payload bruto após cada coleta: datasource inicial ficou antigo
  no teste real.
- Desativar/ativar automações no encerramento: executou sem erro no painel,
  mas não limpou a espera pendente no teste real.
- Consultar botões pela REST a cada interação: consome a cota compartilhada sem
  necessidade; as opções podem viajar no texto da mensagem já recebido.
- Importar o original sem adaptar: manteria destinos WhatsApp, coleta de CPF/nome,
  criação duplicada de lead e Manter Janela.

## Consequências

Mantém Node/Fastify, Postgres, fila e LISTEN/NOTIFY, sem Redis ou outro motor de
fluxos. O mesmo export do WhatsApp passa a ser a fonte da navegação e das ações,
com adaptação explícita para o canal. Mudanças nesse export precisam de regeneração
seguida de importação no painel; não existe sincronização automática.

O JSON usa a estrutura da entrada da Iguaçu para identificar os pontos onde a
identidade e a classificação de aluno deixam de ser solicitadas. Uma faculdade
com entrada diferente exige revisão do gerador e homologação específica.

## Resultado e validação

Backend publicado na Mapeamento, com migrations 006/007 e duas réplicas. Widget público
conferido por SHA-256 contra o arquivo local. Fluxo nativo importado em
`/flow/b87e508a-342f-4a4a-ba9a-40cd86e83cca`, roteador anterior desativado e preservado.
As cinco automações WCPOC foram desativadas. Apenas o canal de teste da Iguaçu
foi alterado; os fluxos de WhatsApp não foram substituídos.

Validação local: 13 testes unitários, sete cenários de UI simulada, integração
com Postgres real em banco descartável e CRM simulado, e verificação estrutural
do export (30 botões, 14 arquivos, destinos duplicados distintos, referências
válidas, ausência de coleta de identidade/criação de lead).

Execução real, exclusivamente com o aluno fictício:

- Saudação original, Secretaria → Declarações e Documentos → Certificado por
  Correio, com imagens recebidas.
- Atendimentos 16 → 17: encerramento durante a espera terminal por texto,
  reconhecimento no Postgres e nova saudação/menu sem consumir a nova mensagem.
- Atendimento 17: Pedagógico → Orientações TCC → Monografia, com modelo DOC recebido.
  Encerramento com menu aberto, seguido imediatamente de nova mensagem; o
  atendimento 18 recebeu saudação/menu depois da limpeza da sessão 17.
- Atendimento 18: resposta humana pelo painel, menu invalidado e atendente
  identificado como Tiago Lau Chaves. Mensagens `Secretaria` e texto livre não
  produziram resposta automática. Encerramento pelo painel reconhecido e
  concluído, sem jobs restantes.
- Atendimento 19: Dispensa TCC → Encerrar atendimento enviou o agradecimento
  original antes de finalizar, confirmando seu ramo específico.
- Atendimento 20: Orientações TCC → Artigo Científico, com modelo DOCX recebido.
  O fechamento deste ramo é direto, distinto do agradecimento de Dispensa TCC.

Os 14 arquivos e os prazos originais foram verificados estruturalmente; não
foi feito ensaio de todos os arquivos nem uma espera real completa de 30 minutos.
A entrada especial por palavras-chave e o atendimento fora do horário não foram
exercitados nessa homologação; os ramos foram preservados e o aluno fictício usa
a tag de teste que dispensa horário. Isso não substitui a homologação de outra
faculdade ou a liberação do widget a todos os alunos.

As ações experimentais de desativar/ativar automações foram retiradas da
finalização: o reconhecimento explícito no boas-vindas é o mecanismo adotado.
O fluxo anterior e as cinco POCs permanecem desativados, preservados para revisão.
A automação final de entrada é `Webchat Faculdade Iguaçu: boas-vindas v2`.

O export final obtido do painel confirmou `active: true`, 126 blocos e
`hasInvalidReferences: false`. A cópia está em
`datacrazy/gerado/webchat-iguacu-nativo-validado.json`, fora do Git e com permissão
600, pois contém a credencial do callback. [Captura do fluxo ativo](../evidencias/007-boas-vindas-ativo.png).

## Reversão

Desativar o boas-vindas e reativar o roteador anterior na mesma conexão; nunca
manter dois gatilhos de entrada ativos. Desabilitar `faculdades.fluxo_nativo` e
esperar o cache de 60 s. As colunas adicionais são compatíveis com a versão
anterior; não é necessário apagar histórico nem remover a migration.

Backup anterior: `/root/backups/webchat/pre-compatibilidade-20261010-205450.sql.gz`.
Imagem anterior: `rhino-webchat:pre-compatibilidade-20261010-205450`.
