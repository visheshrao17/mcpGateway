# Demo video script

Target length is 15 to 20 minutes. The sections follow the six areas the brief asks the video to cover. Commands assume the repo root and a deployed local cluster (`make up`).

Before recording:

```sh
make clean && make up              # fresh cluster, proves install from scratch
SKIP_CHAT=0 node scripts/dod-test.ts   # every step "ok", then reset the browser profiles
```

Open these windows:

- **Browser profile A:** dashboard as admin (user A).
- **Browser profile B:** dashboard as member (user B), after accepting an invite.
- **Storefront** in a private window.
- **Terminal 1** for `kubectl`.
- **Terminal 2** with Claude Code or MCP Inspector for user B.

## 1. System design and implementation (3 min)

1. Show the README diagram. Name the four layers: store, woo-mcp, gateway + dashboard, chat agent. State the rule: nothing but the gateway talks to an upstream.
2. Open `apps/gateway/src/calltool.ts`. This is the single function both `/mcp` and the chat agent go through: re-authorize, write a pending audit row, call the upstream with its own credential, finalize the row.
3. **Definition of done, live.**
   - **Storefront:** add the Urumi Mug to the cart, check out with COD. In wp-admin, open WooCommerce > Orders and show the new order.
   - **User A, chat:** "Create a product called Demo Lamp priced 799." Point at the `woo__create_product` chip. Refresh the storefront and show the product.
   - **Storefront:** order the Demo Lamp by hand.
   - **User A, chat:** "What orders came in today?" The reply includes the new order number, and the chip shows `woo__list_orders` with `period: today`.
   - **User B, Claude Code:**
     ```sh
     claude mcp add --transport http urumi http://app.localtest.me/mcp --header "Authorization: Bearer <B's key>"
     claude   # then /mcp to show the tool list: woo__*, notes__*, fx__* and no woo__create_product
     ```
     Ask "What orders came in today?", then "What's today's order total in EUR? Save it as a team note." That's three tools across three upstreams.
   - **Control.**
     - Revoke B's key in the dashboard (profile B, API keys). Ask Claude Code anything that uses a tool. It now gets 401.
     - As A, disable **Currency rates**. The `fx__*` tools disappear from the chat agent's next answer and from Inspector/Claude Code after re-listing (2026 clients get `list_changed` pushed). Re-enable it.
     - Kill a pod: `kubectl delete pod -n urumi-mcp -l app=notes-mcp` (or `kubectl scale deploy/notes-mcp -n urumi-mcp --replicas=0` to keep it down). Within 15 s the Servers page shows Notes **Unreachable** with "connection refused". A woo question in chat still works. Scale it back.
   - **Audit log:** filter by user B, then by user A. Show source `mcp` against `chat`, durations, and the `denied` and `unreachable` rows.

## 2. Kubernetes (3 min)

```sh
kubectl get ns urumi-store urumi-mcp urumi-platform
kubectl get pods,svc,ingress,pvc -n urumi-store
kubectl get pods,svc,pvc -n urumi-mcp           # no Ingress here
kubectl get pods,svc,ingress,pvc,secrets -n urumi-platform
kubectl get deploy gateway -n urumi-platform -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}{.spec.template.spec.containers[0].readinessProbe}{"\n"}'
kubectl get networkpolicy -A
```

Prove the internal-only rule is enforced, not just declared:

```sh
# a random pod cannot reach woo-mcp (times out, prints 000)
kubectl run probe --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://woo-mcp.urumi-mcp.svc.cluster.local:8000/healthz
# the gateway can (200)
kubectl exec -n urumi-platform deploy/gateway -- node -e "fetch('http://woo-mcp.urumi-mcp.svc.cluster.local:8000/healthz').then(r=>console.log(r.status))"
# woo-mcp cannot reach MariaDB, only WordPress
kubectl exec -n urumi-mcp deploy/woo-mcp -- node -e "require('net').connect(3306,'mariadb.urumi-store.svc.cluster.local').on('error',e=>console.log(e.code)).on('connect',()=>console.log('CONNECTED'))"
```

Explain persistence:

- WordPress is on a PVC and MariaDB on a StatefulSet volume claim. `kubectl delete pod -n urumi-store -l app=wordpress` and the order from step 1 is still there.
- Postgres keeps users, keys and the audit log.

## 3. MCP internals (3 min)

1. Trace one call: Claude Code, then Traefik, then gateway `/mcp` (key hash lookup), then `tools/call woo__list_orders`, then exact-map lookup to (`woo`, `list_orders`), then `callTool`, then the SDK client with woo-mcp's bearer token, then woo-mcp, then a signed `GET /wp-json/wc/v3/orders` to the WordPress Service, then MariaDB, and back.
2. Show `apps/woo-mcp/src/oauth.ts`: why OAuth 1.0a over in-cluster HTTP, and why the signature uses the public host.
3. Name collisions: `apps/gateway/src/naming.ts`. Slug prefix, a 64-character limit with a hash suffix, and routing by exact map.
4. Timeouts and dead upstreams: the background refresh writes snapshots, listing never touches the network, and calls have a 20 s timeout. A timed-out write is `unknown` and is never retried. Point at the `unreachable` row from section 1.
5. Protocol: spec 2026-07-28, stateless, so any replica can serve any request, with fallback to 2025 clients. Optionally add `https://mcp.deepwiki.com/mcp` live in the dashboard to show a third-party 2025-era server connecting.

## 4. Security posture (3 min)

- **Keys:** a SHA-256 hash in Postgres (`select prefix, key_hash from api_keys`), shown once, revoked for the next request.
- **Upstream credentials:** AES-256-GCM. The Servers page only says "credential set", and the API never returns one.
- **What a member can and can't do:**
  - Log in as B: no Members page, no add-server button, no `woo__create_product`.
  - Call `woo__create_product` directly from Inspector: refused and audited `denied`.
- **A malicious server:** open THREAT_MODEL section 3.
  - Slug prefix stops impersonation, and tool output is treated as data.
  - Write tools are gated, and NetworkPolicy blocks it from reaching other pods.
  - SSRF: try adding `http://169.254.169.254/latest` and `http://127.0.0.1:8080/mcp` in the dashboard. Both are rejected with `url_rejected`.

## 5. Chat agent (2 min)

Open `apps/gateway/src/chat.ts`:

- **The loop:** model, then tool calls, then `callTool(user, 'chat', ...)`, then results cut to 8,000 characters, then back to the model. At most 8 steps.
- **Identity:** the session cookie sets the user. The same permission filter as MCP clients applies, so members' chat can't see admin-only tools. The audit row shows `source = chat` under that user.
- **Model:** OpenRouter free model, set in values (`llm.model`), with the key from the `llm-credentials` Secret.

## 6. Local to VPS (2 min)

```sh
diff values/values-local.yaml values/values-prod.example.yaml
```

Walk through:

- domain and DNS;
- `tls.enabled` + cert-manager issuer;
- storage class and sizes;
- registry image with a pinned tag;
- gateway replicas 2, safe because MCP is stateless and replicas sync through Postgres LISTEN/NOTIFY;
- secrets (generated by the chart and kept with `lookup`; External Secrets for teams).

Upgrade and rollback live:

```sh
helm upgrade urumi charts/urumi -n urumi-platform -f values/values-local.yaml --set image.tag=does-not-exist --wait --timeout 60s   # fails
kubectl get pods -n urumi-platform    # old gateway still Running and serving
helm history urumi -n urumi-platform
helm rollback urumi <last good revision> -n urumi-platform --wait
```
