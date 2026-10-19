# System design and tradeoffs

## Components and where they run

| Namespace | Workloads | Exposure |
|---|---|---|
| `urumi-store` | WordPress (Deployment, PVC for `/var/www/html`), MariaDB (StatefulSet, PVC), `store-bootstrap-<revision>` Job | Ingress `store.<domain>` to WordPress only |
| `urumi-mcp` | `woo-mcp`, `notes-mcp` (PVC), `fx-mcp` | No Ingress. ClusterIP Services, and a NetworkPolicy admits only gateway pods |
| `urumi-platform` | `gateway` (Deployment), Postgres (StatefulSet, PVC) | Ingress `app.<domain>` to the gateway |

Every workload has readiness and liveness probes plus requests and limits. WordPress and MariaDB also get startup probes, because the first boot is slow. One container image (`urumi/app`) holds all Node components, and each Deployment picks its entrypoint with `command`. That's one build and one import, and the versions can't drift apart.

## How a tool call travels

1. A client sends `POST https://app.<domain>/mcp` with `Authorization: Bearer mcpg_...`. Traefik forwards it to a gateway pod.
2. The gateway hashes the key with SHA-256 and looks it up, along with its user, on every request. A revoked key or a deactivated user gets HTTP 401 with `WWW-Authenticate: Bearer`. Nothing is cached, so revocation applies to the very next request.
3. `tools/list` is answered from in-memory snapshots of each enabled upstream's tools. It never waits on the network. Admin-only tools are filtered out for members.
4. `tools/call woo__list_orders` looks up the exposed name in an exact map to get (server, original tool). Then `callTool()` (`apps/gateway/src/calltool.ts`) runs in order:
   - re-checks that the user is active, the server enabled, and the policy allows the call;
   - inserts an audit row with outcome `pending`;
   - calls the upstream through that server's own SDK `Client`, with the server's own credential and a 20 s timeout;
   - finalizes the row with duration and outcome.
5. woo-mcp turns "today" into UTC bounds in the store's timezone. It pages through `GET /wp-json/wc/v3/orders`, signing each request with OAuth 1.0a, and returns compact JSON with exact per-currency totals.
6. The upstream's result goes back to the client unchanged (`content`, `structuredContent`, `isError`).

The chat agent (`apps/gateway/src/chat.ts`) enters at step 3. Its identity comes from the dashboard session cookie instead of an API key. It calls the same `callTool()` with `source = chat`. There's no second code path that could skip a permission check or an audit row.

## MCP protocol choices

The gateway and all three servers use the official TypeScript SDK v2, which implements spec revision 2026-07-28. That revision is stateless: no `Mcp-Session-Id`, and every request is a self-contained POST. This has two consequences:

- **Any gateway replica can serve any request.** There are no sticky sessions and nothing in memory to lose when a pod restarts.
- **Older clients still work.** The handler runs with `legacy: 'stateless'`, so 2025-era clients that send `initialize` are accepted. Upstream clients use `versionNegotiation: auto`, so the gateway can also connect to 2025-era servers. I added DeepWiki's public server through the dashboard to check this.

Tool-change notifications: when an admin disables, edits or removes a server, or a refresh finds a changed tool set, the gateway sends `notifications/tools/list_changed` to subscribed 2026 clients over `subscriptions/listen`. A 2025-era client gets no push and sees the change the next time it lists tools. Either way, a call to a disabled server's tool is refused at dispatch, even if the client still has the tool cached.

## Tool aggregation and name collisions

Every tool is exposed as `<slug>__<tool>`. The slug is the admin-chosen server identifier: `^[a-z0-9-]{1,20}$`, unique, and fixed once created.

- **Collisions.** Two servers can both expose `search` and stay distinct (`docs__search`, `wiki__search`), because slugs are unique. A server can't take over another server's prefix.
- **Client limits.** OpenAI-compatible tool calling, Claude Code and Cursor reject names outside `^[A-Za-z0-9_-]{1,64}$`. Names that would break this are sanitized, cut, and given a `_` plus 6 hex digits of SHA-256 of the full name. A plain cut could make two long names identical, and the hash stops that. `apps/gateway/src/naming.ts`
- **Routing.** Calls route through an exact `exposed name -> (server, original name)` map, never by splitting the string, so a tool whose own name contains `__` still routes correctly.

