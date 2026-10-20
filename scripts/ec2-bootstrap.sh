#!/usr/bin/env bash
# ==============================================================================
# ec2-bootstrap.sh – One-time EC2 setup for Urumi MCP Gateway on K3s
# ==============================================================================
# Run once as the "ubuntu" user (or your EC2 user) BEFORE the GitHub Actions
# pipeline runs for the first time.
#
# What this script does:
#   1. Installs K3s with NetworkPolicy support (via --flannel-backend=none + Calico)
#   2. Installs Helm
#   3. Installs cert-manager (for TLS via Let's Encrypt)
#   4. Creates the GHCR image pull secret
#   5. Creates the LLM API key secret
#   6. Prints the known-hosts fingerprint for GitHub Actions
#
# Usage:
#   chmod +x scripts/ec2-bootstrap.sh
#   ./scripts/ec2-bootstrap.sh
#
# Required environment variables (or interactive prompts):
#   GHCR_USER      – your GitHub username / org
#   GHCR_PAT       – GitHub PAT with read:packages scope
#   LLM_API_KEY    – your OpenRouter / OpenAI API key (optional, press Enter to skip)
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Gather required inputs ───────────────────────────────────────────────────
if [ -z "${GHCR_USER:-}" ]; then
  read -rp "GitHub username / org (for GHCR pull secret): " GHCR_USER
fi
if [ -z "${GHCR_PAT:-}" ]; then
  read -rsp "GitHub PAT (read:packages scope): " GHCR_PAT; echo
fi
if [ -z "${LLM_API_KEY:-}" ]; then
  read -rsp "LLM API key (OpenRouter / OpenAI – press Enter to skip): " LLM_API_KEY; echo
fi

NAMESPACE="urumi-platform"
HELM_VERSION="v3.16.2"
CERT_MANAGER_VERSION="v1.16.2"

# ── 1. System packages ───────────────────────────────────────────────────────
info "Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl jq git unzip

# ── 2. K3s ───────────────────────────────────────────────────────────────────
if ! command -v k3s &>/dev/null; then
  info "Installing K3s (with built-in NetworkPolicy support)..."
  # K3s uses kube-router or iptables; for full NetworkPolicy support we keep
  # the default bundled flannel + kube-router which does support NetworkPolicy
  # from K3s v1.27+. If you need Calico instead, uncomment the lines below.
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
    --disable=traefik \
    --disable=servicelb" sh -
  # Re-install Traefik via Helm so we can customise it later:
  #   (K3s ships with Traefik v2 bundled; disabling lets us pin a version)
  sudo systemctl enable --now k3s
  info "Waiting for K3s to be ready..."
  until sudo k3s kubectl get nodes --no-headers 2>/dev/null | grep -q " Ready"; do
    sleep 3
  done
else
  warn "K3s already installed – skipping."
fi

# ── 3. Configure KUBECONFIG for the current user ─────────────────────────────
KUBECONFIG_PATH=/etc/rancher/k3s/k3s.yaml
sudo chmod 644 "${KUBECONFIG_PATH}"
export KUBECONFIG="${KUBECONFIG_PATH}"
echo "export KUBECONFIG=${KUBECONFIG_PATH}" >> ~/.bashrc

# ── 4. Helm ──────────────────────────────────────────────────────────────────
if ! command -v helm &>/dev/null; then
  info "Installing Helm ${HELM_VERSION}..."
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | \
    DESIRED_VERSION="${HELM_VERSION}" bash
else
  warn "Helm already installed ($(helm version --short)) – skipping."
fi

# ── 5. Traefik (reinstall so we can manage it via Helm) ──────────────────────
info "Installing Traefik via Helm..."
helm repo add traefik https://traefik.github.io/charts --force-update
kubectl create namespace traefik --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install traefik traefik/traefik \
  -n traefik \
  --set service.type=LoadBalancer \
  --wait --timeout 5m

# ── 6. cert-manager ──────────────────────────────────────────────────────────
info "Installing cert-manager ${CERT_MANAGER_VERSION}..."
helm repo add jetstack https://charts.jetstack.io --force-update
kubectl create namespace cert-manager --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager \
  --version "${CERT_MANAGER_VERSION}" \
  --set crds.enabled=true \
  --wait --timeout 5m

# Create ClusterIssuer for Let's Encrypt prod
cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: change-me@example.com   # ← update in values-prod.yaml after deploy
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
EOF

# ── 7. Target namespace + GHCR pull secret ───────────────────────────────────
info "Creating namespace ${NAMESPACE} and image pull secret..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace urumi-store     --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace urumi-mcp       --dry-run=client -o yaml | kubectl apply -f -

for NS in "${NAMESPACE}" urumi-store urumi-mcp; do
  kubectl create secret docker-registry ghcr-pull-secret \
    --docker-server=ghcr.io \
    --docker-username="${GHCR_USER}" \
    --docker-password="${GHCR_PAT}" \
    -n "${NS}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

# ── 8. LLM API key secret ────────────────────────────────────────────────────
if [ -n "${LLM_API_KEY}" ]; then
  info "Creating LLM API key secret in ${NAMESPACE}..."
  kubectl create secret generic llm-api-key \
    --from-literal=api-key="${LLM_API_KEY}" \
    -n "${NAMESPACE}" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  warn "No LLM API key provided – skipping. Create it manually later:"
  warn "  kubectl create secret generic llm-api-key --from-literal=api-key=<KEY> -n ${NAMESPACE}"
fi

# ── 9. Print SSH known-hosts fingerprint for GitHub Actions ──────────────────
echo ""
info "=== GitHub Actions SSH setup ==="
PUBLIC_IP=$(curl -s --connect-timeout 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')
info "Your EC2 public IP: ${PUBLIC_IP}"
info "Add this as EC2_HOST GitHub secret: ${PUBLIC_IP}"
echo ""
info "Run this command LOCALLY to generate EC2_SSH_KNOWN_HOSTS:"
echo "  ssh-keyscan -H ${PUBLIC_IP}"
echo ""
info "Verify K3s node status:"
kubectl get nodes -o wide
echo ""
info "Bootstrap complete! Next steps:"
echo "  1. Copy values/values-prod.example.yaml to ~/urumi-mcp-gateway/values/values-prod.yaml on this EC2 instance"
echo "  2. Edit the domain, adminEmail, and other values"
echo "  3. Add GitHub Secrets (see docs/DEPLOYMENT.md)"
echo "  4. Push a commit to 'main' to trigger the pipeline"
