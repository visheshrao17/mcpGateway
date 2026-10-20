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

# 2. Record previous revision for safe rollback
PREV_REVISION=""
if ${HELM} status "${RELEASE_NAME}" -n "${NAMESPACE}" > /dev/null 2>&1; then
  CURRENT_STATUS=$(${HELM} status "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | jq -r '.info.status // empty' 2>/dev/null || true)
  PREV_REVISION=$(${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | jq -r '.[-1].revision // empty' 2>/dev/null || true)
  echo "Current Helm release: ${RELEASE_NAME} (status: ${CURRENT_STATUS:-unknown}, revision: ${PREV_REVISION:-none})"

  # Auto-recover if previous release was interrupted in pending state
  if [ "${CURRENT_STATUS}" = "pending-install" ] || [ "${CURRENT_STATUS}" = "pending-upgrade" ]; then
    echo "Warning: Release '${RELEASE_NAME}' is locked in '${CURRENT_STATUS}' state."
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${SCRIPT_DIR}/recover-release.sh" ]; then
      echo "Invoking recover-release.sh to resolve stuck state safely..."
      bash "${SCRIPT_DIR}/recover-release.sh" "${RELEASE_NAME}" "${NAMESPACE}"
      PREV_REVISION=$(${HELM} history "${RELEASE_NAME}" -n "${NAMESPACE}" -o json 2>/dev/null | jq -r '.[-1].revision // empty' 2>/dev/null || true)
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

# 4. Rollback helper function
rollback_on_failure() {
  local exit_code=$?
  echo "--------------------------------------------------------------------------------"
  echo "Deployment step failed with exit code ${exit_code}."
  echo "Gathering cluster status..."
  ${KUBECTL} get pods,pvc,ingress -A -l app.kubernetes.io/part-of=urumi || true

  if [ -n "${PREV_REVISION}" ]; then
    echo "Initiating safe Helm rollback to revision ${PREV_REVISION}..."
    if ${HELM} rollback "${RELEASE_NAME}" "${PREV_REVISION}" -n "${NAMESPACE}" --wait --timeout 5m; then
      echo "Successfully rolled back to revision ${PREV_REVISION}."
    else
      echo "Rollback failed. Manual operator intervention required." >&2
    fi
  else
    echo "No previous release revision to rollback to."
  fi
  echo "--------------------------------------------------------------------------------"
  exit "${exit_code}"
}
trap rollback_on_failure ERR

# 5. Execute Helm Upgrade / Install
echo "Executing helm upgrade --install..."
${HELM} upgrade --install "${RELEASE_NAME}" charts/urumi \
  -n "${NAMESPACE}" --create-namespace \
  -f "${VALUES_FILE}" \
  --set image.repository="${IMAGE_REPOSITORY}" \
  --set image.tag="${IMAGE_TAG}" \
  --wait \
  --wait-for-jobs \
  --timeout 10m

# 6. Verify Deployment Health across all namespaces
echo "Verifying application pod health..."
${KUBECTL} rollout status deployment/gateway -n urumi-platform --timeout=2m
${KUBECTL} rollout status deployment/woo-mcp -n urumi-mcp --timeout=2m
${KUBECTL} rollout status deployment/notes-mcp -n urumi-mcp --timeout=2m
${KUBECTL} rollout status deployment/fx-mcp -n urumi-mcp --timeout=2m
${KUBECTL} rollout status deployment/wordpress -n urumi-store --timeout=2m

# 7. Check Ingress and HTTP endpoints
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
