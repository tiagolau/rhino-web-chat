# 008 — Payload text.body na Conexão Universal

**Data:** 2026-10-10
**Status:** aceito

## Contexto

Tiago corrigiu as mensagens do boas-vindas original para usarem a conexão de
origem e pediu que o webchat adotasse `text.body`, já utilizado pelas condições
desse fluxo. Até então o webhook enviava `text` como string; o datasource com
`receiveJson=true` preserva o JSON recebido e não cria `text.body` por conta própria.

## Decisão

- Enviar `text: { body: "..." }`, mantendo os campos de identidade, anexos,
  correlação, atendimento e proteção de humano. O HMAC assina esse JSON bruto.
- O callback `/dc/:slug/send` aceita tanto string quanto objeto com `body`
  string. Valores incompatíveis retornam HTTP 400 antes de gravar; anexos sem
  legenda continuam válidos. Widget, banco e WebSocket conservam texto string.
- Migration 008 adiciona `faculdades.texto_estruturado`, desabilitado por padrão,
  para preparar cada conexão e migrar sem mudar o contrato das demais.
- Alinhar o mapeamento de recebimento do CRM para `text.body`, os templates de
  envio de texto/anexo e as condições do boas-vindas temporário. O gerador usa
  `[Message-1]text.body` nos dois modos, preservando o caminho do original.
- Esta mudança prepara a entrada compartilhada; não substitui por si só o v2
  pela automação original. Menus, identidade, Manter Janela e encerramento ainda
  precisam ser integrados conforme o canal.

## Alternativas Consideradas

- Alterar as condições do original para `text` string: aumenta as diferenças
  entre canais e contraria o contrato pedido.
- Enviar duas chaves JSON chamadas `text`: ambíguo; parsers conservam apenas uma.
- Mudar o contrato interno do widget: desnecessário, pois a adaptação pertence
  à fronteira com o CRM.

## Consequências

Condições do original podem ler o texto do webchat pelo mesmo caminho. A leitura
de callbacks antigos permanece compatível. A reversão do envio exige coordenar
o flag da faculdade, o mapeamento da conexão e os campos das condições.

## Resultado

Validação local: 15 testes unitários, integração com Postgres descartável e
callback HTTP real (legado, estruturado, menu, anexo e payload inválido), assinatura
HMAC do novo corpo, fila e encerramento antes da nova entrada. O gerador também
foi validado contra o export corrigido de 17 automações e 153 blocos.

Backup anterior à publicação:
`/root/backups/webchat/pre-text-body-20261010-215741.sql.gz`.
Imagem anterior: `rhino-webchat:pre-text-body-20261010-215741`.

Publicado na Mapeamento, duas réplicas convergidas e `/health` saudável.
`iguacu` está com `texto_estruturado=true`; o mapeamento persistido no CRM é
`text.body` e os dois templates (texto e anexos) enviam o objeto. HMAC e a
credencial existentes foram preservados. As três condições de texto do v2
foram editadas no painel, sem duplicar a automação. O export confirmou fluxo
ativo, 126 blocos, três parâmetros `[Message-1]text.body` e referências válidas.
A cópia protegida (600, fora do Git) é
`datacrazy/gerado/webchat-iguacu-text-body-validado.json`.

Homologação real apenas com o aluno fictício: atendimento 21 recebeu saudação,
menu, Secretaria → Declarações e imagem pelo template estruturado. Foi encerrado
durante a espera terminal; o atendimento 22 recebeu nova saudação e menu, e
foi encerrado com o menu aberto. Os dois tiveram limpeza da sessão e conclusão
confirmadas no Postgres. A fila não apresentou erros. A primeira conexão do
script coincidiu com a atualização das réplicas; o ensaio foi repetido após
convergência e completou.

[Evidência do mapeamento salvo](../evidencias/008-text-body-conexao.png).

## Reversão

Para reverter somente o contrato, voltar `texto_estruturado=false`, o mapeamento
para `text` e os três parâmetros de texto do v2 para `[Message-1]text`, de forma
coordenada, sem mensagens de teste em trânsito. Os templates estruturados de
resposta continuam compatíveis com o backend novo; também podem voltar a string.
O flag tem cache de até 60 s por réplica. Não remover a migration já aplicada.
Para retornar a imagem antiga, primeiro restaurar os templates de resposta em
string, pois a versão anterior não interpreta objetos em `text`.
