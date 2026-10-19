# Urumi MCP Gateway

A WooCommerce store on Kubernetes, plus a team MCP gateway on top of it. An admin registers MCP servers once in a dashboard. Every team member then uses all of them through one MCP endpoint, with their own API key, or through a chat agent in the dashboard. Everything runs from one Helm chart, locally on k3d and on a k3s VPS. Only the values file changes.

```
 shopper ──► store.<domain> ──► WordPress + WooCommerce ──► MariaDB          (namespace urumi-store)
                                      ▲ REST v3, OAuth 1.0a signed
 team    ──► app.<domain>   ──► gateway ──► woo-mcp · notes-mcp · fx-mcp     (namespace urumi-mcp, no Ingress)
 Claude Code / Cursor ─► /mcp     │  dashboard, /api, /mcp, chat agent       (namespace urumi-platform)
                                  └► Postgres: users, keys, servers, audit
```

| Component | Path | What it does |
|---|---|---|
| Store | `charts/urumi/templates/store*.yaml` | WordPress 7.0 + WooCommerce, MariaDB, idempotent WP-CLI bootstrap Job |
| woo-mcp | `apps/woo-mcp` | My own MCP server: `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` |
| notes-mcp | `apps/notes-mcp` | Team notes. Bearer-protected, to show the gateway injecting upstream credentials |
| fx-mcp | `apps/fx-mcp` | Currency conversion with ECB reference rates |
| Gateway | `apps/gateway` | Dashboard API, aggregated `/mcp` endpoint, chat agent, audit log |
| Dashboard | `apps/dashboard` | React app served by the gateway |
| Chart | `charts/urumi`, `values/` | One umbrella chart; `values-local.yaml` and `values-prod.example.yaml` |

Further reading: [design and tradeoffs](docs/DESIGN.md), [threat model](docs/THREAT_MODEL.md), [HTTP API](docs/API.md), [demo script](docs/DEMO.md).

## Local setup

Requirements: Docker (Docker Desktop, OrbStack or Colima), `k3d`, `kubectl`, `helm` 3.14+ or 4, Node 22.18+ (only for tests and the acceptance script), and about 4 CPU and 6 GB RAM for the Docker VM.

```sh
# Colima users only. Docker Desktop and OrbStack already provide a VM.
colima start --cpu 4 --memory 8

# Optional: enables the chat agent. The key never leaves .env and the cluster Secret.
echo 'LLM_API_KEY=sk-or-...' > .env      # OpenRouter key, free models work

make up        # k3d cluster + image build/import + LLM secret + helm upgrade --install (waits for the store bootstrap Job)
make redeploy  # after code changes: new uniquely tagged image, rolled out by helm
make status    # every pod should be Running, the store-bootstrap Job Completed
make seed      # optional: demo products, orders over 5 days, members, keys, extra servers, audit history
```

The first install takes 3 to 5 minutes, mostly because the bootstrap Job downloads WooCommerce.

### Local domains

`*.localtest.me` is public DNS that resolves to `127.0.0.1`. k3d maps host ports 80 and 443 to the bundled Traefik ingress, so these work with no `/etc/hosts` edits:

- Storefront: http://store.localtest.me
- Dashboard and gateway: http://app.localtest.me (MCP endpoint: http://app.localtest.me/mcp)

If you're offline or your DNS filters `localtest.me`, add `127.0.0.1 store.localtest.me app.localtest.me` to `/etc/hosts`.

### Logins

