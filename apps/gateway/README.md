# Urumi MCP Gateway

The gateway is the single doorway in front of several MCP servers. To its **callers** it is
one MCP server (Streamable HTTP at `/mcp`); to the systems behind it it is an **MCP client**.
It discovers each upstream's tools, publishes them as one aggregated list under qualified
names, routes every `tools/call` to the right upstream, enforces timeouts, and keeps working
when an upstream fails. Callers authenticate with **API keys** (hashed with a pepper in
PostgreSQL), are authorized by role + per-principal grants, and every request — including
every denial — leaves **exactly one audit row**.

Read [docs/architecture.md](../../docs/architecture.md) for the full design. Decisions
referenced below (D5, D14, D15, D18, D20, D21, D22) are in
[docs/decisions.md](../../docs/decisions.md).

## Quick start

```bash
# terminal 1 — a real upstream (optional for first contact; tests need none)
cd services/woocommerce-mcp
WOOCOMMERCE_STORE_URL=... WOOCOMMERCE_CONSUMER_KEY=... WOOCOMMERCE_CONSUMER_SECRET=... npm run dev

# terminal 2 — the gateway (at least one *_MCP_URL is required)
cd apps/gateway
# once: apply the schema (users/api_keys/audit_log + two seeded demo users)
DATABASE_URL=postgresql://mcp:mcp_local_password@localhost:5432/mcp_gateway npm run migrate
API_KEY_PEPPER=dev-only-pepper-change-me-0123456789 \
DATABASE_URL=postgresql://mcp:mcp_local_password@localhost:5432/mcp_gateway \
WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp npm run dev
```

Connect any MCP client to `http://127.0.0.1:8080/mcp`, sending
`Authorization: Bearer <key>` — e.g. issue one first:

```bash
curl -s -X POST localhost:8080/api/keys -H 'authorization: Bearer <admin-key>' \
  -H 'content-type: application/json' -d '{"user_id":"<uuid>"}'
# the plaintext key is in the response and is never shown again
```

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP — one session per client (capacity 100, idle sweep, graceful drain; D15 pattern) |
| `/healthz` | liveness: `{"status":"ok"}` once the process is listening |
| `/readyz` | readiness: sessions + per-upstream `reachable`/`last_error`. Reports honestly but **never fails** because an upstream is down — one dead backend must not take the gateway out of rotation |
| `GET /api/me` | the authenticated principal (user id, role, grants) |
| `GET/POST /api/keys`, `POST /api/keys/:id/revoke` | list metadata / issue a key (plaintext returned **once**) / revoke (idempotent) — **admin only** |
| `GET /api/audit` | audit rows, newest first, `limit` 1–100, keyset `before` cursor — **admin only** |

`/healthz` and `/readyz` are deliberately unauthenticated (D21, threat-model B2): container
probes cannot present a key, and the payload is aggregate status only. **Every** other route
— `/mcp` and all of `/api` — fails closed without a valid, unrevoked key.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_HOST` | `127.0.0.1` | bind address |
| `GATEWAY_PORT` | `8080` | bind port (1–65535) |
| `WOOCOMMERCE_MCP_URL` | — | upstream URL; setting it **enables** that upstream |
| `INVENTORY_MCP_URL`, `SUPPORT_MCP_URL` | unset | optional upstreams (Milestone 5); unset = not published |
| `UPSTREAM_TIMEOUT_MS` | `10000` | per-call budget toward an upstream |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `3000` | budget for the initial MCP handshake |
| `TOOL_CACHE_TTL_MS` | `60000` | how long a discovered tool list stays fresh |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `API_KEY_PEPPER` | — | **required**, ≥16 chars: pepper for `sha256(key‖pepper)` (threat-model A3 — own Secret, never the DB password) |
| `DATABASE_URL` | — | **required** `postgres://`/`postgresql://` URL: users, key hashes, audit log |
| `MIGRATE_DATABASE_URL` | `DATABASE_URL` | admin connection used only by `npm run migrate` |
| `MCP_APP_DB_PASSWORD` | unset | when set, the migration runner creates the least-privilege `mcp_gateway_app` role (append-only audit) |
| `TEST_DATABASE_URL` | unset | when set, `test/integration/postgres.test.ts` runs against that (disposable!) database; when unset it skips **with a printed reason** |

