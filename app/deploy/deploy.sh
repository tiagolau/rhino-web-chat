#!/usr/bin/env bash
# Deploy do Rhino Webchat num servidor Docker Swarm com Traefik.
# Uso: app/deploy/deploy.sh            (a partir de qualquer pasta)
#
# Lê app/deploy/.env.production (não versionado; modelo em app/.env.example).
# Envia o código para /root/apps/webchat, o env para /root/stacks/webchat.env
# (permissão 600), constrói a imagem no servidor e atualiza a stack.
#
# Acesso SSH, no ambiente ou no próprio .env.production:
#   WEBCHAT_SSH_HOST  destino, ex.: root@203.0.113.10 (obrigatório)
#   WEBCHAT_SSH_KEY   caminho da chave privada (opcional; sem ela, usa o ssh-agent/~/.ssh/config)
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$AQUI/.." && pwd)"
ENV_LOCAL="$AQUI/.env.production"

[ -f "$ENV_LOCAL" ] || { echo "falta $ENV_LOCAL (copie de app/.env.example)"; exit 1; }
set -a; . "$ENV_LOCAL"; set +a

HOST="${WEBCHAT_SSH_HOST:?defina WEBCHAT_SSH_HOST no ambiente ou em $ENV_LOCAL}"
: "${WEBCHAT_DOMAIN:?defina WEBCHAT_DOMAIN em $ENV_LOCAL}"
: "${TRAEFIK_NETWORK:?defina TRAEFIK_NETWORK em $ENV_LOCAL}"

OPCOES_SSH=(-o ConnectTimeout=20 -o ServerAliveInterval=15)
[ -n "${WEBCHAT_SSH_KEY:-}" ] && OPCOES_SSH=(-i "$WEBCHAT_SSH_KEY" "${OPCOES_SSH[@]}")
SSH=(ssh "${OPCOES_SSH[@]}" "$HOST")
RSYNC_SSH="ssh"
[ -n "${WEBCHAT_SSH_KEY:-}" ] && RSYNC_SSH="ssh -i \"$WEBCHAT_SSH_KEY\""

echo "==> enviando código"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude node_modules --exclude .env --exclude data --exclude 'deploy/.env*' \
  "$APP/" "$HOST:/root/apps/webchat/"

echo "==> enviando stack e env"
"${SSH[@]}" "mkdir -p /root/stacks"
scp -q "${OPCOES_SSH[@]}" "$AQUI/stack.yml" "$HOST:/root/stacks/webchat.yaml"
scp -q "${OPCOES_SSH[@]}" "$ENV_LOCAL" "$HOST:/root/stacks/webchat.env"
"${SSH[@]}" "chmod 600 /root/stacks/webchat.env"

echo "==> build e deploy"
"${SSH[@]}" bash -s <<'REMOTO'
set -euo pipefail
cd /root/apps/webchat
install -m 700 deploy/limpar-backups.sh /usr/local/sbin/webchat-limpar-backups
printf '%s\n' '* * * * * root /usr/local/sbin/webchat-limpar-backups' > /etc/cron.d/webchat-retencao-backups
chmod 644 /etc/cron.d/webchat-retencao-backups
docker build -q -t rhino-webchat:latest . >/dev/null
set -a; . /root/stacks/webchat.env; set +a
docker stack deploy -c /root/stacks/webchat.yaml webchat >/dev/null
# Força as réplicas a pegarem a imagem recém-construída (mesma tag :latest).
docker service update --force --quiet webchat_app >/dev/null 2>&1 || true
docker service ls --filter name=webchat_ --format '{{.Name}} {{.Replicas}}'
REMOTO

echo "==> pronto. Saúde: curl -s https://$WEBCHAT_DOMAIN/health"
