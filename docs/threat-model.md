# Threat Model — MCP Gateway

**Status (updated after Milestone 4):** C1 (API-key hashing + browser session cookies),
C2 (role enforcement, now including upstream toggles) and C6 (audit logs, including
`upstream_enabled`/`upstream_disabled` rows) are **implemented and test-verified**; C5's
per-principal grants and pre-forward schema validation are implemented, and enable/disable
is a real server-side control backed by `upstream_overrides`. C3, C4, C7, C8 and the B1
boundary hardening remain planned for Milestone 8 — each control below names its verifying
test once implemented.

Method: identify assets → draw trust boundaries → list threats → attach controls → record what
is explicitly out of scope. Loosely STRIDE-flavoured, kept plain-English.

---

## 1. Assets worth protecting

| # | Asset | Why an attacker wants it |
| --- | --- | --- |
| A1 | WooCommerce consumer key/secret | Full read/write on the store: read customer orders, create products, change order status. |
| A2 | Users' API keys | Direct impersonation of a dashboard/MCP user. |
| A3 | `API_KEY_PEPPER` + DB of key hashes | Together they allow offline derivation of usable API keys. |
| A4 | Audit log | Deleting or forging it hides misuse. |
| A5 | The LLM/agent identity (later) | Turning the chat agent into a tool-calling puppet. |
| A6 | The Kubernetes cluster itself | Cryptomining, lateral movement, reading every Secret. |
| A7 | Store data (orders, customers) | PII, revenue and reputational damage. |

## 2. Trust boundaries

```text
  [ untrusted internet ]
          │  HTTPS (Ingress, TLS)
  ────────┼─────────────────────────────────── boundary B1
          ▼
  [ dashboard browser ]      [ external MCP client ]
          │ REST /api/*             │ MCP /mcp
  ────────┼─────────────────────────┼─────────────── boundary B2 (authn happens here)
          ▼                         ▼
  ┌─────────────────────────────────────────────┐
  │                GATEWAY                      │
  │  authn → authz → schema validation → routing│─── writes audit log
  └─────────────────────────────────────────────┘
  ────────┼─────────────────────────────────────── boundary B3 (upstream trust)
          ▼  Streamable HTTP (cluster-internal)
  [ woocommerce-mcp ]   [ inventory-mcp ]   [ support-mcp ]
  ────────┼─────────────────────────────────────── boundary B4
          ▼
  [ WooCommerce store / other data sources ]
          │
  [ PostgreSQL: users, key hashes, audit ] ← reached only from gateway
```

Rules implied by the diagram:

- **B1/B2:** nothing crosses without authentication. The deliberate exceptions are
  operational: `/healthz` and `/readyz` answer unauthenticated because container probes
  cannot present an API key (decision D21), and `POST /api/auth/login` must be reachable
  *to obtain* credentials — it exposes no data and audits every failure (D23). The probes
  expose aggregate status only. Everything else (`/mcp`, `/api/*`) fails closed on
  missing, malformed, invalid or revoked credentials; browser requests pass either a
  Bearer key or the `urumi_session` cookie, and the cookie is honored **only** under
  `/api/*` (never `/mcp`, never as a fallback for a presented-but-invalid Bearer).
- **B3:** upstreams are *semi-trusted*: they are our code today, but the gateway must treat
  their responses as untrusted input (a compromised upstream must not be able to forge an
  audit row or smuggle a call to another upstream).
- **B4:** WooCommerce credentials are used on exactly one side of B4, inside `woocommerce-mcp`.

---

## 3. Controls

### C1 — API-key hashing (protects A2, A3)

