# Gateway HTTP API

The gateway serves three things on one origin (`app.<domain>`):

- `/` the dashboard (static React build)
- `/api/*` the dashboard JSON API, authenticated by the `sid` session cookie
- `/mcp` the aggregated MCP endpoint, authenticated by `Authorization: Bearer <api key>`

Health: `GET /healthz` (process up), `GET /readyz` (database reachable).

## Conventions

- JSON in and out. Errors: `{"error": {"code": "not_found", "message": "server not found"}}` with a matching HTTP status.
- Every state-changing `/api` request (POST, PATCH, PUT, DELETE) must send `X-Requested-With: fetch`. Without it the gateway answers 403. Together with the `SameSite=Lax` cookie this blocks cross-site form posts.
- Timestamps are ISO 8601 UTC strings.
- Roles: `admin` manages servers, members, invites, permissions and sees the full audit log. `member` uses tools, manages their own keys, and sees their own audit rows.

## Auth

| Method | Path | Who | Body | Response |
|---|---|---|---|---|
| POST | `/api/auth/login` | anyone | `{email, password}` | `{user}` and sets `sid` cookie |
| POST | `/api/auth/logout` | session | | `204` |
| GET | `/api/auth/me` | session | | `{user}` or 401 |
| GET | `/api/invites/:token` | anyone | | `{email, role, expires_at}` or 404 |
| POST | `/api/invites/:token/accept` | anyone | `{name, password}` (password min 10 chars) | `{user}` and sets `sid` cookie |

`user` = `{id, email, name, role}`.

## Servers

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/servers` | session | |
| POST | `/api/servers` | admin | `{slug, name, url, auth_type, auth_header_name?, credential?}` |
| PATCH | `/api/servers/:id` | admin | any of `{name, url, enabled, auth_type, auth_header_name, credential}`; `credential: null` clears it |
| DELETE | `/api/servers/:id` | admin | |
| POST | `/api/servers/:id/refresh` | admin | |

Server object:

```json
{
  "id": "uuid",
  "slug": "woo",
  "name": "WooCommerce store",
  "url": "http://woo-mcp.urumi-mcp.svc.cluster.local:8000/mcp",
  "auth_type": "none | bearer | header",
  "auth_header_name": "X-Api-Key or null",
  "has_credential": true,
  "enabled": true,
  "status": "connected | unreachable | disabled | pending",
  "last_error": "connection refused or null",
  "last_checked_at": "2026-10-16T10:00:00Z",
  "tools_changed_at": "2026-10-16T09:00:00Z or null",
  "tools": [
    {
      "name": "list_orders",
      "exposed_name": "woo__list_orders",
      "description": "...",
      "input_schema": {},
      "annotations": {"readOnlyHint": true},
      "admin_only": false
    }
  ]
}
```

The credential is write-only. No response ever contains it.

`slug` matches `^[a-z0-9-]{1,20}$`, is unique, and cannot change after creation. `url` must be `http` or `https` and passes the SSRF check described in `docs/THREAT_MODEL.md`. A failed check returns 400 with code `url_rejected`.

## Members and invites (admin)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/users` | | `[{id, email, name, role, active, created_at}]` |
| PATCH | `/api/users/:id` | `{role?, active?}` | user. Admins cannot demote or deactivate themselves. |
| GET | `/api/invites` | | `[{id, email, role, expires_at, accepted_at}]` |
| POST | `/api/invites` | `{email, role}` | `{id, email, role, expires_at, invite_url}`. The URL holds a one-time token, shown once. |
| DELETE | `/api/invites/:id` | | `204` |

## API keys

| Method | Path | Who | Body | Response |
|---|---|---|---|---|
| GET | `/api/keys` | session | | own keys. Admins may pass `?all=1` for everyone's. |
| POST | `/api/keys` | session | `{name}` | key object plus `key` (full secret, shown once) |
| DELETE | `/api/keys/:id` | owner or admin | | `204`, sets `revoked_at` |

Key object: `{id, name, prefix, user_email, created_at, last_used_at, revoked_at}`. `prefix` is the first 12 characters, for example `mcpg_AbC123x`.

## Tool permissions (admin)

| Method | Path | Body |
|---|---|---|
| PUT | `/api/servers/:id/tools/:tool/policy` | `{admin_only: boolean}` |

An `admin_only` tool is hidden from members' tool lists and refused if a member calls it directly. That call is audited with outcome `denied`.

## Audit

`GET /api/audit?user_id=&server=&outcome=&limit=50&before_id=` returns `{rows, next_before_id}`. Admins see every row. Members see their own rows.

Row: `{id, started_at, user_email, source: "mcp" | "chat", server_slug, tool_name, duration_ms, outcome, error}`.

Outcomes:

- `pending`: in flight. A row that stays pending means the gateway died mid-call.
- `ok`
- `tool_error`: the upstream returned `isError`.
- `timeout`
- `unreachable`
- `denied`
- `unknown`: a write timed out after it was sent, so it may have been applied.
- `error`

## Chat

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/chat` | | `[{id, title, created_at, updated_at}]`, the caller's 50 most recent conversations |
| POST | `/api/chat` | `{conversation_id?, message}` | JSON `{conversation_id, reply, tool_calls}`, or a server-sent event stream when the request sends `Accept: text/event-stream` |
| GET | `/api/chat/:conversation_id` | | `{messages: [{role, content, tool_calls?}]}` |

`tool_calls` = `[{name, arguments, outcome, duration_ms, result_preview}]`. Conversations belong to the user who created them. Any other user gets 404.

Stream events, in order:

| Event | Data |
|---|---|
| `conversation` | `{conversation_id}`, sent first, so a client can reopen the conversation after a reload |
| `thinking` | `{step}`, sent each time the gateway asks the model for its next move |
| `tool_call_started` | `{id, name, arguments}` |
| `tool_call_finished` | `{id, name, arguments, outcome, duration_ms, result_preview}` |
| `message` | `{content}`, the final reply (Markdown) |
| `error` | `{message}`, for example an LLM rate limit. A `message` explaining it still follows |
| `done` | `{conversation_id, reply, tool_calls}` |

Closing the connection stops the turn. The gateway aborts the in-flight model request and runs no more tools. It saves the reply "Stopped. Tool calls that already ran are listed above.", so the conversation history shows where it stopped.

## Meta

`GET /api/meta` (session) returns `{mcp_url, llm_model}`. The dashboard uses it to show connection instructions.

## MCP endpoint

`POST /mcp` speaks Streamable HTTP. Stateless 2026-07-28 clients and 2025-era clients that send `initialize` are both accepted.

- `tools/list` returns the caller's view: tools of enabled servers, named `<slug>__<tool>`, minus `admin_only` tools for members.
- `tools/call` routes to the upstream server with that server's own credential.
- A missing, unknown or revoked key returns HTTP 401 on every request.
- `subscriptions/listen` delivers `notifications/tools/list_changed` when an admin enables, disables, edits or removes a server, or a refresh finds changed tools.