## Failure handling

| Situation | Behaviour |
|---|---|
| Upstream dead (pod killed, connection refused) | Its background refresh (every 15 s, 3 s timeout) marks it `unreachable` with the reason. Listing still returns the other servers' snapshots at once. A call to it fails fast with outcome `unreachable`. |
| Upstream hangs | The call is abandoned after `CALL_TIMEOUT_MS` (20 s) with outcome `timeout`. Other calls aren't affected, because each upstream has its own client. |
| Write tool times out | At the gateway (20 s): outcome `unknown`, with the message "the call may have been applied; verify before retrying". Inside woo-mcp, the store request times out first (15 s), and woo-mcp answers with a tool error saying the write may have been applied and naming the read tool to check with. Nothing retries writes automatically. In chat this is enforced in code: once a write fails or may have been applied, the agent refuses any further write tool calls for the rest of that request, without calling the upstream. |
| Upstream returns `isError` | Passed through unchanged. Audit outcome `tool_error`. |
| Upstream's tool list changes | `tools_changed_at` is set and shown in the dashboard, and connected clients are notified. |
| Late result from a server disabled meanwhile | Discarded. A per-server generation counter must match before any snapshot or status write. |
| Gateway crashes mid-call | The audit row stays `pending`, which is evidence of an interrupted call. |
| Several gateway replicas | Every registry change sends `NOTIFY urumi_changes` in the same transaction. Every replica `LISTEN`s, reloads, and notifies its clients. |

## How woo-mcp talks to the store

It uses the WooCommerce REST API v3 over the in-cluster Service (`http://wordpress.urumi-store.svc.cluster.local`) with a read/write consumer key.

- **Why REST.** It's versioned and documented, it applies WooCommerce's own validation and hooks, and the key limits what it can do. WP-CLI would need `exec` into the WordPress pod, which means Kubernetes API access and an RBAC hole. Direct SQL would skip WooCommerce's logic and caches.
- **Why OAuth 1.0a.** Over plain HTTP, WooCommerce only accepts one-legged OAuth 1.0a signatures, not consumer key Basic auth. TLS ends at the Ingress, so in-cluster traffic is HTTP. woo-mcp signs each request with HMAC-SHA256 (`apps/woo-mcp/src/oauth.ts`, tested against the published OAuth example). WooCommerce rebuilds the signed URL from WordPress's home URL with an `http` scheme, so woo-mcp signs `http://<public store host><path>` even though it connects to the Service address.
- **Rejected alternative.** Setting `$_SERVER['HTTPS'] = 'on'` for internal requests is a common shortcut. It would lie to WordPress about transport security for every plugin, so I didn't use it.

## Store bootstrap

The `store-bootstrap-<revision>` Job runs `charts/urumi/files/store-bootstrap.sh` with WP-CLI on every install and upgrade. It's safe to rerun. In order, it:

1. waits for the database;
2. installs WordPress only if needed;
3. installs and activates WooCommerce;
4. sets currency and timezone, disables "coming soon" and shipping, and enables Cash on Delivery;
5. seeds two products only into an empty store;
6. registers the chart-generated consumer key (hashed with `wc_api_hash`) only if that exact key isn't already there.

It's an ordinary Job, not a Helm hook, so `helm upgrade --wait` can't deadlock on it. The key is generated by the chart rather than by WordPress, so the Job never writes a Kubernetes Secret and needs no RBAC at all.

WordPress core lives on the volume, as the official image expects. The image only copies core into an empty volume, so on its own a new image tag would never upgrade WordPress. A `sync-core` init container fixes that: it copies core from the image whenever the versions differ, leaving `wp-content` and `wp-config.php` alone. The image tag decides the WordPress version.

## Secrets

- **Generated by the chart.** Database passwords, the WordPress admin password, the Woo consumer key, the upstream bearer tokens, the gateway master key and the bootstrap admin password are created once by the chart (`templates/_helpers.tpl`, `urumi.secrets`). They're stored in `urumi-generated`, which has `helm.sh/resource-policy: keep`, and read back with `lookup` on every upgrade. They never appear in git or in values files.
- **Copied per namespace.** Each namespace gets a Secret with only the keys its pods need: `store-credentials`, `mcp-credentials`, `gateway-credentials`.
- **The LLM key** comes from outside: `.env`, then `scripts/llm-secret.sh`, then the Secret `llm-credentials`, piped through stdin. It never appears in a command line.
- **In production** the same Secret names can be provided by External Secrets or Sealed Secrets instead.

