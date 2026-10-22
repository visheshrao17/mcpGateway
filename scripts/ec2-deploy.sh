#!/usr/bin/env bash
# ==============================================================================
# ec2-deploy.sh - Automated Deployment and Rollback for K3s on EC2
# ==============================================================================
set -euo pipefail

IMAGE_REPOSITORY="${1:-}"
IMAGE_TAG="${2:-}"
RELEASE_NAME="${3:-urumi}"
NAMESPACE="${4:-urumi-platform}"
VALUES_FILE="${5:-values/values-prod.yaml}"

if [ -z "$IMAGE_REPOSITORY" ] || [ -z "$IMAGE_TAG" ]; then
  echo "Usage: $0 <image-repository> <image-tag> [release-name] [namespace] [values-file]" >&2
  exit 1
fi

echo "================================================================================"
echo "Starting deployment of ${RELEASE_NAME} (${IMAGE_REPOSITORY}:${IMAGE_TAG})"
echo "Target namespace: ${NAMESPACE}"
echo "Values file: ${VALUES_FILE}"
echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%SZ')"
echo "================================================================================"

# K3s kubeconfig is root-owned (-rw------- root root).
# Configure the K3s kubeconfig path explicitly.
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
K3S_KUBECONFIG="${KUBECONFIG}"

# Ensure kubeconfig is readable by the deploy user
sudo chmod 644 "${K3S_KUBECONFIG}" 2>/dev/null || true

# Resolve kubectl binary
KUBECTL_BIN=""
if [ -x /usr/local/bin/kubectl ]; then
  KUBECTL_BIN="/usr/local/bin/kubectl"
elif command -v kubectl &>/dev/null; then
  KUBECTL_BIN="$(command -v kubectl)"
elif command -v k3s &>/dev/null; then
  KUBECTL_BIN="$(command -v k3s) kubectl"
elif [ -x /usr/local/bin/k3s ]; then
  KUBECTL_BIN="/usr/local/bin/k3s kubectl"
else
  KUBECTL_BIN="kubectl"
fi

if ${KUBECTL_BIN} --kubeconfig="${K3S_KUBECONFIG}" cluster-info > /dev/null 2>&1; then
  KUBECTL="${KUBECTL_BIN} --kubeconfig=${K3S_KUBECONFIG}"
elif sudo ${KUBECTL_BIN} --kubeconfig="${K3S_KUBECONFIG}" cluster-info > /dev/null 2>&1; then
  KUBECTL="sudo ${KUBECTL_BIN} --kubeconfig=${K3S_KUBECONFIG}"
else
  KUBECTL="sudo kubectl --kubeconfig=${K3S_KUBECONFIG}"
fi

# Resolve Helm binary (auto-install Helm 3 if not present on system)
if ! command -v helm &>/dev/null && ! sudo which helm &>/dev/null && [ ! -x /usr/local/bin/helm ]; then
  echo "Helm CLI not found on system. Installing Helm 3..."
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash
fi

HELM_BIN=""
if [ -x /usr/local/bin/helm ]; then
  HELM_BIN="/usr/local/bin/helm"
elif command -v helm &>/dev/null; then
  HELM_BIN="$(command -v helm)"
elif sudo which helm &>/dev/null; then
  HELM_BIN="$(sudo which helm)"
elif [ -x /snap/bin/helm ]; then
  HELM_BIN="/snap/bin/helm"
else
  HELM_BIN="helm"
fi

if ${HELM_BIN} --kubeconfig="${K3S_KUBECONFIG}" version > /dev/null 2>&1; then
  HELM="${HELM_BIN} --kubeconfig=${K3S_KUBECONFIG}"
elif sudo ${HELM_BIN} --kubeconfig="${K3S_KUBECONFIG}" version > /dev/null 2>&1; then
  HELM="sudo ${HELM_BIN} --kubeconfig=${K3S_KUBECONFIG}"
else
  HELM="${HELM_BIN} --kubeconfig=${K3S_KUBECONFIG}"
fi

# 1. Verify cluster access and Helm functionality
if ! ${KUBECTL} cluster-info > /dev/null 2>&1; then
  echo "Error: Cannot connect to Kubernetes cluster via kubectl. Check KUBECONFIG (${K3S_KUBECONFIG})." >&2
  exit 1
fi

if ! ${HELM} version > /dev/null 2>&1; then
  echo "Error: Helm is not operational (${HELM}). Check Helm installation." >&2
  exit 1
fi

