# Compatibilidade do webchat com o boas-vindas da Iguaçu

**Data:** 2026-10-10
**Estado:** Tiago adicionou o gatilho do webchat e ativou o original; contrato de transporte corrigido pela ADR 010. A homologação completa das esperas/reinício do original continua pendente.
**Decisões:** [ADR 010](decisions/010-transporte-original-sem-ack-e-recuperacao-da-fila.md) (original em produção) e ADRs 007–009 (preparação do backend).

## Homologação operacional — 2026-10-10

O ciclo foi repetido na conexão de teste com o aluno fictício já previsto no
projeto. O e2e público confirmou sessão, WebSocket, envio de texto e imagem,
download do anexo (`200 image/png`), histórico e retomada por token. A mensagem
e o arquivo foram persistidos na conversa Universal; o arquivo foi transferido
ao CDN e registrado no lead.

No fluxo original, a saudação abriu o menu de setores e a escolha de Secretaria
foi aceita. O fluxo enviou o aviso visual de feriado e a mensagem de fora do
horário. O teste ocorreu às 23:44 no horário local; por isso, a rota de
Declarações e suas esperas terminais não foram alcançadas nesta execução.
O CRM mostrou uma saudação e um menu persistidos para esse atendimento; as duas
atualizações de menu vistas no log do script não eram mensagens duplicadas no
histórico do CRM.

A atribuição do atendimento fictício a um atendente foi confirmada no painel.
Uma mensagem posterior do aluno chegou ao CRM sem nova resposta automática.
Uma resposta textual enviada pelo CRM chegou ao widget, e o encerramento pelo
widget concluiu a conversa no CRM (`finished=true`). O encerramento de outro
atendimento enquanto o menu estava aberto também foi aceito.

Validação de código: 17 testes unitários, nove cenários de UI simulada e as
integrações de menus/encerramento, anexos e retenção passaram. Na conferência
final da produção, não havia jobs pendentes, em execução ou com erro; os sete
anexos estavam transferidos, sem cópias locais, e não havia mensagens vencidas
aguardando limpeza. `/health` respondeu saudável e `/chat` respondeu HTTP 200.
No Swarm, `webchat_app` estava em 2/2 réplicas, `webchat_postgres` em 1/1 e a
última atualização do serviço constava como concluída.

**Resultado parcial:** transporte, anexo, resposta do atendente, atribuição
humana e encerramento foram comprovados. A homologação do ramo em horário de
atendimento, das esperas terminais e do reinício do fluxo original permanece
pendente. A automação original e suas subautomações não foram alteradas nesta
execução; qualquer ajuste nelas cabe exclusivamente ao Tiago.

## Incidente após a ativação do original — ADR 010

Após Tiago adicionar o gatilho e ativar o original, o backend ficou esperando
um `sessao_encerrada` que esse fluxo não envia. Um encerramento às 22:26 reteve
dez mensagens posteriores antes do webhook. O JSON `text.body` estava correto.
Histórico e logs do CRM confirmaram recebimento anterior, inclusive os botões
originais; não era falha do navegador ou da assinatura.

`confirmar_encerramento=false` separa a finalização REST do protocolo do v2.
`fluxo_nativo`, `texto_estruturado` e `menus_crm` permanecem habilitados. O
backend finaliza a thread, sem inventar o ACK nem enviar controle ao original.
Mensagens de atendimentos já encerrados são recuperadas como notas internas,
com horário original; as do aberto seguem normalmente. Detalhes, verificações
e limites estão na [ADR 010](decisions/010-transporte-original-sem-ack-e-recuperacao-da-fila.md).

Essa configuração restaura o transporte; não comprova que `/finish` cancelou
as esperas do robô. Para habilitar novamente o ACK ou garantir reinício de
menus, Tiago precisa integrar o encerramento no fluxo. O roteiro abaixo para
o protocolo estrito permanece como referência, não como requisito do envio.

## Revisão após correção do fluxo original

Tiago esclareceu que o objetivo é compartilhar a automação original e suas
subautomações entre WhatsApp e webchat, sem manter uma cópia independente.
Após sua correção dos destinos, um novo export obtido do painel em 2026-10-10
(`Downloads/boas-vindas-iguaçu (1).json`) confirmou 17 automações, 153 blocos,
nenhum bloco de mensagem com plataforma, provedor ou instância fixos e
`hasInvalidReferences: false`.

Na revisão anterior à ADR 008, o gatilho da entrada ainda apontava apenas à instância WhatsApp. Há 13 mensagens
com botões, nenhuma com as linhas `▸` usadas pelo widget, duas condições que
leem `[Message-1]text.body` e nenhum bloco API
para o reconhecimento `sessao_encerrada` exigido pelo encerramento nativo atual.
Coleta/criação de identidade e Manter Janela permanecem no conjunto original e
precisam ser avaliados conforme o canal. A mudança de destinos resolve o envio,
mas não conclui a migração compartilhada.