Inside the gateway:

- API keys: SHA-256 hash and a 12-character display prefix. A fast hash is fine for 256-bit random keys.
- Passwords: scrypt.
- Session tokens: SHA-256 hash, in an `httpOnly`, `SameSite=Lax` cookie. State-changing requests also need `X-Requested-With`.
- Upstream credentials: AES-256-GCM with the master key, and write-only in the API.

## Data model (Postgres)

| Table | Holds |
|---|---|
| `users`, `sessions`, `invites` | Accounts and access to the dashboard |
| `api_keys` | Gateway access |
| `servers` | Upstream registry: URL, auth type, encrypted credential, enabled flag, status, last error |
| `server_tools` | The tool snapshot each upstream last returned |
| `tool_policies` | Which tools are admin-only |
| `audit_log` | One row per tool call. It stores user email, server slug and tool name as text, so history survives when a user or server is deleted. |
| `conversations`, `messages` | Chat history, scoped to the user who owns it |

## What changes for production

All of these are values. No template changes.

| Concern | Local | Production |
|---|---|---|
| DNS | `*.localtest.me` resolves to 127.0.0.1 | Real `A` records, or `<ip>.sslip.io` |
| Ingress | Traefik bundled with k3d, HTTP | Traefik bundled with k3s. With `tls.enabled` + `tls.clusterIssuer`, cert-manager issues certificates |
| Storage | `local-path` | `local-path` on a single VPS, or a block-storage class. Sizes go up |
| Secrets | Generated by the chart, LLM key from `.env` | Same mechanism. External Secrets or Sealed Secrets for a team setup |
| Images | Imported into k3d with `IfNotPresent` | Pinned registry tag |
| Scale | 1 gateway | 2+ gateways |

## Tradeoffs I chose

- **One umbrella chart, no subcharts.** Templates are split by concern (`store.yaml`, `mcp-servers.yaml`, `platform.yaml`, `network-policies.yaml`, `secrets.yaml`). Subcharts would mean three or four extra `Chart.yaml` and values layers for no gain at this size.
- **Dashboard on shadcn/ui** (Radix primitives + Tailwind CSS v4). The components are copied into `apps/dashboard/src/components/ui`, so there's no component library runtime to upgrade. The theme (light, dark or system) is CSS variables, set before first paint. Fonts are bundled, because the gateway's NetworkPolicy blocks runtime CDN requests. Chat streams server-sent events from `POST /api/chat`, so a slow free model shows each tool step as it happens, and Stop cancels the turn on the server.
- **The storefront is built entirely by the bootstrap Job**: theme styles, home page, categories, original product illustrations shipped in the chart, menus, policy pages and checkout settings. A fresh `helm install` gives the same store every time. Running it again updates in place and creates no duplicates.
- **The gateway serves the dashboard.** That drops a separate nginx Deployment, and same-origin `/api` means no CORS.
- **TypeScript run directly by Node (type stripping).** No backend build step, and the same language as the dashboard.
- **Postgres over SQLite.** It lets the gateway run multiple replicas and carries `LISTEN/NOTIFY`.
- **A cached snapshot instead of a live fan-out on `tools/list`.** Listing is instant and immune to slow upstreams. The cost is up to one refresh interval of staleness for tools that changed upstream. Admin actions refresh right away.
- **One SDK client per upstream, recreated after errors or config changes**, instead of a connection per call. That saves one discovery round trip per call, at the cost of keeping a little client state per upstream.
- **WordPress runs its stock root entrypoint** (Apache binds port 80, then drops to `www-data`). Every other workload runs as non-root with all capabilities dropped, and the gateway and MCP servers also have read-only root filesystems.

## Known limits

- No rate limiting per user or per key.
- No OAuth on the gateway; clients use static per-user API keys.
- 2025-era MCP clients don't get `list_changed` pushes and have to re-list.
- The audit log keeps a 500-character, redacted summary of arguments. It doesn't store tool results.