- Keys are ≥32 bytes of CSPRNG randomness, displayed **once** at creation.
- Storage: `sha256(key || API_KEY_PEPPER)` + a non-secret `key_prefix` for UI display.
- Lookup by prefix → constant-time comparison of the hash (`crypto.timingSafeEqual`).
- The pepper is a separate Kubernetes Secret from the database credentials.
- Revocation sets `revoked_at`; the hash row stays for audit continuity.
- Rotation: issue a new key, revoke the old one — both keys may briefly coexist.
- **Browser sessions (Milestone 4, D23):** the dashboard exchanges a key (JSON body only,
  never a URL) for an opaque 32-byte token delivered as `HttpOnly; SameSite=Strict;
  Secure` cookie; only `sha256(token)` is stored server-side (`web_sessions`, 12-hour
  TTL), bound to the key's user, and re-validated against the key's `revoked_at` on every
  request — revoking a key ends its sessions. The plaintext key never enters
  `localStorage`/`sessionStorage`/URLs/logs, and no credential of any kind exists in the
  frontend bundle or build variables.

**Status: implemented (Milestone 3). Verified by:** `test/auth-keys.test.ts` (format,
pepper sensitivity, strict digest checks), `test/auth-middleware.test.ts` ("a revoked key is
rejected on the next request", "every credential failure returns the identical 401 body"),
`test/api.test.ts` (stored material contains the prefix and sha256 hex, never the
plaintext), and the real-database suite `test/integration/postgres.test.ts` ("key lifecycle
… and audit rows run against the real tables" — no plaintext column, no plaintext value,
`401` after revocation). Session-cookie behavior (Milestone 4) is verified by
`test/auth-middleware.test.ts` (cookie grants access under `/api`, is ignored for `/mcp`,
never used as fallback for a malformed Bearer, dies with the key),
`test/api.test.ts` ("dashboard login/session" — wrong key → 401 + audit row, logout
removes the session, cookie value is never echoed in responses) and
`test/integration/postgres.test.ts` (real session create → read → lazy-expiry → revoke
round trip in `web_sessions`).

### C2 — Role enforcement (protects A1, A5)

Two roles for two users:

| Role | May do |
| --- | --- |
| `admin` | everything, including `create_product`, `update_order_status`, upstream enable/disable, reading the audit log |
| `reader` | read-only tools (`list_products`, `list_orders`, `get_order`), no admin API |

- The role comes from the authenticated principal, **never** from a request body or header a
  client controls.
- Denials return a structured `403`/MCP error and still write an audit row with
  `outcome: "denied"`.

**Status: implemented (Milestone 3). Verified by:** the matrix in
`test/authorization.test.ts` (admin/reader × read/write × granted/ungranted upstream/tool,
including "the reader role is a ceiling over grants"), the end-to-end denial in
`test/authz-e2e.test.ts` (reader write call → `McpError -32003` + exactly one denied audit
row), and the `403` + `access_denied` rows against real PostgreSQL in
`test/integration/postgres.test.ts`.

### C3 — Upstream credential isolation (protects A1)

- WooCommerce consumer key/secret exist **only** as env vars inside the `woocommerce-mcp` Pod,
  mounted from a Kubernetes Secret.
- They are never sent to the gateway, never returned by any API, never logged (log scrubbing
  for `ck_`/`cs_` prefixes), never in the dashboard bundle.
- The gateway holds only the *URL* of the WooCommerce MCP server, not store credentials.
- Store API keys get the **minimum WooCommerce permission** that works (`read` vs `read/write`
  split if two keys are feasible).

**Verified by:** grep-style test over logs/responses for `ck_`/`cs_`; a code review checklist
item on every new endpoint.

### C4 — URL validation / SSRF prevention (protects A6)

The gateway will call URLs that operators can configure, which is the classic SSRF foot-gun.

- Upstream base URLs come from configuration, not from client requests. A downstream client can
  select *which configured upstream*, never *where* it points.
- On load, each URL is validated: `https`/`http` only, no embedded credentials, no
  user-info/`@` tricks, normalized before use.
- DNS resolution is checked at connect time: reject loopback, link-local (`169.254.0.0/16`),
  private ranges (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 equivalents —
  **unless** an explicit allow-list entry permits the in-cluster service range.
- Re-validate after redirects; cap redirects (≤3) and re-check every hop.
- No proxy inheritance from environment variables for upstream calls.
- Response size limits so a malicious upstream cannot exhaust memory.

**Verified by:** unit tests for each rejected host form (`http://169.254.169.254/…`,
`http://user@internal`, decimal-IP encodings, redirect-to-metadata) and a test that a
configured in-cluster URL still works.

### C5 — Tool permissions (protects A1, A5)

Per-principal grants: `allowed_upstreams` and `allowed_tools` stored in Postgres.

- A tool call is checked in order: key valid → not revoked → tool permitted by role →
  upstream granted → exact `tools:<qualified>` grant → arguments match JSON Schema →
  upstream enabled/reachable. Everything up to the grant checks is derived from the
  authenticated principal, never from request input.
- Upstream **enable/disable** is a first-class control: disabling `woocommerce` instantly
  removes its tools from `tools/list` and rejects `tools/call` with a clear error.
- Tool inputs are validated against the registered schema **before** any outbound call — with
  ajv at the gateway (the registry stores the JSON Schema MCP publishes; decision D18) and with
  zod inside each MCP server — so arguments cannot smuggle query parameters (e.g. an unexpected
  `status` filter).

**Status: implemented (Milestone 3 grants/validation; Milestone 4 toggles). Enable/disable
is a server-side control:** `POST /api/upstreams/<id>:enable|disable` (admin only, fixed
id set, 409 for unconfigured upstreams) persists to `upstream_overrides` and applies a
registry override (D24); disabling instantly removes the tools from `tools/list` and
rejects `tools/call`. Verified by: disable-upstream test (list shrinks, call rejects),
`test/registry-toggle.test.ts` (real registry + MCP client through the toggle path),
`test/api.test.ts` (unknown id → 400, non-configured → 409, reader → 403 + audit row,
idempotent re-send → `changed:false` with no duplicate row), schema-rejection tests,
`test/authorization.test.ts` (grant order),
`test/authz-e2e.test.ts` ("a non-write tool outside the grant list is denied before any
validation or routing"), grants read from PostgreSQL in
`test/integration/postgres.test.ts`, plus the override-survives-restart test (rows reapplied
at boot).

### C6 — Audit logs (protects A4, forensics overall)

One append-only table, written by the gateway's single execution path:

```text
id, occurred_at, action(tool_call|auth_failed|access_denied|key_created|key_revoked|
upstream_enabled|upstream_disabled),
key_id, user_id, role, upstream_id, tool_name, qualified_name,
outcome(success|error|timeout|denied), duration_ms, error_code
```

(The `action` dimension is a Milestone 3 additive extension — decision D22 — so denied
credential presentations and admin-API 403s share the timeline with tool calls; Milestone 4
additively added the two upstream-toggle actions, also under D22.)

- Written for **every** outcome, including denials and timeouts — a log that only records
  successes is attacker-friendly.
- Arguments and responses are **not** stored wholesale (they contain PII/order data); store a
  schema-validated summary or a hash instead.
- Application rows are `INSERT`-only from the app's DB role (no `UPDATE`/`DELETE` grant).
- The gateway's own failures must not lose the record of the failure: write-ahead to the
  request handler before returning.

**Status: implemented (Milestone 3; toggle rows since Milestone 4). Verified by:**
`test/audit.test.ts` (sanitization, failed-writer degradation),
`test/authz-e2e.test.ts` ("exactly one audit row for the denied call"), and against real
PostgreSQL: `test/integration/postgres.test.ts` — "MCP tool calls write exactly one audit
row per call into PostgreSQL (§5.4)" (count is `before+1` per call,
`tools/list` writes none), "the runtime role is append-only on audit_log" (`DELETE` and
`key_hash` rewrites fail with `42501`, `INSERT` and `UPDATE (revoked_at)` succeed), the
migration-002 action-check assertion (all seven actions accepted, unknown rejected), and
the toggle flow writing exactly one `upstream_enabled`/`upstream_disabled` row.
On the **read** side, the dashboard viewer projects rows through a whitelisted view-model
(`projectAuditRow` in `apps/dashboard/src/state.ts`) — key ids, hashes, headers, cookies
and any unexpected field are dropped before rendering, verified by
`apps/dashboard/test/state.test.ts`.

### C7 — Failure isolation / resilience (protects availability of A6/A7)

- Per-upstream connect timeout and per-call timeout (defaults in `packages/shared`).
- One upstream failing → only its tools return structured errors; all other upstreams keep
  serving.
- Bounded concurrency per upstream; a bulk job cannot starve interactive calls.
- Input and response size limits; JSON body size cap on `/mcp` and `/api`.
- Upstream health is tracked so the dashboard can show degraded state rather than hanging.
- Gateway restarts are handled by Kubernetes, not by an upstream's misbehaviour.
- Rate limiting per API key (slow-start, configurable).

**Verified by:** a fault-injection test — kill `woocommerce-mcp` mid-suite and assert
`inventory_*` tools still succeed and the failing ones return `timeout`/`unreachable` errors
within the deadline.

### C8 — Supporting controls

| Control | Notes |
| --- | --- |
| TLS | Terminated at Ingress; cluster-internal traffic stays on the private network (documented as accepted risk for local; NetworkPolicy in prod values). |
| Secrets in git | Impossible by policy: `.env` git-ignored, `.env.example` holds placeholders only, real values only in Kubernetes Secrets. |
| Least-privilege RBAC | Each Pod gets its own ServiceAccount; no `cluster-admin`; the gateway's DB role can `INSERT`/`SELECT` only. |
| Dependency hygiene | `npm audit` in the check script; lockfile committed; free/open-source dependencies only (budget constraint). |
| Input validation | zod at every boundary: REST body, MCP tool args, upstream responses (they are untrusted too). |
| Logging hygiene | Structured logs, scrubbed of `ck_`, `cs_`, `sk_`, `Bearer` and API-key-looking strings. |
| Error messages | Never echo internal URLs, stack traces or SQL to clients. |

---

## 4. Threat → control map

| Threat | STRIDE | Control |
| --- | --- | --- |
| Stolen DB dump → usable API keys | Tampering | C1 hashing + pepper |
| User A calls tools meant for User B | Elevation of privilege | C2 roles, C5 grants |
| Client-supplied upstream URL → internal scan | SSRF / Elevation | C4 URL validation |
| Gateway response/log leaks store credentials | Information disclosure | C3 isolation, C8 scrubbing |
| Caller hides misuse | Repudiation | C6 audit log |
| Disabling one upstream bricks everything | Denial of service | C7 isolation, C5 toggles |
| Malicious tool arguments → crafted WooCommerce query | Tampering | C5 schema validation |
| Compromised upstream forges responses | Tampering | B3 treating upstreams as untrusted input, response validation |
| Secret committed to git | Information disclosure | C8 policy + `.gitignore` |
| Chat agent tricked by prompt injection into a write | Elevation of privilege | agent uses ordinary path: C2 + C5 + schema validation still apply |

---

## 5. Explicitly out of scope (for now)

- **WooCommerce/WordPress hardening** — we assume the store's own auth and updates are managed
  by the store operator.
- **Multi-tenant isolation between different *companies*** — this project has two users in one
  organisation.
- **Full WAF / DDoS protection** — no paid services allowed.
- **Formal cryptographic review** — we use standard library primitives (SHA-256, CSPRNG,
  `timingSafeEqual`) and standard constructions only.
- **Non-HTTP lateral movement inside the cluster** — the chart now ships a
  namespace-internal NetworkPolicy (`networkPolicy.enabled`, on in production values),
  but enforcement depends on the CNI and egress/per-workload policies remain part of the
  security-hardening milestone.

---

## 6. Security milestone exit criteria

The security milestone is complete when every control C1–C7 has:

1. working code (not a stub),
2. an automated test that fails if the control is removed,
3. a demo script showing the control in action, and
4. a paragraph here updated from *planned* to *implemented* with the test name.
