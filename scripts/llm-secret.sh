#!/bin/sh
set -eu
NAMESPACE=${1:-urumi-platform}
if [ -z "${LLM_API_KEY:-}" ] && [ -f .env ]; then
  LLM_API_KEY=$(sed -n 's/^LLM_API_KEY=//p' .env | tail -1)
fi
if [ -z "${LLM_API_KEY:-}" ]; then
  echo "LLM_API_KEY not set (env or .env); chat will report that the LLM is not configured" >&2
  exit 0
fi
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
printf '%s' "$LLM_API_KEY" | kubectl create secret generic llm-credentials -n "$NAMESPACE" \
  --from-file=api-key=/dev/stdin --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "secret llm-credentials applied in $NAMESPACE"