Na consulta anterior à ativação feita por Tiago, a entrada `Boas Vindas Iguaçu` estava desativada tanto no painel
quanto no export; as 16 subautomações estavam ativas no export. Nenhum gatilho
foi adicionado e nenhum fluxo foi ativado/desativado nesta revisão. As seções
seguintes registram também a adaptação separada anteriormente publicada.
Após essa revisão, Tiago ativou o original; o transporte atual usa a ADR 010.

A [ADR 008](decisions/008-payload-text-body.md) passou a alinhar o payload do
webchat com o caminho `text.body` do original, sem mudar essas condições.
Essa etapa remove a diferença de formato de texto; as demais adaptações para
compartilhar o conjunto original continuam necessárias.

## Preparação para compartilhar o original — ADR 009

O backend agora pode recuperar os botões reais da conversa pela REST e entregar
ao widget os metadados de menu por mensagem. Não é necessário acrescentar `▸`
ao texto do original. A consulta usa a fila e o limitador existentes e também
identifica o humano; menus respondidos, superados ou encerrados não são reativados.
O flag por faculdade é `menus_crm` (padrão false), habilitado somente na Iguaçu
de teste em produção. A [ADR 009](decisions/009-menus-do-crm-sem-alterar-fluxo-original.md)
registra as verificações, a reversão e a prova controlada com botões reais no
atendimento fictício 25. Os atendimentos 23/24 também confirmaram o funcionamento
do v2 após a publicação, com menus, anexo, encerramento e reinício.

**Restrição permanente:** somente Tiago altera o boas-vindas original e suas
subautomações. Consultas e exports são permitidos; não editar blocos, adicionar
gatilhos, ativar ou desativar esse conjunto por automação do agente.

### Configuração do original sob responsabilidade de Tiago

