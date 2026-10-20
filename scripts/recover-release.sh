#!/usr/bin/env bash
# ==============================================================================
# recover-release.sh - Diagnostic & Safe State-Aware Recovery for Stuck Helm Releases
# ==============================================================================
# This script diagnoses and safely recovers a Helm release stuck in
# "pending-install" or "pending-upgrade" WITHOUT deleting persistent data,
# PVCs, database secrets, or running workloads.
#
# Usage:
#   ./scripts/recover-release.sh [release-name] [namespace]
# ==============================================================================
set -euo pipefail

RELEASE_NAME="${1:-urumi}"
NAMESPACE="${2:-urumi-platform}"

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
sudo chmod 644 "${KUBECONFIG}" 2>/dev/null || true

# Resolve kubectl and helm binaries
KUBECTL_BIN=""
if [ -x /usr/local/bin/kubectl ]; then KUBECTL_BIN="/usr/local/bin/kubectl"
elif command -v kubectl &>/dev/null; then KUBECTL_BIN="$(command -v kubectl)"
elif command -v k3s &>/dev/null; then KUBECTL_BIN="$(command -v k3s) kubectl"
elif [ -x /usr/local/bin/k3s ]; then KUBECTL_BIN="/usr/local/bin/k3s kubectl"
else KUBECTL_BIN="kubectl"
fi

if ${KUBECTL_BIN} --kubeconfig="${KUBECONFIG}" cluster-info > /dev/null 2>&1; then
  KUBECTL="${KUBECTL_BIN} --kubeconfig=${KUBECONFIG}"
elif sudo ${KUBECTL_BIN} --kubeconfig="${KUBECONFIG}" cluster-info > /dev/null 2>&1; then
  KUBECTL="sudo ${KUBECTL_BIN} --kubeconfig=${KUBECONFIG}"
else
  KUBECTL="sudo kubectl --kubeconfig=${KUBECONFIG}"
fi

HELM_BIN=""
if [ -x /usr/local/bin/helm ]; then HELM_BIN="/usr/local/bin/helm"
elif command -v helm &>/dev/null; then HELM_BIN="$(command -v helm)"
elif sudo which helm &>/dev/null; then HELM_BIN="$(sudo which helm)"
elif [ -x /snap/bin/helm ]; then HELM_BIN="/snap/bin/helm"
else HELM_BIN="helm"
fi

if ${HELM_BIN} --kubeconfig="${KUBECONFIG}" version > /dev/null 2>&1; then
  HELM="${HELM_BIN} --kubeconfig=${KUBECONFIG}"
elif sudo ${HELM_BIN} --kubeconfig="${KUBECONFIG}" version > /dev/null 2>&1; then
  HELM="sudo ${HELM_BIN} --kubeconfig=${KUBECONFIG}"
else
  HELM="${HELM_BIN} --kubeconfig=${KUBECONFIG}"
fi

echo "================================================================================"
echo "Helm Release Diagnostic & Recovery Tool"
echo "Release: ${RELEASE_NAME} | Namespace: ${NAMESPACE}"
echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%SZ')"
echo "================================================================================"

# ── 1. Check whether the original helm process is still running ──────────────
echo ""
echo "[Step 1] Checking for active Helm processes..."
ACTIVE_PIDS=$(pgrep -f "helm.*${RELEASE_NAME}" 2>/dev/null || true)
if [ -n "${ACTIVE_PIDS}" ]; then
  echo "WARNING: Active Helm process(es) detected:"
  ps -fp ${ACTIVE_PIDS} || true
  echo "If an active process is making progress, do NOT terminate it."
else
  echo "Confirmed: No active Helm process is running for '${RELEASE_NAME}'."
fi

# ── 2. Inspect Helm storage Secrets and release metadata ─────────────────────
echo ""
echo "[Step 2] Inspecting Helm release storage Secrets..."
${KUBECTL} get secrets -n "${NAMESPACE}" -l "owner=helm,name=${RELEASE_NAME}" -o wide || true

LATEST_SECRET=$(${KUBECTL} get secrets -n "${NAMESPACE}" -l "owner=helm,name=${RELEASE_NAME}" \
  --sort-by='.metadata.creationTimestamp' -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null || true)

