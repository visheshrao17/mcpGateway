# Urumi MCP Gateway – Production Deployment Guide

This document covers the complete end-to-end setup for deploying the Urumi MCP Gateway on an AWS EC2 instance running K3s, using GitHub Actions for CI/CD.

---

## Architecture Overview

```
GitHub Actions (CI/CD)
        │
        │  SSH + SCP
        ▼
AWS EC2 (K3s)
 ├── urumi-platform namespace
 │    ├── gateway (Deployment × 2)
 │    └── postgres (StatefulSet)
 ├── urumi-store namespace
 │    ├── wordpress (Deployment)
 │    └── mariadb (StatefulSet)
 └── urumi-mcp namespace
      ├── woo-mcp
      ├── notes-mcp
      └── fx-mcp
```

**Image registry**: GitHub Container Registry (`ghcr.io`)  
**Helm chart**: `charts/urumi` (single monorepo chart, all namespaces)  
**Secrets**: auto-generated on first install, persisted via `helm.sh/resource-policy: keep`

---

## Step 1 – Provision the EC2 Instance

| Setting | Recommended |
|---------|-------------|
| AMI | Ubuntu 24.04 LTS |
| Instance type | `t3.medium` (2 vCPU, 4 GB) minimum; `t3.large` for prod |
| Storage | 30 GB gp3 root volume |
| Security group | TCP 22 (your IP), TCP 80, TCP 443 |
| Key pair | Create or use existing; save the `.pem` file |

> [!IMPORTANT]
> Assign an **Elastic IP** so the address doesn't change across reboots.

---

## Step 2 – Run the One-Time EC2 Bootstrap

SSH into the instance and run:

```bash
# Clone the repo (or scp just the scripts/ folder)
git clone https://github.com/<your-org>/mcpGateway.git
cd mcpGateway

chmod +x scripts/ec2-bootstrap.sh
./scripts/ec2-bootstrap.sh
```

The script will prompt you for:
- **GitHub username/org** – used for the GHCR image pull secret
- **GitHub PAT** – with `read:packages` scope (create at *Settings → Developer settings → Personal access tokens*)
- **LLM API key** – your OpenRouter or OpenAI key (optional, can be added later)

It installs: **K3s → Helm → Traefik → cert-manager → namespaces → secrets**.

At the end, it prints your EC2 public IP and the `ssh-keyscan` command you need for GitHub Secrets.

---

## Step 3 – Configure values-prod.yaml on EC2

```bash
mkdir -p ~/urumi-mcp-gateway/values
cp values/values-prod.example.yaml ~/urumi-mcp-gateway/values/values-prod.yaml
nano ~/urumi-mcp-gateway/values/values-prod.yaml
```

Key fields to update:

```yaml
domain: your-domain.com         # or <IP>.sslip.io for no-DNS testing
hosts:
  store: store                  # → store.your-domain.com
  app: app                      # → app.your-domain.com
gateway:
  adminEmail: you@example.com
llm:
  model: nvidia/nemotron-3-super-120b-a12b:free   # or gpt-4o-mini etc.
  existingSecret: llm-api-key   # name of the k8s secret created by bootstrap
```

> [!NOTE]
> For a quick no-DNS test, set `domain: <EC2-PUBLIC-IP>.sslip.io` and `tls.enabled: false`.  
> `*.sslip.io` resolves to the embedded IP automatically.

---

## Step 4 – Configure GitHub Repository Secrets

