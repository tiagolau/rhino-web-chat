#!/usr/bin/env bash
# Retenção dos snapshots do webchat na VPS; não percorre outros projetos.
set -euo pipefail
PASTA="${1:-/root/backups/webchat}"
[ -d "$PASTA" ] || exit 0
find "$PASTA" -type f -mmin +4320 -delete
find "$PASTA" -mindepth 1 -depth -type d -empty -delete
