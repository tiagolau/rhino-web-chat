# Deploy e operação

O webchat é um único serviço Node (2 réplicas) e um Postgres. Não há Redis, fila externa nem worker separado: as réplicas se coordenam pelo próprio Postgres (fila com `SKIP LOCKED` e `LISTEN/NOTIFY`). O volume esperado é de ~100 alunos/hora ([ADR 002](decisions/002-arquitetura-producao-escala.md)).

## Requisitos do servidor

O caminho pronto no repositório é **Docker Swarm com Traefik**:

- Docker em modo Swarm, com **um nó**. As duas réplicas compartilham o volume `webchat_files`, e a stack fixa os serviços no manager. Em um cluster com vários nós, use armazenamento compartilhado ou uma réplica só.
- Traefik já rodando no Swarm, com uma rede overlay externa (`TRAEFIK_NETWORK`), um entrypoint HTTPS (`TRAEFIK_ENTRYPOINT`, padrão `websecure`) e um certresolver (`TRAEFIK_CERTRESOLVER`, padrão `letsencryptresolver`).
- Um domínio (`WEBCHAT_DOMAIN`) apontando para o servidor.
- Acesso SSH como root a partir da máquina que faz o deploy, com `rsync` instalado nos dois lados.

**Sem Swarm:** a aplicação é um `node src/server.js` comum (Node 22 + Postgres 16). Funciona atrás de qualquer proxy HTTPS **com suporte a WebSocket** em `/ws`. Se usar Docker Compose, mova as labels do Traefik de `deploy.labels` para `labels` do serviço. HTTPS é obrigatório: o portal Eduno é HTTPS e o navegador bloqueia `ws://` em página segura.

## Primeiro deploy

1. Crie o arquivo de ambiente de produção (não versionado):

   ```bash
   cp app/.env.example app/deploy/.env.production
   chmod 600 app/deploy/.env.production
   ```