At least one `*_MCP_URL` is required. Invalid configuration fails fast with one issue per
problem, naming the variable. See [.env.example](../../.env.example).

## Routing and naming

- Every published tool is qualified: `woocommerce_list_products`, `inventory_<name>`, …
- The gateway splits a call name on the **first known upstream prefix**, so local names may
  themselves contain underscores.
- The same local name under two upstreams stays two distinct tools; a duplicate *qualified*
  name is impossible by construction (tested).

## Authentication and keys (threat-model C1/C2/B2)

- **Format:** `umk_` + base64url of 32 random bytes; the 12-character prefix is public
  (lookup + display), the body is shown to the caller **exactly once** at issuance.
- **Storage:** `sha256(key ‖ API_KEY_PEPPER)` hex in `api_keys.key_hash` — the pepper lives
  in its own secret (D8/C1); verification uses `crypto.timingSafeEqual` against the
  prefix-looked-up row, with a dummy comparison on unknown prefixes so "no such key" and
  "wrong key" cost the same.
- **Revocation:** `POST /api/keys/:id/revoke` sets `revoked_at`; there is no key cache, so
  the very next request is rejected with the same opaque `401 {"error":"unauthorized"}` as
  every other credential failure (the audit row records the exact reason: `missing_credentials`,
  `malformed_credentials`, `invalid_format`, `unknown_key`, `invalid_key`, `revoked_key`).
- **Fail-closed:** a database outage answers `503 {"error":"service_unavailable"}` —
  credentials could not be evaluated, so nothing crosses (C6 write-ahead cannot run either;
  a diagnostic is logged instead).
- **Authorization (C2/C5):** role ceiling first (`reader` cannot reach write-verb tools like
  `create_*`/`adjust_*`, even if granted), then the principal's `allowed_upstreams`, then the
  exact `tools:<qualified>` grant. MCP denials answer `McpError -32003`; admin-API denials
  answer `403 {"error":"forbidden"}` and still write an `access_denied` audit row.
- **Seeded users** (migration): `admin-demo` (admin, all five WooCommerce tools, three
  upstreams) and `reader-demo` (reader, read-only WooCommerce tools).

## Audit log (threat-model C6 / architecture §5.4 / D22)

One append-only table, one writer (`src/audit.ts`), written **ahead** of the response:

| `action` | When | `outcome` |
| --- | --- | --- |
| `tool_call` | every MCP `tools/call` — exactly one row, including denials, timeouts and validation failures (`tools/list` is authenticated but not audited) | `success` / `error` / `timeout` / `denied` |
| `auth_failed` | credential presented but rejected (per-reason `error_code`) | `denied` |
| `access_denied` | authenticated principal refused by the admin gate | `denied` |
| `key_created` / `key_revoked` | key lifecycle via `/api/keys` | `success` |

Fields are sanitized before storage (control characters stripped, 200-char cap,
conservative `error_code` charset); plaintext keys, peppers, arguments and upstream
responses are never stored. The runtime DB role `mcp_gateway_app` gets `INSERT`+`SELECT` on
`audit_log` only — the integration suite proves `DELETE` and hash rewrites fail with
`42501`. Reads are keyset-paginated (`before=<id>`, never `OFFSET`) for the 10M-row
question (D22).

## Failure behavior (threat-model C8 / D20)

| Situation | `tools/list` | `tools/call` |
| --- | --- | --- |
| Upstream slow / no answer within `UPSTREAM_TIMEOUT_MS` | unchanged | structured `isError`: `upstream 'woocommerce' did not respond within 10000 ms` |
| Upstream unreachable | last-known tools kept for one TTL window (no list flapping) | structured `isError`: `unreachable` |
| Upstream never answered (e.g. wrong URL at boot) | omitted from the list | clear structured error if called by name |
| Upstream disabled (URL unset) | omitted | clear structured error |

