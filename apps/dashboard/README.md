# Urumi Dashboard

The React UI for the gateway: login, overview, tool list, upstream enable/disable, audit
viewer and a labelled chat foundation. It is a **client** of the gateway's REST API — it
never speaks MCP itself, never executes tools, and never holds credentials.

## Quick start

```bash
# terminal 1 — the gateway (needs DATABASE_URL + at least one *_MCP_URL;
# UPSTREAM_ALLOWED_PRIVATE_HOSTS is the C4 SSRF allow-list — required for loopback)
cd apps/gateway
DATABASE_URL=postgresql://... API_KEY_PEPPER=... WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp UPSTREAM_ALLOWED_PRIVATE_HOSTS=127.0.0.1 npm run dev

# terminal 2 — the dashboard dev server (proxies /api to the gateway)
cd apps/dashboard
npm run dev            # http://127.0.0.1:5173
```

Paste a `umk_…` API key (issue one with `POST /api/keys` as admin, or use the seeded demo
keys from migration 001) into the login screen. The key is sent once, in a JSON body, over
the server-side session endpoint — see [Browser auth](#browser-auth).

Production build:

```bash
npm run build -w @mcp/dashboard   # static bundle in apps/dashboard/dist
npm run preview -w @mcp/dashboard # serves dist with the same /api proxy
```

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `VITE_GATEWAY_API_URL` | `vite.config.ts` (Node side) | Dev/preview proxy target for `/api` — defaults to `http://127.0.0.1:8080`. Used only to configure the Vite dev server; it is **not** referenced via `import.meta.env` anywhere in `src/`, so no gateway URL or env value is inlined into the shipped bundle. All runtime requests are relative (`/api/...`) and same-origin. |

No other environment variable exists. There is no `VITE_API_KEY`, no token var, and no
feature flag — credentials never come from build-time configuration.

## Features

| Page | What it does | Server-side backing |
| --- | --- | --- |
| **Login** | paste key → `POST /api/auth/login` → httpOnly session cookie → `/api/me` | `web_sessions` row stores only `sha256(token)` |
| **Overview** | session identity (role/grants), health, upstream summary, recent audit rows | `/api/me`, `/healthz`, `/api/upstreams`, `/api/audit?limit=10` |
| **Tools** | aggregated tool list with degraded-upstream banners | `GET /api/tools` (mirror of the registry behind `tools/list`) |
| **Upstreams** | per-upstream status; **admin-only** enable/disable with per-row busy state | `GET /api/upstreams`, `POST /api/upstreams/<id>:enable|disable` |
| **Audit** | read-only viewer, keyset pagination, page-size selector 10/25/50/100 | `GET /api/audit?limit=…&before=…` (admin only) |
| **Chat** | clearly-labelled **foundation** — composer disabled, no responses generated | none (no agent endpoint exists until Milestone 9) |

Every list page distinguishes **loading / empty / error** states, retries are explicit, and
401 vs 403 are shown differently (re-login vs "not permitted").

### What is deliberately NOT here

- **No chat/agent answers.** The gateway has no agent endpoint (Milestone 9); the chat page
  renders a labelled placeholder rather than fabricating a conversation.
- **No key management UI.** Key issuance/revocation stays on the API (`/api/keys`) — the
  dashboard only displays non-secret key metadata via `/api/me`.
- **No tool execution.** Tool calls happen exclusively at `/mcp`; this UI mirrors the list.
- **No direct upstream URLs.** Toggles target fixed registry ids only; configuring an
  upstream's URL remains an environment concern (`*_MCP_URL`).

## Browser auth (D23)

1. The API key is pasted once and posted to `/api/auth/login` **in the JSON body** (never a
   URL, query parameter or header that lands in logs/history).
2. The server verifies it against `sha256(key‖pepper)`, then creates a `web_sessions` row
   containing only `sha256(session_token)`, bound to the key's user, 12-hour expiry.
3. The browser receives `Set-Cookie: urumi_session=…; HttpOnly; SameSite=Strict; Secure`.
   The token itself never enters application storage — nothing is kept in
   `localStorage`/`sessionStorage`/URLs, and `HttpOnly` keeps it out of JS reach.
4. Subsequent `/api` requests carry the cookie automatically. The middleware honors it
   **only** under `/api/*`, and only when no `Authorization` header is present (a malformed
   Bearer never silently falls back to the cookie). `/mcp` remains Bearer-only.
5. Authorization is always server-side: readers simply get 403s (with an `access_denied`
   audit row) — hiding buttons in the UI is cosmetic only.

## Testing

```bash
npm run typecheck -w @mcp/dashboard   # strict tsc over src + test + vite.config
npm run build -w @mcp/dashboard       # production bundle must compile
npm test -w @mcp/dashboard            # node:test, no extra framework
```

Strategy (documented honestly): the components' DOM behavior is verified by `tsc` +
`vite build`; everything with logic lives in pure modules that are unit-tested under
`node --test`:

- `test/client.test.ts` — relative `/api` paths only, key in JSON body (never URL),
  401→`UnauthorizedError`, 403→`ForbiddenError`, 5xx/network→structured errors,
  bounded audit queries (`limit`+`before`, never `offset`).
- `test/state.test.ts` — loading/loaded/empty/error transitions, limit clamping (1–100),
  keyset cursor, and the **audit redaction projection**: only whitelisted display fields
  ever reach the render layer (no `keyId`, hashes, `Bearer`, pepper or password values).

No new test framework was added (₹0 budget, no new dependency for what `node --test`
covers). Component behavior that would need a DOM harness is kept out of the pages by
pushing logic into `src/state.ts` and `src/api/client.ts`.

## Known limitations

- The production bundle is plain static files; `urumi/dashboard` (Milestone 6) serves
  them with nginx and proxies `/api` only when `GATEWAY_UPSTREAM` is set at runtime —
  in Kubernetes the Ingress owns `/api` instead (Milestone 7). `npm run preview`
  exercises the same proxy config during development.
- No route guards beyond `#/audit` requiring an admin response from the server — the UI
  shows the 403 the server returned rather than predicting permissions.
- Polling is deliberately avoided: status pages refresh via explicit buttons, so the
  dashboard does not hammer the gateway (threat-model C7).
- The chat page is a foundation only; see [docs/architecture.md §9.3](../../docs/architecture.md).
