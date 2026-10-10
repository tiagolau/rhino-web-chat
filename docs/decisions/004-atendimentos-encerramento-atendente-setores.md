# 004 — Atendimentos no widget, encerramento, nome do atendente e roteador de setores

**Data:** 2026-10-10
**Status:** aceito. Em produção (branch `feat/atendimentos-e-setores`, ainda sem commit) e validado de ponta a ponta na conexão de teste da Iguaçu.

## Contexto

Depois do primeiro teste real (ADR 003), o Tiago pediu:

1. **Encerrar a conversa** no widget, com **cada suporte sendo uma conversa** separada. Só no widget: no DataCrazy o aluno pode continuar com uma conversa só.
2. **Mostrar qual atendente** está atendendo.
3. **Automação de setores** para a conexão do webchat, a partir do fluxo do WhatsApp da Iguaçu (`boas-vindas-iguaçu.json`, 17 automações: boas-vindas, menus de setor e subfluxos SEC/PED/DOC), **sem pedir nome e CPF**, porque o aluno está logado no Eduno.

O que foi levantado (detalhes em [datacrazy-conexao-universal.md](../datacrazy-conexao-universal.md)):

- A Conexão Universal **não tem variável de atendente nem de botões** (documentação oficial). A assinatura não vem no corpo da mensagem.
- A REST tem o que falta: `histories` da conversa (`conversation-opened`/`attendant-added` com `attendantName`, `conversation-finished`), `attendant.name` nas mensagens e `POST /conversations/{id}/finish`. Finalizar e gravar anotação interna **não mandam nada** ao aluno.
- No DataCrazy, cada atendimento de uma conversa é uma "thread" (ticket com `code`).
- **Teste de botões na conexão:** o DataCrazy **não envia os botões** (só o texto) e **não espera o clique**. Cada mensagem do aluno dispara de novo a automação de entrada, e o gatilho continua disparando **mesmo depois que um atendente assume**. Os menus do WhatsApp, que dependem de esperar o clique, não funcionam como estão.

## Decisão

### Atendimentos (backend)

- Tabela **`atendimentos`** (migrations `003_atendimentos.sql` e `004_finalizado_dc.sql`): número sequencial por aluno, `aberto`/`encerrado`, nome do atendente, quem encerrou. No máximo **um aberto por aluno**. Cada mensagem ganha `atendimento_id`. As mensagens que já existiam viraram o atendimento nº 1.
- **Abrir:** a primeira mensagem do aluno, ou do atendente/robô, depois de um encerramento abre o próximo atendimento.
- **Encerrar pelo aluno:** `POST /api/atendimentos/encerrar`. O job `finalizar_no_datacrazy` chama o `/finish` e grava uma anotação interna ("O aluno encerrou este atendimento pelo webchat").
- **Encerrar pelo DataCrazy:** a automação "atendimento finalizado" (`thread-finished-trigger` na conexão do webchat) chama **`POST /dc/:slug/evento`** com a mesma `X-Api-Key` do envio, levando `${conversationId}` e `${leadId}`. Cobre o atendente finalizando, o robô encerrando ("Encerrar atendimento" dos subfluxos, timeout de inatividade).
- **Eco:** o nosso `/finish` também dispara essa automação (chega em ~0,2 s). O job marca `dc_finalizado_em` antes e depois da chamada, e um evento até 30 s depois disso é ignorado, para não fechar um atendimento novo. (A primeira versão usava "aluno encerrou há menos de 2 min" e engoliu um encerramento legítimo no teste.)
- **Atendente:** a cada mensagem do atendente, o job `identificar_atendente` lê `GET /conversations/{id}/messages` (1 chamada; id da conversa em cache) e pega o último `conversation-opened`/`attendant-added`/`attendant.name` desde o início do atendimento. Mudou → grava e põe na linha do tempo "<nome> está te atendendo", com a hora do DataCrazy. **Limite:** no máximo 1 consulta por minuto por atendimento sem atendente, e 1 a cada 5 min com atendente (pega transferências).
- **Webhook para o DataCrazy** ganhou dois campos que a automação lê: `novo_atendimento` (`sim` na primeira mensagem do aluno no atendimento) e `com_atendente` (`sim` quando um humano já assumiu).
- Avisos na linha do tempo são mensagens `direcao = 'sistema'`. O WebSocket ganhou o evento `atendimento`.
- Rotas: `GET /api/historico[?atendimento=]` devolve `{ atendimento, mensagens }`; `GET /api/atendimentos` lista os anteriores. Vale a regra da ADR 003: num dispositivo novo só aparece o que teve movimento depois do primeiro acesso.

### Widget

- Mostra **só o atendimento atual**. Cabeçalho: faculdade e "<nome> está te atendendo" / "Aguardando atendente" / "Atendimento encerrado".
- Barra com **"Encerrar atendimento"** (com confirmação) e **"Atendimentos anteriores"** (lista e leitura).
- Encerrado: o campo de texto dá lugar a "Iniciar novo atendimento". Encerrado há mais de 30 min, o widget já abre vazio.
- **Opções de menu:** linhas `▸ Opção` no fim de uma mensagem viram botões. Só a última mensagem da conversa fica clicável; o clique envia o texto da opção. Menus antigos ficam como texto.

