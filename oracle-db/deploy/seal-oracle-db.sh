#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/oracle-db.sealed.yaml"
NAMESPACE="sandbox"

read -srp "Oracle DB Password: " ORACLE_PWD
echo
[[ -z "$ORACLE_PWD" ]] && { echo "empty password, abort" >&2; exit 1; }

# [A] Oracle DB Secret 암호화
kubectl create secret generic oracle-db-secret \
  --namespace "$NAMESPACE" \
  --from-literal=ORACLE_PWD="$ORACLE_PWD" \
  --dry-run=client -o yaml | \
kubeseal \
  --controller-namespace kube-system \
  --controller-name sealed-secrets-controller \
  --format yaml \
  > "$OUT"

unset ORACLE_PWD
echo "wrote $OUT"
