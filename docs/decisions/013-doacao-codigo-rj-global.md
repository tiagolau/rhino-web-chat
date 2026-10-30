# 013 — Doação do código ao grupo RJ Global

**Data:** 2026-10-30
**Status:** aceito

## Contexto

Tiago decidiu não explorar o webchat comercialmente e doar o código à equipe de desenvolvimento do grupo RJ Global, que passa a evoluir e operar o projeto. Até aqui o repositório era privado no perfil `tiagolau` e tinha marcas da operação do Tiago:

- a `main` parava na ADR 004; o que roda em produção estava na `feat/anexos-crm`;
- `deploy.sh` e `stack.yml` tinham IP da VPS, caminho da chave SSH, domínio `webchat.engrenatec.com.br` e rede `Mapeamento` fixos;
- scripts de teste, gerador de automações e userscript usavam o domínio de produção como padrão;
- o `CLAUDE.md` estava escrito para o Tiago e citava arquivos da máquina dele;
- não havia licença nem guia de passagem.

## Decisão

- **Licença MIT**, com copyright de Tiago Lau: a RJ Global pode usar, modificar e redistribuir sem obrigação além de manter o aviso.
- **Repositório público** no GitHub, para a equipe fazer fork na organização dela sem depender da conta do Tiago. No GitHub, um fork privado é apagado se o acesso for removido ou o repositório original apagado.
- **`main` = produção:** merge da `feat/anexos-crm` (que contém `feat/compatibilidade-boas-vindas` e `feat/redesign-webchat`) e remoção das branches incorporadas.
- **Infraestrutura por variável de ambiente:** `WEBCHAT_DOMAIN`, `TRAEFIK_NETWORK`, `TRAEFIK_CERTRESOLVER`, `TRAEFIK_ENTRYPOINT`, `WEBCHAT_SSH_HOST` e `WEBCHAT_SSH_KEY`. O `deploy.sh` lê do `.env.production`. A renderização da stack com o env da produção atual ficou idêntica à anterior. Scripts de conversa usam `http://localhost:3000` por padrão; o gerador exige `--url`.
- **Documentação para quem assume:** README reescrito, [deploy e operação](../deploy.md), [passagem](../passagem-rj-global.md) com dois caminhos de migração e pendências, `CLAUDE.md`/`AGENTS.md` neutros para agentes de código. O guia do widget e o de faculdade nova não citam mais o domínio do Tiago.
- **Produção de transição:** `webchat.engrenatec.com.br` segue na VPS do Tiago até a RJ Global migrar.

### Varredura antes de publicar

Todos os commits de todas as branches foram varridos atrás de tokens (JWT, `dc_`, chaves de API, chaves privadas), senhas, CPFs, telefones, e-mails e nomes de pessoas. Nenhum segredo jamais foi commitado: `.env`, `.env.production` e `datacrazy/gerado/` sempre estiveram no `.gitignore`. O que fica público:

- IDs do tenant RJ Global, de instâncias, do lead e da tag de teste. São identificadores, não credenciais; toda chamada exige a chave REST.
- O CPF de teste `529.982.247-25`, válido por algoritmo e fictício, e dados de aluno fictício com e-mails `example.com`.
- IP da VPS do Tiago e o caminho da chave SSH em versões antigas do `deploy.sh`. O IP já é público pelo DNS.
- Um telefone usado em teste unitário, sem nome associado, que não aparece em nenhum outro lugar; substituído por um fictício nesta versão.
- Detalhes da integração com o DataCrazy, inclusive a rota interna de upload (ADR 011).

## Alternativas Consideradas

- **Transferir o repositório para a organização da RJ Global:** daria a posse direta, mas exige conhecer a organização e ter permissão de criação nela. Público + fork resolve sem coordenação.
- **Manter privado e convidar os desenvolvedores para fazer fork:** o fork privado depende do acesso ao original e some se ele for apagado. Tiago não quer manter o repositório.
- **Cessão exclusiva à RJ Global, sem licença aberta:** exigiria texto jurídico próprio, e o repositório público ficaria em situação ambígua. A MIT é curta e conhecida.
- **Reescrever o histórico (`git filter-repo`) antes de publicar:** não havia segredo para remover. Reescrever mudaria todos os hashes citados nas ADRs e evidências.

## Consequências

- Qualquer pessoa pode ler e forkar o código, inclusive concorrentes. A segurança depende das chaves (HMAC por faculdade, `X-Api-Key`, `X-Admin-Key`, token assinado do navegador), não de o código ser secreto.
- O histórico completo, com as ADRs e evidências de homologação, vai junto e explica cada escolha.
- Até a migração, a produção continua sob responsabilidade do Tiago. Depois da virada, a RJ Global troca as credenciais a que ele teve acesso ([passagem](../passagem-rj-global.md#depois-da-virada-nos-dois-caminhos)).
- As ADRs 001 a 012 são registros históricos e continuam citando a VPS Mapeamento e o domínio de transição. O estado vigente está no README, no `CLAUDE.md` e na passagem.
