# Passagem do projeto para a equipe da RJ Global

**Data:** 2026-10-30

O Rhino Webchat foi desenvolvido por Tiago Lau e doado ao grupo RJ Global sob a [licença MIT](../LICENSE). Este documento reúne o que a equipe de desenvolvimento precisa para assumir o código e a operação. A decisão está registrada na [ADR 013](decisions/013-doacao-codigo-rj-global.md).

## O que está sendo entregue

- **Código completo:** backend, widget, migrations, testes, deploy e gerador de automações do DataCrazy.
- **Documentação:** este guia, o [README](../README.md), [deploy e operação](deploy.md), [como ligar uma faculdade](faculdade-nova.md), [instalação no Eduno](instalacao-widget-eduno.md), referências do [Eduno](eduno-estrutura.md) e da [Conexão Universal](datacrazy-conexao-universal.md), e 13 ADRs em [`decisions/`](decisions/).
- **Histórico completo no git:** cada decisão tem ADR e commit.

Comece por um **fork** para a organização da RJ Global no GitHub e desenvolva nele. O repositório original fica como referência. A branch `main` é exatamente o que está em produção, mais esta documentação.

## Estado em 2026-10-30

- **Produção de transição:** `https://webchat.engrenatec.com.br`, na VPS do Tiago (Docker Swarm, 2 réplicas + Postgres 16). Continua no ar até a RJ Global migrar e depois será desligada.
- **Uma faculdade cadastrada, de teste:** `iguacu` → conexão "Webchat Iguaçu (teste)" (instância `6aca6a619ab27fb81a32e33e`), com `fluxo_nativo`, `texto_estruturado` e `menus_crm` ligados e `confirmar_encerramento` desligado.
- **Validado de ponta a ponta** com um aluno real no portal `ava07.eduno.com.br`: texto e arquivo nos dois sentidos, tempo real entre réplicas e vínculo ao lead existente pelo CPF.
- **O widget ainda não está no template do Eduno.** Nos testes foi injetado à mão no navegador ([userscript](../ferramentas/webchat-eduno.user.js)). A página `/chat` funciona sozinha.
- **Anexos dos alunos** vão para o CDN do DataCrazy (`ANEXOS_NO_CRM=true`). O histórico local tem retenção de 72 horas.
- **Testes:** 17 unitários e 3 de integração passando em 2026-10-30 (ver [README](../README.md#testes)).

## O que não está no repositório

| Item | Onde está hoje | O que fazer |
|---|---|---|
| Segredos da aplicação: `SESSION_SECRET`, `CPF_PEPPER`, `CPF_ENC_KEY`, `ADMIN_API_KEY`, `POSTGRES_PASSWORD` | `.env.production` do Tiago e `/root/stacks/webchat.env` na VPS | Gerar novos (caminho A) ou receber os atuais por canal seguro (caminho B) |
| Chave REST do DataCrazy (`DATACRAZY_API_TOKEN`) | Painel do DataCrazy da RJ Global | Usar uma chave da RJ Global. Veja o aviso abaixo |
| `api_key` e `webhook_secret` de cada faculdade | Tabela `faculdades` e credenciais de cada Conexão Universal | Vêm junto no caminho B; no caminho A, gerar de novo ([faculdade-nova.md](faculdade-nova.md)) |
| Automações geradas (`datacrazy/gerado/`) | Máquina do Tiago e já importadas no DataCrazy | Regerar com `--url` do novo domínio. Elas levam a `api_key`, por isso ficam fora do git |
| Acesso à VPS e chave SSH | Tiago | Não se transfere: a RJ Global usa a própria infraestrutura |

> ⚠️ **Chave REST do DataCrazy:** confira no painel se gerar uma chave nova **revoga a anterior**. Isso acontece em pelo menos um tenant DataCrazy, e a chave atual pode estar em uso por outras integrações da RJ Global. Coordene a troca para não derrubar nada.

## Dois caminhos para assumir

### Caminho A: começar do zero (recomendado)

Como só a faculdade de teste está ligada e o histórico local dura 72 horas, recomeçar perde pouco:

- **Perde-se** o histórico local das últimas 72 horas (a conversa continua no DataCrazy) e o `contactId` dos alunos já atendidos. Com outro `CPF_PEPPER`, o mesmo aluno ganha um `contactId` novo e o DataCrazy o trata como contato novo da conexão. O **lead continua o mesmo**, porque o vínculo é pelo CPF.
- **Passos:** gerar segredos novos, fazer o [deploy](deploy.md) no domínio da RJ Global e [ligar as faculdades](faculdade-nova.md). Na Iguaçu de teste, troque a URL Base da conexão "Webchat Iguaçu (teste)" e a `api_key`/segredo dela, ou crie a conexão definitiva direto.

### Caminho B: migrar a instalação atual

Preserva `contactId`, histórico recente, faculdades e vínculos. Ordem sugerida:

1. **Repasse dos segredos.** O Tiago envia o `.env.production` por um canal seguro, como um cofre de senhas compartilhado ou arquivo cifrado; nunca e-mail ou WhatsApp em texto. `CPF_PEPPER` e `CPF_ENC_KEY` precisam ser **idênticos**. Com outro `SESSION_SECRET`, os alunos só abrem uma sessão nova.
2. **Subir a instalação nova** no domínio da RJ Global, sem tráfego ainda.
3. **Congelar a antiga:** `docker service scale webchat_app=0` na VPS do Tiago.
4. **Dump e restauração:**

   ```bash
   # VPS antiga
   docker exec $(docker ps -qf name=webchat_postgres) pg_dump -U webchat -Fc webchat > webchat.dump
   # servidor novo, com a stack no ar e o app em 0 réplicas
   docker exec -i $(docker ps -qf name=webchat_postgres) pg_restore -U webchat -d webchat --clean --if-exists < webchat.dump
   docker service scale webchat_app=2
   ```

   Antes, confira em `/admin/status` que `arquivos.locais` é 0. Se não for, copie também o volume `webchat_files`.
5. **Apontar o DataCrazy para o domínio novo**, em cada faculdade:
   - Conexão Universal → aba Envio → **URL Base**;
   - automação **"Webchat <faculdade>: atendimento finalizado"**: URL do bloco HTTP (`/dc/<slug>/evento`). Regenere com `--url` ou edite à mão;
   - qualquer outra automação com bloco HTTP apontando para `webchat.engrenatec.com.br`.
6. **Testar** com o [roteiro da faculdade nova](faculdade-nova.md#6-testar).
7. **Desligar a antiga.** O Tiago remove a stack, os volumes, os backups e as cópias locais do `.env.production`.

**Links antigos de anexo:** as mensagens já enviadas ao DataCrazy têm links `https://webchat.engrenatec.com.br/f/<token>/<nome>`. Quando o domínio antigo sair do ar, esses links deixam de abrir, mas os arquivos continuam nos **anexos do lead** (CDN do DataCrazy). Se fizer falta, o domínio antigo pode redirecionar `/f/*` para o novo por um tempo.

### Depois da virada, nos dois caminhos

Troque as credenciais a que o Tiago teve acesso: a chave REST do DataCrazy usada na transição, a `api_key` e o `webhook_secret` de cada faculdade (painel e `POST /admin/faculdades`), além de `ADMIN_API_KEY` e `POSTGRES_PASSWORD`. `CPF_PEPPER` e `CPF_ENC_KEY` não podem ser trocados sem recalcular o banco. No caminho B, eles continuam os mesmos.

## Pendências conhecidas

Em ordem de prioridade:

1. **Conexões definitivas por faculdade:** Iguaçu, Facuvale, Faculeste, Educaminas e FAME. Passo a passo em [faculdade-nova.md](faculdade-nova.md). O gerador de automações foi validado só com o fluxo da Iguaçu; em outra faculdade, revise os pontos de coleta de identidade que ele marca.
2. **Homologar o ciclo completo do boas-vindas original** no webchat: menus, esperas, encerramento e reinício. Situação e roteiro em [compatibilidade-boas-vindas-iguacu.md](compatibilidade-boas-vindas-iguacu.md).
3. **Backup periódico** do Postgres. Hoje só há dumps manuais ([deploy.md](deploy.md#backup)).
4. **Distribuição:** incluir a linha do widget no template do Eduno ([instalacao-widget-eduno.md](instalacao-widget-eduno.md)), o que depende da HotSystems, e/ou divulgar a página `/chat`.
5. **Limpar os testes** depois da Iguaçu definitiva: conexão "Webchat Iguaçu (teste)" e suas automações (boas-vindas, roteador legado, atendimento finalizado, POCs desativadas), lead "Aluno Teste Webchat" (`eb6b57c3-fb5f-4af1-bfb4-d92d44e6d28d`) e a tag "Teste Webchat" (`507ad07e-130c-4aa9-908e-64eba143a0d6`), se não for mais usada.

Ideias levantadas e não priorizadas: painel administrativo web (hoje só a API `/admin`) e horário de atendimento com mensagem fora do horário no widget.

## Riscos a acompanhar

- **Rota interna de upload do DataCrazy.** Os anexos usam a rota que o próprio painel usa (`crm.g1.datacrazy.io/api/crm/files/upload/...`), sem contrato público de cotas ou retenção. Se mudar, desligue `ANEXOS_NO_CRM`: os anexos voltam a ficar no volume local, e os links `/f/` continuam funcionando ([ADR 011](decisions/011-anexos-no-cdn-datacrazy.md)).
- **Limite da REST do DataCrazy:** 30 req/min por tenant, dividido com as outras integrações da RJ Global ([deploy.md](deploy.md#escala)).
- **Mudanças no portal Eduno.** O widget depende de `window.eduno.aluno` e do texto de `#hot-footer` ([eduno-estrutura.md](eduno-estrutura.md)). Sem o objeto do aluno, o widget não aparece. Se o rodapé mudar, o aluno tem de escolher a faculdade numa lista. Em nenhum dos casos a página do portal quebra.