The chart generates every credential on first install and keeps it across upgrades (see [Secrets](docs/DESIGN.md#secrets)). Read them from the cluster:

```sh
# Dashboard admin (user A). Email is gateway.adminEmail in values (admin@urumi.local by default).
kubectl get secret -n urumi-platform gateway-credentials -o jsonpath='{.data.gateway-admin-password}' | base64 -d; echo

# WordPress admin, at http://store.localtest.me/wp-admin with user "admin"
kubectl get secret -n urumi-platform urumi-generated -o jsonpath='{.data.wp-admin-password}' | base64 -d; echo
```

## Using it

### Place an order

Open http://store.localtest.me, add a product to the cart, check out with **Cash on delivery** (shipping is disabled, so only an address is needed). The order appears in wp-admin under WooCommerce > Orders.

### Invite a member and issue a key

1. In the dashboard (as admin), open **Members**, invite an email as `member`, and open the one-time invite link in another browser profile.
2. As the member, open **API keys**, create a key, and copy it. It's shown once. Only its SHA-256 hash is stored.

### Connect an external MCP client

Only the gateway URL and the member's key are needed. The member never sees an upstream credential.

```sh
# Claude Code
claude mcp add --transport http urumi http://app.localtest.me/mcp --header "Authorization: Bearer mcpg_..."

# MCP Inspector
npx @modelcontextprotocol/inspector   # transport "Streamable HTTP", URL http://app.localtest.me/mcp,
                                      # header Authorization: Bearer mcpg_...
```

Cursor `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "urumi": { "url": "http://app.localtest.me/mcp", "headers": { "Authorization": "Bearer mcpg_..." } } } }
```

Tools show up as `<server>__<tool>`, for example `woo__list_orders` and `fx__convert`. A prompt that needs two servers: *"What's the total of today's orders in EUR? Save it as a team note."*

### Use the chat agent

Open **Chat** in the dashboard and ask *"Create a product called Blue Mug priced 349"* or *"What orders came in today?"*. Each tool call shows up as a chip with its arguments, outcome and duration. The agent acts as the logged-in user, so its calls land in the audit log under that user with source `chat`.

## Acceptance test

`scripts/dod-test.ts` runs the assignment's definition of done against the deployed cluster with two real users. It covers:

- the storefront order
- chat as user A
- an MCP client as user B
- the two-server flow
- admin-only denial
- disable, kill a pod, and revoke
- the audit attribution

```sh
npm install
node scripts/dod-test.ts            # SKIP_CHAT=1 skips the LLM steps; CLAUDE_CLI=1 also drives the real Claude Code CLI as user B
npm test                            # unit + integration tests (gateway tests need Docker for Postgres)
```

## Production-like VPS (k3s)

The chart and templates are the same as local. Only values change.

```sh
# On a VPS with 4 GB+ RAM. Not yet run on a real VPS; the same chart runs on k3s inside k3d locally.
curl -sfL https://get.k3s.io | sh -                         # ships Traefik, local-path storage, NetworkPolicy enforcement
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# TLS (optional): cert-manager + a Let's Encrypt ClusterIssuer named letsencrypt-prod
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef: { name: letsencrypt-prod }
    solvers: [{ http01: { ingress: { ingressClassName: traefik } } }]
EOF

# Image: push to a registry instead of k3d image import
docker build -t ghcr.io/<you>/urumi-app:0.1.0 . && docker push ghcr.io/<you>/urumi-app:0.1.0

cp values/values-prod.example.yaml values/values-prod.yaml   # gitignored; set domain, image, issuer
LLM_API_KEY=... scripts/llm-secret.sh urumi-platform
helm upgrade --install urumi charts/urumi -n urumi-platform --create-namespace -f values/values-prod.yaml --wait --wait-for-jobs --timeout 10m
```

DNS: point `store.<domain>` and `app.<domain>` A records at the VPS. If you have no domain, `domain: <vps-ip>.sslip.io` works without TLS.

What changes between local and production, all through values:

| Concern | `values-local.yaml` | `values-prod.example.yaml` |
|---|---|---|
| Domain | `localtest.me` | your domain or `<ip>.sslip.io` |
| TLS | off | `tls.enabled: true` + cert-manager `clusterIssuer`; cookies become `Secure` |
| Ingress | Traefik (k3d) | Traefik (k3s), same class |
| Storage | `local-path` | `local-path` or a provider class, larger sizes |
| Image | `urumi/app:<timestamp>` built and imported into k3d by `make` | registry image with a pinned tag |
| Replicas | gateway 1 | gateway 2 (stateless MCP, Postgres LISTEN/NOTIFY keeps replicas in sync) |
| Secrets | generated by the chart, LLM key from `.env` | same; for real production, swap in External Secrets or Sealed Secrets |

## Upgrades and rollback

```sh
helm upgrade urumi charts/urumi -n urumi-platform -f values/values-local.yaml --set image.tag=v2 --wait
helm history urumi -n urumi-platform
helm rollback urumi <revision> -n urumi-platform --wait
```

- **App components** (gateway, MCP servers): a rolling update. Readiness probes gate traffic, so a bad tag never takes the old pods down; `helm rollback` restores the previous tag. The gateway schema is additive-only (`CREATE ... IF NOT EXISTS`), so rolling back the gateway image is safe.
- **WordPress**: bump `store.wordpressImage`. The `sync-core` init container copies the new core over the volume, and the bootstrap Job runs `wp core update-db`. Rolling WordPress back after a database upgrade isn't safe, so take a DB dump first (`kubectl exec -n urumi-store mariadb-0 -- mariadb-dump ...`).
- **WooCommerce**: pin `store.woocommerceVersion`. The bootstrap Job installs the pinned version on fresh volumes. Upgrade existing stores from wp-admin or with `wp plugin update`.
- **Credentials** survive upgrades and rollbacks. The chart reads them back with `lookup`, and `urumi-generated` has `helm.sh/resource-policy: keep`.

## Stand-out items attempted

| Item | Where |
|---|---|
| Tool permissions | Per-tool `admin_only` policy. Hidden from members' tool lists and refused (and audited as `denied`) if called directly. Toggle in **Servers**. `apps/gateway/src/calltool.ts`, `SEED_ADMIN_ONLY_TOOLS` |
| Security hardening | SSRF guard at registration and again at connect time (DNS-pinned), default-deny NetworkPolicies (verified enforced, see DEMO), non-root containers with dropped capabilities, upstream credentials AES-256-GCM encrypted at rest. `apps/gateway/src/ssrf.ts`, `crypto.ts`, `charts/urumi/templates/network-policies.yaml` |
| Upgrades and rollback | Section above and the WordPress core sync in `charts/urumi/templates/store.yaml` |
| Scaling (partial) | Gateway runs with 2+ replicas: stateless MCP, no sticky sessions, registry changes propagate with Postgres `LISTEN/NOTIFY` (tested in `apps/gateway/test/replicas.test.ts`). No rate limits. |

The multi-store bonus was not attempted.

## Repository layout

```
apps/            woo-mcp, notes-mcp, fx-mcp, gateway, dashboard
packages/mcp-kit shared Streamable HTTP server setup for the three MCP servers
charts/urumi     the Helm chart; files/store-bootstrap.sh is the WP-CLI script
values/          values-local.yaml, values-prod.example.yaml
scripts/         dod-test.ts, llm-secret.sh
docs/            DESIGN, THREAT_MODEL, API, DEMO
```

Node runs the TypeScript sources directly through built-in type stripping, so the backend has no build step. Only the dashboard is bundled (Vite).