# 2. Record previous known-good revision for safe rollback
# ONLY select revisions that actually reached 'deployed' or 'superseded' state.
# Never rollback to a 'failed' or 'pending' revision.
PREV_REVISION=""
if ${HELM} status "${RELEASE_NAME}" -n "${NAMESPACE}" > /dev/null 2>&1; then
  CURRENT_STATUS=$(${HELM} status "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | jq -r '.info.status // empty' 2>/dev/null || true)
  LATEST_REV=$(${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | jq -r '.[-1].revision // empty' 2>/dev/null || true)
  PREV_REVISION=$(${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | \
    jq -r '[.[] | select(.status == "deployed" or .status == "superseded")] | .[-1].revision // empty' 2>/dev/null || true)
  echo "Current Helm release: ${RELEASE_NAME} (status: ${CURRENT_STATUS:-unknown}, latest revision: ${LATEST_REV:-none}, last known-good revision: ${PREV_REVISION:-none})"

  # Auto-recover if previous release was interrupted in pending state
  if [ "${CURRENT_STATUS}" = "pending-install" ] || [ "${CURRENT_STATUS}" = "pending-upgrade" ]; then
    echo "Warning: Release '${RELEASE_NAME}' is locked in '${CURRENT_STATUS}' state."
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${SCRIPT_DIR}/recover-release.sh" ]; then
      echo "Invoking recover-release.sh to resolve stuck state safely..."
      bash "${SCRIPT_DIR}/recover-release.sh" "${RELEASE_NAME}" "${NAMESPACE}"
      PREV_REVISION=$(${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | \
        jq -r '[.[] | select(.status == "deployed" or .status == "superseded")] | .[-1].revision // empty' 2>/dev/null || true)
    fi
  fi
else
  echo "Release ${RELEASE_NAME} not found; performing initial install."
fi

# 3. Ensure a valid production values file exists
if [ ! -f "${VALUES_FILE}" ]; then
  echo "Values file '${VALUES_FILE}' not found."
  if [ -f values/values-prod.example.yaml ]; then
    echo "Bootstrapping '${VALUES_FILE}' from 'values/values-prod.example.yaml'..."
    cp values/values-prod.example.yaml "${VALUES_FILE}"
    # If on an EC2 instance, derive public IP for sslip.io if available
    PUBLIC_IP=$(curl -s --connect-timeout 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')
    if [ -n "${PUBLIC_IP}" ]; then
      sed -i.bak "s/shop.example.com/${PUBLIC_IP}.sslip.io/g" "${VALUES_FILE}"
      sed -i.bak "s/enabled: true/enabled: false/g" "${VALUES_FILE}"
      rm -f "${VALUES_FILE}.bak"
      echo "Configured domain: ${PUBLIC_IP}.sslip.io (TLS disabled for initial setup)"
    fi
  else
    echo "Error: Cannot find '${VALUES_FILE}' or fallback template." >&2
    exit 1
  fi
fi

# 4. Comprehensive diagnostics collector
gather_diagnostics() {
  echo "================================================================================"
  echo "=== DETAILED DEPLOYMENT FAILURE DIAGNOSTICS ==="
  echo "================================================================================"
  echo ""
  echo "--- 1. All Pods across Application Namespaces ---"
  ${KUBECTL} get pods -A -o wide 2>/dev/null | grep -E "urumi|NAMESPACE" || true

  echo ""
  echo "--- 2. Batch Jobs Status ---"
  ${KUBECTL} get jobs -A -o wide 2>/dev/null | grep -E "urumi|NAMESPACE" || true

  echo ""
  echo "--- 3. PVCs and Storage Bindings ---"
  ${KUBECTL} get pvc -A -o wide 2>/dev/null | grep -E "urumi|NAMESPACE" || true

  echo ""
  echo "--- 4. Ingress and Services ---"
  ${KUBECTL} get svc,ingress -A 2>/dev/null | grep -E "urumi|NAMESPACE" || true

  echo ""
  echo "--- 5. Recent Warning and Error Events (last 15m) ---"
  for ns in "${NAMESPACE}" urumi-store urumi-mcp; do
    echo ">> Events in namespace: ${ns} <<"
    ${KUBECTL} get events -n "${ns}" --sort-by='.metadata.creationTimestamp' 2>/dev/null | tail -n 25 || true
  done

  echo ""
  echo "--- 6. Container Logs for Non-Running Pods ---"
  for ns in "${NAMESPACE}" urumi-store urumi-mcp; do
    BAD_PODS=$(${KUBECTL} get pods -n "${ns}" --no-headers 2>/dev/null | awk '$3 !~ /Running|Completed/ {print $1}' || true)
    for p in ${BAD_PODS}; do
      echo ">> Pod state and logs: ${ns}/${p} <<"
      ${KUBECTL} describe pod -n "${ns}" "${p}" 2>/dev/null | grep -E "State:|Reason:|Message:|Exit Code:" || true
      ${KUBECTL} logs -n "${ns}" "${p}" --tail=50 --all-containers 2>/dev/null || true
    done
  done

  # Inspect store-bootstrap job pod logs specifically if present
  JOB_POD=$(${KUBECTL} get pods -n urumi-store -l app=store-bootstrap --no-headers 2>/dev/null | awk '{print $1}' | tail -n 1 || true)
  if [ -n "${JOB_POD}" ]; then
    echo ">> Logs for store-bootstrap job pod (urumi-store/${JOB_POD}) <<"
    ${KUBECTL} logs -n urumi-store "${JOB_POD}" --tail=60 2>/dev/null || true
  fi

  echo ""
  echo "--- 7. Helm Release Status and History ---"
  ${HELM} status "${RELEASE_NAME}" -n "${NAMESPACE}" 2>/dev/null || true
  ${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" 2>/dev/null || true
  echo "================================================================================"
}

# 5. History-aware rollback helper function
rollback_on_failure() {
  local exit_code=$?
  echo "--------------------------------------------------------------------------------"
  echo "Deployment step failed with exit code ${exit_code}."
  gather_diagnostics

  if [ -n "${PREV_REVISION}" ]; then
    echo "Initiating safe Helm rollback to last known-good revision ${PREV_REVISION}..."
    if ${HELM} rollback "${RELEASE_NAME}" "${PREV_REVISION}" -n "${NAMESPACE}" --wait --timeout 5m; then
      echo "Successfully rolled back to known-good revision ${PREV_REVISION}."
    else
      echo "Rollback to revision ${PREV_REVISION} failed. Manual operator intervention required." >&2
    fi
  else
    echo "No previously successful (deployed/superseded) release revision exists."
    echo "Skipping rollback to avoid re-triggering a known-failed initial revision."
  fi
  echo "--------------------------------------------------------------------------------"
  exit "${exit_code}"
}
trap rollback_on_failure ERR

# 6. Execute Helm Upgrade / Install
# Using --wait to ensure all core Deployments and StatefulSets are fully Ready.
echo "Executing helm upgrade --install..."
${HELM} upgrade --install "${RELEASE_NAME}" charts/urumi \
  -n "${NAMESPACE}" --create-namespace \
  -f "${VALUES_FILE}" \
  --set image.repository="${IMAGE_REPOSITORY}" \
  --set image.tag="${IMAGE_TAG}" \
  --wait \
  --timeout 10m

# 7. Verify Core Application Deployment Health across all namespaces
echo "Verifying application pod health..."
${KUBECTL} rollout status deployment/gateway -n urumi-platform --timeout=3m
${KUBECTL} rollout status deployment/woo-mcp -n urumi-mcp --timeout=3m
${KUBECTL} rollout status deployment/notes-mcp -n urumi-mcp --timeout=3m
${KUBECTL} rollout status deployment/fx-mcp -n urumi-mcp --timeout=3m
${KUBECTL} rollout status deployment/wordpress -n urumi-store --timeout=3m

# 8. Check Store Bootstrap Job status
echo "Checking store bootstrap job in urumi-store..."
if ${KUBECTL} get job -l app.kubernetes.io/part-of=urumi -n urumi-store > /dev/null 2>&1; then
  echo "Waiting up to 3m for store bootstrap job to complete..."
  ${KUBECTL} wait --for=condition=complete job -l app.kubernetes.io/part-of=urumi -n urumi-store --timeout=3m || {
    echo "Warning: Store bootstrap job is still running or pending. Gathering job logs:"
    ${KUBECTL} logs -n urumi-store -l app=store-bootstrap --tail=40 2>/dev/null || true
  }
fi

# 9. Check Ingress and HTTP endpoints
echo "Checking HTTP health endpoint..."
GATEWAY_IP=$(${KUBECTL} get svc gateway -n urumi-platform -o jsonpath='{.spec.clusterIP}')
if [ -n "${GATEWAY_IP}" ]; then
  # Gateway cluster IP port 80 maps to targetPort 8080
  curl -sSf --max-time 10 "http://${GATEWAY_IP}/healthz" > /dev/null
  echo "Gateway /healthz responded with OK (HTTP 200)."
fi

# Clear trap on success
trap - ERR

echo "================================================================================"
echo "Deployment of ${RELEASE_NAME} (${IMAGE_TAG}) COMPLETED SUCCESSFULLY."
echo "Active Pods:"
${KUBECTL} get pods -A -l app.kubernetes.io/part-of=urumi
echo "================================================================================"