2. Preencha:

   | Variável | Valor |
   |---|---|
   | `PUBLIC_URL` | `https://<WEBCHAT_DOMAIN>` |
   | `SESSION_SECRET`, `CPF_PEPPER`, `ADMIN_API_KEY`, `POSTGRES_PASSWORD` | `openssl rand -hex 32` (cada um diferente) |
   | `CPF_ENC_KEY` | `openssl rand -hex 32` (precisa ter exatamente 64 caracteres hex) |
   | `DATACRAZY_API_TOKEN` | chave REST do tenant RJ Global no DataCrazy |
   | `ALLOWED_ORIGINS` | origens dos portais que vão carregar o widget, ex.: `https://ava07.eduno.com.br` |
   | `ANEXOS_NO_CRM` | `true` para mandar os anexos dos alunos ao CDN do DataCrazy ([ADR 011](decisions/011-anexos-no-cdn-datacrazy.md)) |
   | `WEBCHAT_DOMAIN`, `TRAEFIK_NETWORK`, `TRAEFIK_CERTRESOLVER` | roteamento no Traefik |
   | `WEBCHAT_SSH_HOST`, `WEBCHAT_SSH_KEY` | destino e chave do SSH (a chave é opcional com `ssh-agent`) |

   > ⚠️ `CPF_PEPPER` e `CPF_ENC_KEY` **não podem mudar** depois que houver alunos no banco. O pepper gera o `contactId` do aluno no DataCrazy e o hash de busca; a chave decifra o CPF guardado. Guarde os dois num cofre de senhas.

   As demais variáveis estão comentadas no [`app/.env.example`](../app/.env.example) e na seção [Configuração](../README.md#configuração) do README.

3. Rode:

   ```bash
   app/deploy/deploy.sh
   ```

   O script envia o código para `/root/apps/webchat`, o env para `/root/stacks/webchat.env` (permissão 600), instala o cron de retenção dos backups, constrói a imagem `rhino-webchat:latest` **no servidor** e aplica a stack `webchat`. As migrations rodam sozinhas na subida (`src/migrations/`, com advisory lock para as duas réplicas não concorrerem).

4. Confira:

   ```bash
   curl -s https://<WEBCHAT_DOMAIN>/health
   curl -s https://<WEBCHAT_DOMAIN>/admin/status -H "X-Admin-Key: <ADMIN_API_KEY>"
   node app/scripts/e2e.mjs https://<WEBCHAT_DOMAIN>   # só depois de cadastrar a faculdade de teste
   ```

5. Cadastre as faculdades: [faculdade-nova.md](faculdade-nova.md).

> O `deploy.sh` envia a **pasta local**, não o que está no GitHub. Confira a branch antes de publicar.

## Deploys seguintes

Mesmo comando: `app/deploy/deploy.sh`. A stack usa `start-first` com uma réplica por vez e `failure_action: rollback`, então não há queda.

Para guardar a versão anterior e poder voltar sem rebuild:

```bash
# no servidor, antes do deploy
docker tag rhino-webchat:latest rhino-webchat:anterior
# para voltar
docker service update --image rhino-webchat:anterior webchat_app
```

Migrations são sempre aditivas. Nunca edite uma migration já aplicada: crie `NNN_nome.sql` novo. Voltar o código não desfaz migration; confira a ADR da mudança antes de um rollback (a [ADR 011](decisions/011-anexos-no-cdn-datacrazy.md), por exemplo, exige manter a rota `/f/`).

## Operação

### Saúde e status

| Rota | Autenticação | Para quê |
|---|---|---|
| `GET /health` | nenhuma | Liveness, usado pelo `HEALTHCHECK` da imagem |
| `GET /admin/status` | `X-Admin-Key` | Jobs por tipo e status, alunos por situação do lead, mensagens das últimas 24h, anexos locais e pendentes, atraso da retenção, últimos 20 erros |
| `GET /admin/faculdades` | `X-Admin-Key` | Faculdades cadastradas (sem segredos) |
| `POST /admin/faculdades` | `X-Admin-Key` | Cria ou atualiza uma faculdade ([faculdade-nova.md](faculdade-nova.md)) |

O que olhar no `/admin/status`:

- `errosRecentes`: jobs que esgotaram as tentativas. Erros de DataCrazy costumam ser limite da REST (30 req/min por tenant, divididos com as outras integrações da RJ Global) ou conexão mal configurada.
- `arquivos.locaisMaisDe72h`: anexos que ainda não chegaram ao CDN. **Não apague por idade**: só saem do volume depois de verificados ([ADR 011](decisions/011-anexos-no-cdn-datacrazy.md)).
- `retencao.mensagensExpiradasAguardandoLimpeza`: deve ficar perto de zero; a limpeza roda a cada minuto ([ADR 012](decisions/012-retencao-historico-72-horas.md)).

### Logs

```bash
docker service logs -f --since 10m webchat_app
```

Os logs nunca contêm CPF. Erros do lado do DataCrazy só aparecem na aba **Logs** da Conexão Universal no painel, que guarda 1 hora: o webhook responde 200 mesmo quando rejeita a mensagem.

### Backup

Ainda **não há rotina automática de backup** (está nas pendências da [passagem](passagem-rj-global.md)). Faça dumps antes de mudanças grandes:

```bash
mkdir -p /root/backups/webchat
docker exec $(docker ps -qf name=webchat_postgres) pg_dump -U webchat -Fc webchat \
  > /root/backups/webchat/webchat-$(date +%Y%m%d-%H%M).dump
```

O cron `webchat-retencao-backups`, instalado pelo `deploy.sh`, **apaga tudo em `/root/backups/webchat` com mais de 72 horas**, coerente com a retenção do histórico ([ADR 012](decisions/012-retencao-historico-72-horas.md)). Para um backup que precise durar mais, grave em outro lugar e avalie a LGPD: o banco tem nome, e-mail, celular e o CPF cifrado dos alunos.

Com `ANEXOS_NO_CRM=true`, o volume `webchat_files` fica normalmente vazio. Se `/admin/status` mostrar arquivos locais, inclua o volume no backup.

### Conexões do Postgres

O serviço `postgres` usa `endpoint_mode: dnsrr` de propósito. O VIP do Swarm derruba em silêncio conexões ociosas por ~15 minutos, e isso já matou o `LISTEN` em produção. Não remova; o `pg` também usa keepalive e o ouvinte tem batimento de 30 s.

### Escala

O limite prático é a REST do DataCrazy (30 req/min por tenant), não o servidor. Cada réplica usa no máximo `DC_REST_PER_MINUTE` (padrão 10). Ao aumentar réplicas, reduza esse valor para o total continuar abaixo do limite do tenant.