SECRET_STATUS=""
SECRET_VERSION=""
if [ -n "${LATEST_SECRET}" ]; then
  SECRET_STATUS=$(${KUBECTL} get secret "${LATEST_SECRET}" -n "${NAMESPACE}" -o jsonpath='{.metadata.labels.status}' 2>/dev/null || true)
  SECRET_VERSION=$(${KUBECTL} get secret "${LATEST_SECRET}" -n "${NAMESPACE}" -o jsonpath='{.metadata.labels.version}' 2>/dev/null || true)
  echo "Latest Secret: ${LATEST_SECRET} (version: ${SECRET_VERSION}, status label: ${SECRET_STATUS})"

  # Decode release object payload
  RAW_RELEASE=$(${KUBECTL} get secret "${LATEST_SECRET}" -n "${NAMESPACE}" -o jsonpath='{.data.release}' 2>/dev/null || true)
  if [ -n "${RAW_RELEASE}" ]; then
    DECODED_INFO=$(python3 -c "
import base64, gzip, json, sys
try:
  raw = sys.stdin.read().strip()
  decompressed = gzip.decompress(base64.b64decode(base64.b64decode(raw)))
  obj = json.loads(decompressed.decode('utf-8'))
  info = obj.get('info', {})
  print(json.dumps({
    'status': info.get('status'),
    'description': info.get('description'),
    'first_deployed': info.get('first_deployed'),
    'last_deployed': info.get('last_deployed'),
    'manifest_bytes': len(obj.get('manifest', ''))
  }, indent=2))
except Exception as e:
  print(f'Error decoding release: {e}', file=sys.stderr)
" <<< "${RAW_RELEASE}" 2>/dev/null || true)
    if [ -n "${DECODED_INFO}" ]; then
      echo "Decoded Release Payload Info:"
      echo "${DECODED_INFO}"
    fi
  fi
else
  echo "No Helm secret found for release '${RELEASE_NAME}' in namespace '${NAMESPACE}'."
fi

# ── 3. Check Helm release history and hooks ──────────────────────────────────
echo ""
echo "[Step 3] Checking Helm release history..."
${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" || echo "Unable to query helm history (release may be pending lock)."

# ── 4. Verify cluster workload and application health ────────────────────────
echo ""
echo "[Step 4] Checking cluster workloads across all namespaces..."
echo "--- Namespace: ${NAMESPACE} ---"
${KUBECTL} get pods,svc,pvc,jobs -n "${NAMESPACE}" -l app.kubernetes.io/part-of=urumi || true

STORE_NS="urumi-store"
echo "--- Namespace: ${STORE_NS} ---"
${KUBECTL} get pods,svc,pvc,jobs -n "${STORE_NS}" || true

MCP_NS="urumi-mcp"
echo "--- Namespace: ${MCP_NS} ---"
${KUBECTL} get pods,svc,pvc,jobs -n "${MCP_NS}" || true

# Check gateway readiness
GATEWAY_READY=$(${KUBECTL} get deployment gateway -n "${NAMESPACE}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
POSTGRES_READY=$(${KUBECTL} get statefulset postgres -n "${NAMESPACE}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
echo ""
echo "Gateway Ready Replicas: ${GATEWAY_READY:-0}"
echo "Postgres Ready Replicas: ${POSTGRES_READY:-0}"

# ── 5. Safe State-Aware Recovery ─────────────────────────────────────────────
echo ""
echo "[Step 5] Evaluating recovery requirements..."

if [ -n "${ACTIVE_PIDS}" ]; then
  echo "Active Helm process is still running. Will not modify state while process is active."
  exit 0
fi

if [ "${SECRET_STATUS}" = "pending-install" ] || [ "${SECRET_STATUS}" = "pending-upgrade" ]; then
  echo "Release is stuck in '${SECRET_STATUS}' and no active process is running."
  
  # If primary workloads are running and healthy, mark the release as deployed
  if [ "${GATEWAY_READY:-0}" -ge 1 ] && [ "${POSTGRES_READY:-0}" -ge 1 ]; then
    echo "Primary workloads (Gateway and Postgres) are verified healthy!"
    echo "Initiating state-aware transition: ${SECRET_STATUS} -> deployed"
    
    # Use Python to safely update both outer label and inner release payload
    UPDATE_SUCCESS=$(python3 -c "
import base64, gzip, json, sys

raw = sys.stdin.read().strip()
try:
  decompressed = gzip.decompress(base64.b64decode(base64.b64decode(raw)))
  obj = json.loads(decompressed.decode('utf-8'))
  obj['info']['status'] = 'deployed'
  obj['info']['description'] = 'Install complete (recovered from interrupted wait)'
  new_bytes = gzip.compress(json.dumps(obj).encode('utf-8'))
  new_b64 = base64.b64encode(base64.b64encode(new_bytes)).decode('ascii')
  print(new_b64)
except Exception as e:
  print(f'Failed: {e}', file=sys.stderr)
  sys.exit(1)
" <<< "${RAW_RELEASE}" 2>/dev/null || true)

    if [ -n "${UPDATE_SUCCESS}" ]; then
      ${KUBECTL} patch secret "${LATEST_SECRET}" -n "${NAMESPACE}" \
        --type=merge \
        -p "{\"metadata\":{\"labels\":{\"status\":\"deployed\"}},\"data\":{\"release\":\"${UPDATE_SUCCESS}\"}}"
      echo "Successfully updated Helm Secret '${LATEST_SECRET}' to status 'deployed'."
    else
      # Fallback: patch the label so helm allows subsequent operations
      ${KUBECTL} patch secret "${LATEST_SECRET}" -n "${NAMESPACE}" \
        --type=merge \
        -p "{\"metadata\":{\"labels\":{\"status\":\"deployed\"}}}"
      echo "Patched Helm Secret label to 'deployed'."
    fi
  else
    echo "Workloads are not fully ready. Setting status to 'failed' so Helm allows upgrade retry..."
    ${KUBECTL} patch secret "${LATEST_SECRET}" -n "${NAMESPACE}" \
      --type=merge \
      -p "{\"metadata\":{\"labels\":{\"status\":\"failed\"}}}"
  fi
else
  echo "Release status is '${SECRET_STATUS:-none}'. No recovery intervention required."
fi

# ── 6. Verification ──────────────────────────────────────────────────────────
echo ""
echo "[Step 6] Verifying final release status..."
${HELM} status "${RELEASE_NAME}" -n "${NAMESPACE}"

# Verify gateway HTTP health check
GATEWAY_IP=$(${KUBECTL} get svc gateway -n "${NAMESPACE}" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
if [ -n "${GATEWAY_IP}" ]; then
  echo "Testing Gateway HTTP /healthz on ${GATEWAY_IP}..."
  if curl -sSf --max-time 10 "http://${GATEWAY_IP}/healthz" > /dev/null 2>&1; then
    echo "Gateway /healthz responded HTTP 200 OK."
  else
    echo "Warning: Could not connect to Gateway /healthz directly."
  fi
fi

echo "================================================================================"
echo "Diagnostic & Recovery Completed."
echo "================================================================================"
