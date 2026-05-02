#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/ghcr-pull.sealed.yaml"
NAMESPACE="sandbox"

read -srp "GitHub PAT: " PAT
echo
[[ -z "$PAT" ]] && { echo "empty token, abort" >&2; exit 1; }

kubectl create secret docker-registry ghcr-pull \
  --namespace "$NAMESPACE" \
  --docker-server=ghcr.io \
  --docker-username=sdin99 \
  --docker-password="$PAT" \
  --dry-run=client -o yaml | \
kubeseal \
  --controller-namespace kube-system \
  --controller-name sealed-secrets-controller \
  --format yaml \
  > "$OUT"

unset PAT
echo "wrote $OUT"