1. Na entrada original [Boas Vindas Iguaçu](https://crm.datacrazy.io/flow/f7689e27-009d-47cb-afaa-22cfc519c4a0),
   O gatilho para **Webchat Iguaçu (teste)** já foi adicionado por Tiago, instância
   `6aca6a619ab27fb81a32e33e`, recebendo o JSON. O texto já chega em `text.body`.
   Conferir o nome do datasource criado pelo gatilho: condições e callbacks
   precisam referenciar o datasource da entrada efetivamente executada, inclusive
   `atendimento_id`. Um segundo gatilho não garante o nome `[Message-1]`.
2. Fazer o caminho do webchat reconhecer o lead previamente vinculado pelo
   backend e a origem Eduno. Não pedir novamente nome/CPF nem criar outro lead.
   O original verifica tags como Eduno; a identificação pelo portal não garante
   que todo lead existente tenha essa tag. O v2 adiciona a tag, o backend atual
   não a adiciona por conta própria.
3. Desviar o webchat dos ramos **Manter Janela**, exclusivos do WhatsApp, e
   proteger a execução quando um atendente assumiu. O gatilho Universal dispara
   a cada mensagem; `only-if-finished-service` sozinho não impediu reentrância.
   Usar o estado atual da conversa; o datasource inicial fica preservado após
   uma espera e não deve representar a escolha seguinte ou o humano atual.
4. Para adotar o encerramento estrito da ADR 007, integrar o encerramento da sessão
   nativa no caminho webchat e só então habilitar `confirmar_encerramento`.
   Nesse modo o backend envia `Atendimento encerrado` e espera o callback abaixo.
   No modo atual, com o flag false, esse controle não é enviado. Toda espera acessível no
   webchat precisa consumir esse controle, concluir sua execução e confirmar
   o atendimento de origem. Preservar a experiência WhatsApp ao configurar os
   caminhos por canal. **Somente `/finish` não elimina a espera do robô.**

   `POST https://webchat.engrenatec.com.br/dc/iguacu/evento`, com
   `Content-Type: application/json` e a credencial `X-Api-Key` já usada pela
   conexão, sem publicar seu valor em documentação. Corpo:

   ```json
   {"evento":"sessao_encerrada","atendimentoId":"${[datasource-da-entrada]atendimento_id}"}
   ```

   O nome entre colchetes é ilustrativo: selecionar o datasource real no painel.
   Esse reconhecimento não substitui o evento de atendimento finalizado já
   usado para espelhar o encerramento no widget.

### Corte e validação

Tiago já ativou o original. Conferir as configurações restantes na homologação.
A ativação e as mudanças dos fluxos são feitas exclusivamente por Tiago.
Coordenar com ele a desativação do
[v2 temporário](https://crm.datacrazy.io/flow/b87e508a-342f-4a4a-ba9a-40cd86e83cca)
para impedir dois fluxos respondendo ao mesmo gatilho. Não apagar o v2 antes
da homologação do compartilhado.

Homologar primeiro com o aluno fictício: saudação → Secretaria → Declarações
e anexo; menus com rótulos iguais em ramos distintos; transferência para humano;
encerramento com menu aberto e em espera terminal; novo atendimento sem consumir
uma opção antiga. No modo atual, conferir `dc_encerramento_concluido_em` e a fila;
`dc_sessao_limpa_em` permanece vazio, pois não houve ACK de limpeza. No modo
estrito, conferir também esse campo e o callback. Regressão do WhatsApp
deve usar um contato de teste definido pelo usuário.

O compartilhado já recebe mensagens em produção. A homologação completa do
ciclo de esperas, reinício e atendimento humano continua pendente; a entrega
das mensagens e os botões não comprovam essas garantias.

## Diagnóstico

O impedimento estava na adaptação, não na capacidade de esperar do motor do
DataCrazy. A Universal não entrega metadados de botões ao endpoint de envio,
mas continua uma sessão nativa quando recebe o rótulo exato. A primeira prova
negativa tinha outro roteador ativo: seu menu sobrescreveu a espera.

O roteador antigo também indexava todas as opções pelo texto. Dois botões
`Encerrar atendimento` do original têm destinos diferentes, e essa diferença
se perdia. A saudação e os atalhos anteriores ao menu haviam sido simplificados.
O primeiro webhook podia sair antes do vínculo ao lead.

## Adaptação implementada

O export original (17 automações, 153 blocos) passa a alimentar um boas-vindas
nativo incorporando os subfluxos. A versão final tem 126 blocos, 30 opções
originais, oito opções internas de encerramento e os mesmos 14 envios de arquivo.
O gerador normaliza os destinos WhatsApp para a conversa Universal atual,
mantém os ramos e limita mudanças de departamento à conversa atual.

Nome e CPF continuam vindo do Eduno. O backend procura o lead pelo CPF e celular
antes de criar; o fluxo não coleta identidade, não cria outro lead nem executa
Manter Janela. A tag Eduno é adicionada e o vínculo termina antes do webhook.

Menus são persistidos por mensagem e atendimento. O widget envia
`{menuId, opcaoId}`; o backend aceita apenas o menu atual, escolhe o rótulo
canônico e protege cliques concorrentes/repetidos. O DataCrazy decide pelo botão
da sessão atual, preservando ramos com rótulos iguais.

Uma condição nativa verifica o atendente atual antes dos ramos e timeouts.
`[Message-1]text` conserva o payload inicial depois de uma espera; não é usado
para decidir escolhas seguintes.

## Encerramento e reinício

`/finish` fecha a thread, mas não cancela a espera nativa. Desativar e reativar
automações também não limpou essa espera, embora a ação tenha executado sem erro.

O job de encerramento envia o controle `Atendimento encerrado`. Todos os menus
têm uma opção nativa de controle, omitida das linhas visíveis. As seis esperas
terminais por texto também reconhecem seu fim. O fluxo chama o backend com
`sessao_encerrada` e o ID do atendimento. Só depois dessa confirmação o backend
finaliza a thread e libera os envios do atendimento seguinte.

O controle aparece no CRM como registro do encerramento, mas não cria um balão
de aluno no espelho local. A confirmação de uma sessão antiga não muda o menu
nem o estado de um atendimento novo.

## Validação

- 13 testes unitários, sete cenários de UI simulada e integração com Postgres
  real descartável e CRM simulado.
- Integração verifica vínculo antes do webhook, ordem, cliques concorrentes,
  texto adulterado, repetição, menu antigo, humano e bloqueio da nova entrada
  até a confirmação de encerramento.
- Validação estrutural verifica os 30 botões originais, os 14 arquivos,
  referências, ramos distintos e ausência de coleta/criação de identidade.
- Execução real: saudação, Secretaria → Declarações, Documentos → Certificado
  por Correio e recebimento de anexos. Reinício depois de espera terminal
  comprovado nos atendimentos fictícios 16 → 17, com confirmação no Postgres.
- Backend publicado com migrations 006/007 e duas réplicas. Só a conexão de
  teste Iguaçu foi alterada. WhatsApp e distribuição do widget não foram migrados.

Resultados complementares de homologação e limites estão na ADR 007.

## Operação e reversão

Importar pelo painel; a OpenAPI pública não expõe automações nem retomada de
sessão. Exportar alterações do WhatsApp e regenerar: não há sincronização
automática. Não manter dois gatilhos de entrada ativos na mesma conexão.

A estrutura da entrada da Iguaçu é usada para excluir a coleta de identidade;
outra faculdade exige revisão e homologação específica. Há instruções em
[faculdade nova](faculdade-nova.md).

Para reverter, desativar o boas-vindas, reativar o roteador legado e colocar
`fluxo_nativo=false`. O backend então finaliza sem exigir o reconhecimento nativo.
As migrations são aditivas. Backup e imagem anterior estão na ADR 007.

## Referências

- [Envio: documentação oficial](https://docs.datacrazy.io/universal-connection/sending-messages)
- [Recebimento: documentação oficial](https://docs.datacrazy.io/universal-connection/receiving-webhooks)
- [OpenAPI pública](https://api.datacrazy.io/v1/api/openapi/v1/json)
