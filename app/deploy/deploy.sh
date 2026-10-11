#!/usr/bin/env bash
# Deploy do Rhino Webchat na VPS Mapeamento.
# Uso: app/deploy/deploy.sh            (a partir de qualquer pasta)
#
# Envia o código para /root/apps/webchat, o env para /root/stacks/webchat.env
# (permissão 600), constrói a imagem no servidor e atualiza a stack.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$AQUI/.." && pwd)"
CHAVE="${WEBCHAT_SSH_KEY:-$HOME/Devs/RhinoCRM/Portainer Tecminas/secrets/vps-tecminas.key}"
HOST="${WEBCHAT_SSH_HOST:-root@173.212.205.156}"
ENV_LOCAL="$AQUI/.env.production"
SSH=(ssh -i "$CHAVE" -o ConnectTimeout=20 -o ServerAliveInterval=15 "$HOST")

[ -f "$ENV_LOCAL" ] || { echo "falta $ENV_LOCAL (copie de app/.env.example)"; exit 1; }

echo "==> enviando código"
rsync -az --delete -e "ssh -i \"$CHAVE\"" \
  --exclude node_modules --exclude .env --exclude data --exclude 'deploy/.env*' \
  "$APP/" "$HOST:/root/apps/webchat/"

echo "==> enviando stack e env"
scp -q -i "$CHAVE" "$AQUI/stack.yml" "$HOST:/root/stacks/webchat.yaml"
scp -q -i "$CHAVE" "$ENV_LOCAL" "$HOST:/root/stacks/webchat.env"
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

echo "==> pronto. Saúde: curl -s https://webchat.engrenatec.com.br/health"