### Automação do DataCrazy: roteador

Gerador `datacrazy/gerar_automacoes_webchat.py`. Lê o export do fluxo do WhatsApp da faculdade e monta **uma automação sem estado**, que roda a cada mensagem do aluno:

```
com_atendente = sim?             → nada (o humano conduz)
texto = opção de algum menu?     → faz o que o botão fazia no WhatsApp
novo_atendimento = sim?          → "Olá, <nome>!", tag Eduno, menu de setores
senão                            → nada (texto livre para o atendente)
```

- Menus e subfluxos são **copiados para dentro** do roteador (`start-another-automation` vira ligação direta). Os botões viram as linhas `▸`; cada submenu ganha `▸ Menu inicial`.
- **Não pede nome nem CPF e não cria lead** (o backend vincula pelo CPF; um `create-lead-action` criaria lead duplicado). A tag **Eduno** é automática: todo aluno do webchat vem do portal, então a pergunta do período de matrícula (Universa ou Eduno) saiu.
- **Horário:** os menus de setor passam por seg-qui 08-18h / sex 08-17h. Fora do horário, avisa e para. O "Manter Janela" (mensagens a cada 23 h para a janela de 24 h do WhatsApp) não é copiado.
- **Tag "Teste Webchat"** (`507ad07e-130c-4aa9-908e-64eba143a0d6`, no lead "Aluno Teste Webchat") pula a checagem de horário, para testar a qualquer hora.
- Também gera "Webchat <faculdade>: atendimento finalizado".
- A saída (`datacrazy/gerado/`) fica fora do git porque leva a `API_KEY`. **Mudou o fluxo do WhatsApp → exportar de novo e gerar de novo**; não editar o roteador no painel.

## Alternativas Consideradas

- **Reaproveitar a boas-vindas e os menus do WhatsApp como estão** (primeira versão desta ADR): o teste mostrou que nesse canal o DataCrazy não envia os botões nem espera o clique.
- **Ler os botões pela REST** (a mensagem guarda `buttons`) e manter os menus originais: custaria uma chamada por rajada do robô, e a resposta ainda não seguiria pelo botão. O roteador resolve as duas coisas sem gastar cota.
- **Menu de setores nativo no widget:** duplicaria a árvore de menus fora do DataCrazy, onde a equipe da faculdade não mexe.
- **Uma conversa nova no DataCrazy por atendimento:** rejeitada pelo pedido (centralizar no DataCrazy) e porque espalharia o histórico.
- **Nome do atendente pelo template da conexão:** não existe variável.
- **Nome em cada balão** (REST a cada mensagem): ~13 req/min no pico, perto dos 30 req/min do tenant.
- **Descobrir o encerramento consultando a REST:** gasto contínuo e atraso. A automação avisa na hora e de graça.

## Consequências

- O aluno vê cada suporte separado e pode encerrar; o atendente continua com o histórico inteiro numa conversa só.
- O nome do atendente aparece até 1 min depois da primeira resposta; uma transferência, em até 5 min. Até o backend saber do atendente, uma opção de menu enviada pelo aluno ainda pode acionar o robô.
- O roteador é uma cópia: edição nos menus do WhatsApp só chega ao webchat depois de gerar e importar de novo.
- O texto das opções vai junto na mensagem, então o atendente vê no painel as opções que o aluno recebeu.
- Se a automação "atendimento finalizado" estiver desativada ou falhar, o widget só percebe o encerramento quando o aluno escrever de novo; aí a conversa segue no mesmo atendimento do widget, e o menu não aparece.
- Fora do horário, o aviso do webchat diz que a mensagem ficou registrada e será respondida no próximo horário (no WhatsApp, pede para voltar dentro do horário).
- Cada faculdade nova precisa gerar e importar as duas automações ([faculdade-nova.md](../faculdade-nova.md), passo 5).

## Resultado (2026-10-10)

- **Em produção** (deploy na Mapeamento; dump do banco antes da migration em `/root/backups/webchat/pre-003-20261010-160731.sql.gz`).
- **Importado e ativo** na conexão "Webchat Iguaçu (teste)": "Webchat Faculdade Iguaçu: roteador" (85 blocos, 28 opções) e "Webchat Faculdade Iguaçu: atendimento finalizado".
- Validado em produção com o aluno de teste (`app/scripts/conversa.mjs`) e no navegador (Playwright em `/chat`):
  - saudação com o primeiro nome + menu de setores; Secretaria → Declarações (texto, link e imagem); Pedagógico → Orientações TCC → Monografia (arquivo .doc); "Menu inicial"; texto livre sem resposta do robô;
  - "Encerrar atendimento" do fluxo → `/finish` → evento → widget "encerrado por datacrazy";
  - encerrar pelo widget → `/finish` + anotação interna; eco ignorado;
  - atendente humano (Tiago) assumiu → "Tiago Lau Chaves está te atendendo" antes da primeira resposta; com atendente, o robô ficou quieto mesmo com opções; finalizado pelo painel → widget encerrado; mensagem seguinte → atendimento novo, com menu.
- 8 testes unitários passando.