Error messages **never** contain internal URLs; the JSON logger redacts `ck_`/`cs_`/`sk_`,
`Basic` and `Bearer` values. Invalid arguments are rejected with `McpError -32602` **before**
any outbound request (validated with ajv against the schema the upstream itself published —
D18).

## Testing

```bash
# unit suite (part of npm run check): fakes only at the upstream/database edges
npm test -w @mcp/gateway          # 77 tests, no Docker or network needed

# + real PostgreSQL integration (5 tests): needs a DISPOSABLE database
docker run -d --name pg-test -e POSTGRES_USER=mcp -e POSTGRES_PASSWORD=pw \
  -e POSTGRES_DB=mcp_gateway_test -p 127.0.0.1:5433:5432 postgres:17-alpine
TEST_DATABASE_URL=postgresql://mcp:pw@127.0.0.1:5433/mcp_gateway_test \
  npm test -w @mcp/gateway        # 82 tests, real migrations/roles/audit rows
docker rm -f pg-test              # keep the image, throw the container away
```

Without `TEST_DATABASE_URL` the integration suite prints an explicit skip reason — it is
never skipped silently.

- The **official MCP SDK client** speaks real Streamable HTTP over loopback — full
  initialize/tools-list/tools-call handshakes, not mocked objects — and authenticates with a
  real hashed key; a second client connects as `reader` to prove the role ceiling (-32003).
- **Fake upstreams** are in-process MCP servers: one well-behaved, one that answers past the
  timeout, one that never accepts connections, one disabled via config. That is how failure
  isolation (learning-guide Stage 3 checkpoint) is proven without Docker, network or a real
  WooCommerce store.
- Contract drift: discovery warns (`woocommerce_tool_contract_drift`) if any of the five D14
  contract tools disappears upstream (D14 promise, tested both ways).

## Honest limitations

- **Enable/disable is configuration, not a control** — set/unset `*_MCP_URL` and restart;
  dashboard toggles backed by Postgres come in Milestone 4.
- **No rate limiting / bounded per-upstream concurrency** — threat-model C7, Milestone 8.
- **Two seeded users, no login session** — API keys are the only caller identity; dashboard
  login/session (JWT choice) belongs to Milestone 4.
- **Never paired with the real `services/woocommerce-mcp` process** — tests use fake
  upstreams; the live pairing belongs to Milestones 6–7 (Docker/kind). The wiring was smoke-
  tested once against a real gateway process (health probes, initialize handshake, graceful
  `SIGTERM`).
- Per-upstream concurrency is not yet bounded: one upstream under load does not degrade
  others (isolation), but within one upstream there is no queue or rate limit yet.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/config.ts` | env parsing (zod), fail-fast messages naming the variable |
| `src/routing.ts` | qualified names ↔ upstream ids |
| `src/upstream-registry.ts` | discovery, TTL cache, connect/call timeouts, health, contract check |
| `src/validation.ts` | ajv pre-forward argument validation |
| `src/mcp-server.ts` | downstream MCP server: aggregated `tools/list`, routed `tools/call` |
| `src/app.ts` | Express app: auth middleware, sessions (bound to the key's user), probes, draining |
| `src/api/routes.ts` | admin REST surface: `/api/me`, `/api/keys`, `/api/audit` |
| `src/auth/keys.ts`, `src/auth/authorization.ts`, `src/auth/middleware.ts` | key format/hashing, role+grant checks, fail-closed middleware |
| `src/audit.ts` | the single sanitized write-ahead audit writer |
| `src/db/` | pool, repository interfaces + PostgreSQL implementations, `migrate.ts` runner |
| `migrations/001_init.sql` | users / api_keys / audit_log schema + demo-user seeds |
| `src/logger.ts`, `src/errors.ts`, `src/version.ts` | JSON logs with redaction, error types, version stamp |
| `test/` | 77 unit tests + 5 real-PostgreSQL integration tests + fake-upstream/harness helpers |