Go to: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value | How to get it |
|-------------|-------|---------------|
| `EC2_HOST` | EC2 public IP or hostname | Shown by `ec2-bootstrap.sh` |
| `EC2_USER` | `ubuntu` (or your AMI's default user) | Default for Ubuntu AMIs |
| `EC2_SSH_KEY` | Contents of your EC2 `.pem` private key file | `cat ~/.ssh/your-key.pem` |
| `EC2_SSH_KNOWN_HOSTS` | SSH fingerprint of the EC2 host | `ssh-keyscan -H <EC2_HOST>` |

### Generating `EC2_SSH_KNOWN_HOSTS`

Run this **from your local machine** (not the EC2 instance):

```bash
ssh-keyscan -H <YOUR_EC2_PUBLIC_IP>
```

Copy the full output (all lines) and paste as the secret value.

### Generating `EC2_SSH_KEY`

```bash
cat /path/to/your-keypair.pem
```

Copy the entire file contents including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`.

---

## Step 5 – Configure the GitHub Actions Environment

Go to: **GitHub repo → Settings → Environments → New environment**

1. Name it `production`
2. (Optional) Add **Required reviewers** to gate deploys
3. (Optional) Add **Deployment branches** rule: only `main`

---

## Step 6 – Set Up GHCR Package Visibility

After the first pipeline run creates the image:

1. Go to **GitHub → Packages → urumi-app**
2. Click **Package settings**
3. Under **Manage Actions access**, add your repository with **Write** role

Or pre-create the package as **public** to avoid the pull secret requirement.

---

## Pipeline Reference

### Trigger

```
git push origin main
```

Or manually via **Actions → CI/CD Pipeline → Run workflow**.

### Stages

```
validate-and-test
    │  npm ci + typecheck + npm test + helm lint
    ▼
build-and-publish
    │  docker buildx → ghcr.io/<org>/urumi-app:<sha> + :latest
    ▼
deploy-to-ec2
    │  scp charts/ + scripts/ → EC2
    └─ ssh → ec2-deploy.sh → helm upgrade --install + health checks
```

### Skip tests (hotfix deploy)

Use the `workflow_dispatch` manual trigger and check **Skip testing stage**.

---

## Rollback

Automatic rollback is built into `scripts/ec2-deploy.sh`. If `helm upgrade` or any health check fails, the script runs:

```bash
helm rollback urumi <prev-revision> -n urumi-platform --wait --timeout 5m
```

### Manual rollback

```bash
# On the EC2 instance:
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
helm history urumi -n urumi-platform
helm rollback urumi <revision> -n urumi-platform
```

---

## Useful Commands on EC2

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# All pods
kubectl get pods -A -l app.kubernetes.io/part-of=urumi

# Gateway logs
kubectl logs -n urumi-platform deployment/gateway -f

# Helm release history
helm history urumi -n urumi-platform

# Check ingress
kubectl get ingress -A

# Check TLS certificate status
kubectl get certificate -A
```

---

## Secrets Management

All application secrets (DB passwords, API tokens, encryption keys) are **auto-generated** by the Helm chart on first install and stored in `urumi-generated` Kubernetes Secret with `helm.sh/resource-policy: keep`.

On every `helm upgrade`, the chart reads back the existing secret values so **passwords are never rotated automatically**. To rotate a specific credential:

```bash
# Delete the key from the secret, then re-run helm upgrade
kubectl patch secret urumi-generated -n urumi-platform \
  --type=json -p='[{"op":"remove","path":"/data/postgres-password"}]'
helm upgrade urumi charts/urumi -n urumi-platform -f values/values-prod.yaml
```

> [!CAUTION]
> Rotating `master-key` will invalidate all encrypted MCP server credentials stored in PostgreSQL. You will need to re-register all upstream servers from the dashboard.

---

## Updating the LLM API Key

```bash
kubectl create secret generic llm-api-key \
  --from-literal=api-key=<NEW_KEY> \
  -n urumi-platform \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/gateway -n urumi-platform
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Pipeline fails at SSH step | Verify `EC2_SSH_KEY`, `EC2_HOST`, `EC2_SSH_KNOWN_HOSTS` secrets |
| `helm upgrade` fails with "context deadline exceeded" | EC2 is too small; try `t3.large`. Also check `kubectl describe pod` |
| Gateway pod `CrashLoopBackOff` | `kubectl logs -n urumi-platform deployment/gateway` — usually a bad `DATABASE_URL` or missing secret |
| WordPress shows "Error establishing a database connection" | MariaDB not ready; `kubectl rollout status statefulset/mariadb -n urumi-store` |
| TLS cert stuck in `False` state | Ensure port 80 is open in EC2 Security Group; check `kubectl describe certificaterequest -A` |
| Image pull error `unauthorized` | The GHCR package may be private; add the `ghcr-pull-secret` imagePullSecret or make package public |
