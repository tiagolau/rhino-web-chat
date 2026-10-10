# 005 — Redesign da central do aluno e do widget

**Data:** 2026-10-10
**Status:** aceito

## Contexto

A página `/chat` usava a mesma janela estreita do widget, com formulário e conversas sem uma apresentação própria. Tiago pediu uma identidade mais moderna para a solução, mantendo a operação de suporte existente.

## Decisão

- Recompor a página como uma central do aluno: apresentação RJ Global, orientações de uso e área de atendimento com maior largura no desktop.
- Adotar um sistema visual compartilhado no Shadow DOM: azul profundo, verde petróleo, superfícies claras, espaçamento amplo, hierarquia tipográfica e ícones SVG próprios. Fontes disponíveis no aparelho; sem requisições a provedores de fontes.
- Redesenhar formulário, janela do portal, mensagens, anexos, menus de setores, histórico e encerramento. A faculdade e o atendente continuam vindo da sessão e dos eventos reais; a interface não afirma disponibilidade instantânea.
- Montar o widget em `#chat-mount` quando existir na página própria, mantendo a inclusão no `body` como fallback e no portal.
- No celular, apresentar os campos numa coluna, permitir rolagem natural da página de identificação e manter o widget do portal em tela cheia. Respeitar movimento reduzido e oferecer foco visível.
- Preservar JavaScript ES5, Shadow DOM e os contratos existentes de sessão, REST e WebSocket. Nenhuma dependência ou migration adicionada.

## Alternativas Consideradas

- Apenas trocar cores da janela existente: não resolveria o aproveitamento de espaço e a hierarquia da página própria.
- Migrar para React ou adicionar biblioteca de componentes: custo e dependências desnecessários para duas superfícies em JavaScript puro.
- Criar menus de setores próprios no frontend: duplicaria a árvore que pertence ao DataCrazy (ADR 004).
- Fontes e ícones por CDN: criariam dependência externa desnecessária dentro do portal.

## Consequências

- Página e widget passam a compartilhar a mesma identidade visual, com apresentação adaptada ao espaço disponível.
- O novo `#chat-mount` é opcional; a inclusão atual do widget nos portais continua funcionando.
- A tipografia pode variar ligeiramente entre sistemas operacionais pela escolha de fontes locais.
- A simulação de navegador valida os contratos de UI, mas não substitui uma verificação de integração após eventual deploy.

## Resultado

Implementado na branch `feat/redesign-webchat`, commitado e publicado na VPS Mapeamento em 2026-10-10. Oito testes unitários passaram. Validação de navegador com Playwright e API/WebSocket simulados cobriu desktop (1440 px), celular (390 px), identificação, envio com confirmação, menus de setores, link de documento, erro de upload, histórico, cancelamento da confirmação, encerramento, novo atendimento e abertura/fechamento do widget no portal. Conferência visual por capturas; sem erros JavaScript nem rolagem horizontal no celular. `node --check` e `git diff --check` também passaram.

### Publicação e verificação

- Deploy executado com `app/deploy/deploy.sh`; `webchat_app` com 2/2 réplicas e `webchat_postgres` com 1/1.
- `/health` respondeu HTTP 200 com `ok: true`.
- `/chat` e `/widget.js` responderam HTTP 200 com SHA-256 idêntico aos arquivos locais em quatro leituras de cada rota.
- Formulário e faculdades reais carregados no navegador em desktop e celular, sem erros JavaScript ou rolagem horizontal. Não foram criados atendimentos nem enviadas mensagens reais nessa verificação visual.
- Imagem anterior preservada como `rhino-webchat:pre-redesign-20261010`. Rollback: `docker service update --image rhino-webchat:pre-redesign-20261010 --force webchat_app`; conferir convergência das réplicas e `/health` após executar.
