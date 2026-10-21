# Architecture Decisions

Short decision records: **Context → Decision → Alternatives → Trade-offs**.
Anything marked *planned* has not been built yet; these are commitments about *how* it will be
built when it is.

---

## D1 — Single monorepo with npm workspaces

**Context.** Six deployable/deliverable units (gateway, dashboard, three MCP servers, shared
types) built by one person, on a machine with npm only.

**Decision.** One repository, `package.json` `workspaces: ["apps/*", "services/*", "packages/*"]`.

**Alternatives.**
- Separate repos per service — cleaner ownership boundaries for teams, but multiplies CI,
  versioning and onboarding cost; a beginner would spend more time on plumbing than MCP.
- pnpm / Yarn workspaces — faster and stricter linking, but neither is installed, and
  corepack is absent; installing a second package manager conflicts with the ₹0 /
  don't-install-tools constraint for this milestone.

**Trade-offs.** One `node_modules` tree and one version set (simpler, occasionally forcing
coordinated upgrades) in exchange for atomic cross-package refactors. Published as private
packages only, so accidental publication is impossible.

---

## D2 — TypeScript everywhere backend-side, React + Vite for the UI

**Context.** MCP's official server/client libraries are TypeScript-first; the dashboard is a
browser SPA.

**Decision.** `strict` TypeScript for gateway and all MCP servers, React 19 + Vite 8 for the
dashboard, one shared `tsconfig.base.json`.

**Alternatives.** Python MCP SDK (fine, but splits the stack and the dashboard anyway needs
TS); plain JavaScript (faster to start, but tool schemas and audit-record shapes are exactly
where type errors hide until production).

**Trade-offs.** Compilation step and type verbosity up front; runtime surprises and
schema drift down. `strict` plus `noUncheckedIndexedAccess` is deliberately on.

---

## D3 — Official `@modelcontextprotocol/sdk` (TypeScript)

**Context.** Every MCP server and the gateway's upstream client need protocol conformance.

**Decision.** Use the official SDK (currently `^1.32.1`) for `McpServer`, the Streamable HTTP
transport, and `Client` for upstream connections. Hand-write JSON-RPC only in the docs.

**Alternatives.** Rolling our own JSON-RPC/HTTP layer — educational, but reimplements
`initialize` handshake, session ids, schema validation and version negotiation, i.e. exactly
the parts an interviewer will ask about and exactly the parts that break subtly.

**Trade-offs.** We inherit a third-party dependency and its release cadence. Acceptable: it is
the reference implementation, MIT-licensed, and pinned with a caret range we verified against
the registry (`zod ^4` satisfies its peer range).

---

## D4 — Streamable HTTP transport (not stdio, not HTTP+SSE)

**Context.** Everything must run as networked services inside Kubernetes.

**Decision.** All MCP endpoints speak Streamable HTTP at `/mcp`.

**Alternatives.**
- *stdio* — simplest possible local setup, but a Pod cannot "spawn a child across the cluster";
  unusable as a remote multi-tenant endpoint.
- *HTTP + SSE* (two endpoints) — the deprecated predecessor; extra endpoint, extra proxy
  configuration, no benefit.

**Trade-offs.** We must handle sessions, concurrent POSTs and reverse-proxy buffering (nginx
`proxy_buffering off` for SSE) — problems stdio never gives you. Those are also the problems
worth knowing for an FDE interview.

---

## D5 — The gateway always publishes *qualified* tool names

**Context.** Upstream-local names must stay `list_products` etc. (assignment), but two
upstreams can expose the same local name.

**Decision.** Publish `<upstreamId>_<localName>` (e.g. `woocommerce_list_products`) always,
never only-on-collision; resolve by matching the leading segment against the known upstream
ids.

**Alternatives.**
- *Bare names until a collision occurs* — shorter names, but the published tool list changes
  shape whenever an upstream is enabled/disabled, breaking cached clients and docs.
- *Only rename the losers of a collision* — same instability, plus a silent rename.

**Trade-offs.** Slightly more verbose tool names for every call. In exchange: deterministic,
reversible, greppable, and collision-proof by construction. Downside accepted: names are
64-ish chars of headroom, well inside MCP's name limits.

---

## D6 — Gateway hosts two surfaces: `/mcp` and `/api/*`

**Context.** The dashboard needs admin operations that MCP has no primitives for.

**Decision.** One Express app, two route families: `/mcp` (MCP only) and `/api/*` (REST for
the UI), sharing auth, tool registry and audit writer. Tools are *executed* only on the `/mcp`
path.

**Alternatives.**
- *Dashboard speaks MCP for everything* — uniform, but forces admin actions into fake "tools",
  which pollutes the tool list an LLM sees.
- *Separate backend process* — cleaner separation, but a second deployment, second auth stack
  and second config surface for no isolation benefit at this scale.

**Trade-offs.** Two API styles to document and test in one service. Mitigated by the
invariant: one execution path, one audit writer.

---

## D7 — PostgreSQL for application data

**Context.** Users, hashed API keys, upstream config and an audit log must survive restarts
and be queryable from Kubernetes.

**Decision.** PostgreSQL via the official `pg` driver, official `postgres` image, PVC-backed
in-cluster.

**Alternatives.**
- *SQLite* — zero operational cost, but one file per Pod, no safe multi-replica story, and the
  assignment names PostgreSQL.
- *No database / JSON file* — instantly loses audit integrity on restart.

**Trade-offs.** A stateful service to run (backups, migrations, credentials). Accepted because
the audit log is a security control, and a control that can be deleted by a Pod restart is not
a control. Local dev can still point `DATABASE_URL` at a throwaway container later.

---

## D8 — PostgreSQL schema decisions: API keys are stored as hashes

**Context.** Two users, individually revocable keys, no plaintext secrets at rest.

**Decision.** Generate a high-entropy key (≥ 32 random bytes, shown to the user exactly once),
store `sha256(key + API_KEY_PEPPER)` plus a short `key_prefix` for display ("abcd1234…"),
compare in constant time. Revocation = flip `revoked_at`.

**Alternatives.**
- *bcrypt/argon2id* — stronger against brute force, but deliberately slow, and a 256-bit random
  key has no dictionary to attack; slow hashing mainly protects weak passwords, not random
  tokens. (Peer projects: GitHub, Stripe and many API-key systems use a fast hash on high
  entropy keys.)
- *Encrypt and store* — enables recovering the key, which defeats the point.

**Trade-offs.** If the database *and* the pepper leak, keys are crackable only if the keys were
low-entropy — they are not. Pepper lives in a Kubernetes Secret, separate from the database
credentials, so one stolen backup is not enough. *Planned, not implemented.*

---

## D9 — Express 5 as the HTTP layer

**Context.** The MCP SDK ships Express-compatible Streamable HTTP plumbing; the gateway also
needs plain REST routes.

**Decision.** Express 5 (`^5.3.0`) for both surfaces.

**Alternatives.** *Hono* (also bundled with the SDK, faster, smaller — good, but a second
framework to learn alongside everything else); *Fastify* (excellent, more plugin ceremony).

**Trade-offs.** Express is the most documented Node framework, which matters when a beginner
has to explain the code in an interview. We accept older-style middleware ergonomics.

---

## D10 — Inventory and Support are separate processes, not gateway code

**Context.** It would be far faster to hardcode two more tool sets inside the gateway.

**Decision.** They are independent MCP servers; the gateway only knows their base URLs. Enabling
one is configuration, not a gateway deploy.

**Alternatives.** Hardcoded in-gateway tools — fewer moving parts, but the "gateway" degrades
into "the application", and the required property *continued operation when an upstream fails*
becomes meaningless because an upstream cannot fail independently.

**Trade-offs.** More Pods, more configs, more network hops. Bought deliberately: independent
failure domains and a genuinely generic gateway.

---

## D11 — No LLM and no AI API keys yet

**Context.** The assignment forbids paid/mandatory services and requires no key at this stage.

**Decision.** Milestone 0–8 contain no model calls. The chat agent (milestone 9) will use a
free tier (Groq) or a local model (Ollama) and will call tools through the ordinary gateway
path with its own principal.

**Alternatives.** Wiring a model in early — makes demos flashy while the security and routing
foundation is still untested.

**Trade-offs.** Later, less impressive-looking early milestones. Worth it: a chat demo over an
unaudited, unauthenticated gateway is the failure mode this assignment is designed to expose.

---

## D12 — Local Kubernetes first (kind or k3d), Helm for both environments

**Context.** Budget ₹0; final deployment must be on Kubernetes with Helm, local *and*
production value variants.

**Decision.** Local cluster via **kind** (preferred) or **k3d**, one Helm chart, two value
files: `values-local.yaml` (NodePort ingress, 1 replica, tiny resources) and `values-prod.yaml`
(TLS, replicas, resource limits, real Secrets). Cluster creation happens in a later milestone —
Docker/kubectl/Helm/Kind are **not installed** today.

**Alternatives.**
- *minikube* — also free; kind integrates more cleanly with Docker-based image loading.
- *Raw YAML for prod, Helm for local* — rejected: two sources of truth will drift.
- *Paid managed cluster* — violates the budget constraint.

**Trade-offs.** Local clusters are not production-shaped (no autoscaling, no real TLS), so
`values-prod.yaml` must be reviewed carefully before any real use. Accepted: the alternative
violates the constraints.

---

## D13 — Version pinning policy

**Context.** "Do not pin unverified or incompatible versions."

**Decision.** Caret ranges on major versions that were verified present and mutually
compatible against the npm registry on 2026-10-21 (`npm view …`): TypeScript 5.9.3 (not 6/7 —
5.x is what current tutorials, the SDK's examples and Stack Overflow answers assume),
`@modelcontextprotocol/sdk` 1.32.1, Express 5.3.0, zod 4.6.7 (satisfies the SDK peer range
`^3.25 || ^4.0`), React 19.3.1, Vite 8.3.4 with `@vitejs/plugin-react` 6.1.2 (peer `vite ^8`),
`pg` 8.23.1. Lockfile committed so installs are reproducible.

**Trade-offs.** Caret ranges can pull minor upgrades later; the lockfile is the real guarantee.
Exact pins would make upgrades manual and noisy for a solo project.

---

## D14 — `services/woocommerce-mcp` does not depend on `@mcp/shared`

**Context.** `packages/shared` lists the five WooCommerce tool names for the gateway to
consume. The natural instinct is to import that list from the server so the names cannot
drift. npm workspaces do not, however, run workspace scripts in topological order, so a
cross-package import would require `packages/shared/dist` to exist *before*
`services/woocommerce-mcp` typechecks — a build-order trap for a beginner-friendly repo.

**Decision.** `services/woocommerce-mcp` declares **no** dependency on `@mcp/shared`. Tool
names, input schemas and descriptions live in `src/tool-schemas.ts` / `src/mcp-server.ts`.
`packages/shared` remains the gateway-facing contract; keeping the two lists in sync is a
manual, documented step for Milestone 2 (the gateway will compare names at discovery time).

**Alternatives.** (a) Cross-import with a `prepack`/`prepare` build chain — extra machinery
and a confusing failure mode (`dist` missing) for two consuming sites. (b) Move the canonical
tool *definitions* (zod schemas) into `shared` — premature: the gateway needs names and JSON
Schema, not this server's zod internals.

**Trade-offs.** The two lists can drift; accepted for Milestone 1 and mitigated in Milestone 2
by a discovery-time assertion rather than a compile-time import.

---

## D15 — Stateful Streamable HTTP sessions (one `McpServer` per session)

**Context.** The SDK's Streamable HTTP transport supports a stateful pattern (server-generated
`Mcp-Session-Id`, sessions kept in a map) and a stateless pattern (`sessionIdGenerator:
undefined`, one shared server).

**Decision.** Stateful, mirroring the SDK's shipped `simpleStreamableHttp` example: each
initialize creates a transport **and** an `McpServer`, sessions are keyed by id, unknown
sessions get `404 -32001`, non-initialize POSTs without a session get `400 -32000`, capacity is
capped (default 100, `503` beyond), idle sessions are swept (default 30 minutes), and shutdown
drains (`503 "Server is shutting down"`) before closing transports.

**Alternatives.** Stateless — simpler and horizontally friendly, but no per-client SSE stream
and a weaker fit for the gateway's per-client session/audit story in Milestone 2.

**Trade-offs.** Session state lives in process memory (no cross-replica sharing yet); the
sweeper and capacity cap exist so a leak is bounded. Revisit when replicas > 1.

---

## D16 — Node's built-in test runner and native type stripping (no jest/vitest)

**Context.** Tests must run with zero extra tooling, and the SDK is ESM-first.

**Decision.** `node --test "test/**/*.test.ts"` runs TypeScript sources directly via Node's
native type stripping, so the engines floor is **Node ≥ 23.6.0** (raised from 20.19). Source
and tests import with explicit `.ts` specifiers; `tsconfig.base.json` sets
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` so `tsc` builds still emit
`.js` imports. Constraints: no enums/namespaces/parameter properties (non-erasable syntax).

**Alternatives.** vitest (great DX, but a second toolchain and dependency tree); jest +
ts-jest (CJS friction with the ESM SDK); compile-then-test (slower loop, two configs).

**Trade-offs.** No watch UI or coverage dashboard; a higher Node floor. Accepted: one
toolchain, zero extra dependencies, tests exercise the same files that ship.

---

## D17 — Basic auth header only; plain-HTTP stores are out of scope

**Context.** WooCommerce's own `WC_REST_Authentication` (verified in WooCommerce core source)
only runs `perform_basic_authentication()` when `is_ssl()` is true. Over plain HTTP it falls
back to OAuth 1.0a one-legged signing. Query-string `consumer_key`/`consumer_secret` are a
fallback *within* the SSL path, not a plain-HTTP mechanism.

**Decision.** The client sends credentials **only** as an HTTP Basic `Authorization` header
over the `WOOCOMMERCE_STORE_URL` the operator supplies, refuses to put credentials in URLs,
warns at startup when the store URL is `http://`, and recommends HTTPS. OAuth 1.0a signing is
**not implemented**; documenting the gap beats shipping an unverifiable signature scheme.

**Alternatives.** Query-string credentials — secrets in URLs, logs and proxies; rejected.
OAuth 1.0a — correct for plain HTTP but a substantial, hard-to-verify-in-CI addition;
recorded as future work if a plain-HTTP store is ever required.

**Trade-offs.** Local plain-HTTP WordPress installs will get HTTP 401 until the store is put
behind HTTPS (or the operator terminates TLS in front of it). Honest failure with a pointed
message beats silent credential leakage.

## D18 — The gateway validates tool arguments with ajv against the published JSON Schema

**Context.** Threat-model C5 requires validating tool inputs *against the registered schema*
**before** any outbound call, so unexpected arguments (e.g. an extra `status` filter) never
reach a WooCommerce query string. The gateway learns schemas from MCP `tools/list`, which
publishes **JSON Schema**, not zod. zod v4 cannot parse JSON Schema, and the SDK's
zod → JSON Schema conversion is one-way. Writing this down matters because C5's original
wording ("validated with zod") is not literally implementable at the gateway layer.

**Decision.** The gateway compiles each tool's published `inputSchema` with **ajv** (already
in the dependency tree transitively, MIT, zero audit findings) and rejects invalid arguments
with `McpError -32602` *before* creating any upstream request. The upstream MCP servers keep
validating with their own zod schemas (Milestone 1 behavior unchanged) — two validators on
the same contract, one per side.

**Alternatives.** (a) Forward blindly and let upstreams validate — loses the "before any
outbound call" property entirely; a misbehaving upstream would receive arbitrary arguments.
(b) Duplicate each upstream's zod schemas in the gateway — two sources of truth that drift
the moment an upstream changes; defeats the reason the gateway consumes *published* schemas.
(c) Use a zod-from-JSON-Schema converter package — an extra, less-standard dependency for
what ajv already does well.

**Trade-offs.** ajv becomes a declared direct dependency (it was already installed; `npm
audit` stays clean). Two validators exist in the system, but they cannot disagree about the
*contract*: the gateway validates against the exact schema the upstream itself published.
If ajv accepts something zod rejects (or vice versa) the upstream still runs its own check as
the final word — the gateway validation is a fast pre-filter, not a replacement.

## D19 — Gateway scripts build `@mcp/shared` first (the D14 follow-through)

**Context.** D14 observed that npm workspaces do **not** run scripts in topological order, so
a consumer of `@mcp/shared`'s `dist/` must build it explicitly. `woocommerce-mcp` sidestepped
this by not importing shared at all, but the gateway is shared's intended consumer: routing
uses `UPSTREAM_IDS`, the contract check uses `WOOCOMMERCE_TOOLS`, and the public types come
from `AggregatedTool`/`UpstreamConfig`/`UpstreamHealth`.

**Decision.** Every script in `apps/gateway/package.json` that touches TypeScript
(`build`, `typecheck`, `test`) starts with `npm run build -w @mcp/shared && …` — one cheap,
deterministic `tsc` before the real work.

**Alternatives.** (a) Don't import shared — redeclare `UPSTREAM_IDS` in the gateway, which is
exactly the drift D14 was written to prevent. (b) `prepare`/`prepack` hooks — invisible
machinery that surprises people and misbehaves with `--ignore-scripts`. (c) Only a root-level
orchestration script — but developers (and CI) run workspace scripts directly too.

**Trade-offs.** `@mcp/shared` is rebuilt several times per `npm run check` run; it compiles
in well under a second, so the redundancy costs little and removes the "works only if you
remembered to build first" trap.

## D20 — Upstream availability policy: last-known tools stay published while an upstream is down

**Context.** § 9.2 requires that when the WooCommerce MCP server is down its tools return
structured errors while every other upstream keeps working — and the learning guide's Stage 3
checkpoint phrases the same promise as: *the gateway still serves the other upstreams' tools*.
That leaves a design question for `tools/list` itself: does a dead upstream make its tools
vanish immediately?

**Decision.** Tool lists are cached per upstream for `TOOL_CACHE_TTL_MS` (default 60 s).
A discovery failure **keeps the last-known list** for that upstream (calls against it then
fail structurally: `unreachable` / `did not respond within N ms`, always without internal
URLs — threat-model C8). An upstream that has **never** answered is omitted from `tools/list`
but still returns a structured error if called by name. `/readyz` reports per-upstream
reachability without ever failing the gateway itself.

**Alternatives.** (a) Fail the whole `tools/list` if any upstream is down — one flaky
upstream breaks every client; violates isolation. (b) Evict tools the moment a refresh fails
— the tool list flaps, breaking cached clients, docs and dashboards during blips. (c) Cache
forever — stale schemas and dead tools accumulate; rejected.

**Trade-offs.** After an outage that overlaps a schema change, the gateway can validate
against a slightly stale schema until the TTL expires (the upstream's own validation is still
the final word, so nothing unsafe is forwarded). Availability with honest `/readyz` reporting
beats a tool list that flaps with every network hiccup.

## D21 — Operational probes stay unauthenticated (the B2 exception)

**Context.** Threat-model boundary B2 says nothing crosses without authentication. The
gateway's `GET /healthz` and `GET /readyz` are consumed by container orchestrators and load
balancers *before* any credentials exist — Kubernetes liveness/readiness probes cannot
present an API key.

**Decision.** `/healthz` and `/readyz` remain public; every other route — `/mcp`, all of
`/api/*` — sits behind the fail-closed auth middleware (`createAuthMiddleware`,
`test/auth-middleware.test.ts: "operational probes stay public"`). The probes expose
aggregate operational state only (process liveness, session counts, per-upstream
reachability); they reveal no tool data, no user data and no configuration secrets.

**Alternatives.** (a) Authenticate the probes too — breaks every orchestrator probe spec
(no credential channel exists for kubelet) and the Docker healthcheck. (b) Bind probes to a
separate port without auth — two listeners, two port configs, more to get wrong; rejected as
complexity without a security gain given the payload is status-only.

**Trade-offs.** An unauthenticated caller can learn liveness and upstream reachability.
That is a deliberate, narrow information disclosure in exchange for operability; the payload
is documented as aggregate status and must stay that way (adding detail to probes would
re-open this decision).

## D22 — Audit rows carry an `action` dimension (additive contract change)

**Context.** Threat-model C6 fixes the audit columns (`occurred_at, key_id, user_id, role,
upstream_id, tool_name, qualified_name, outcome, duration_ms, error_code`) with
`outcome ∈ {success, error, timeout, denied}`. Milestone 3 needs rows for things that are
not tool calls at all — a failed key presentation, an admin-API 403, key issuance and
revocation — and architecture §5.4's "exactly one audit row" rule needs to distinguish a
denied *call* from a denied *request*.

**Decision.** One append-only table gains an `action` column:
`tool_call | auth_failed | access_denied | key_created | key_revoked`
(`AuditAction` in `packages/shared`). Every row still carries the original C6 columns;
`outcome` keeps its C6 meaning inside each action. The change is **additive** — existing
column contracts are untouched — and it was explicitly sanctioned by the assignment's
instruction to extend shared contracts where authentication, authorization, auditing, API
responses or key lifecycles require it.

**Alternatives.** (a) Overload `tool_name`/`error_code` to smuggle the row kind — greppable
only by convention, un-indexable; rejected. (b) Separate tables (auth_events, tool_calls) —
two writers, two retention policies, and forensics wants one timeline; rejected for now
(review at the 10M-rows question, learning-guide Stage 4).

**Trade-offs.** One more column to keep in sync across gateway, dashboard (M4) and any
exporter; the conservative charset sanitization (`action` is enum-checked by the DB) keeps
it injection-safe. With `id BIGSERIAL` plus `occurred_at DESC` indexing, the audit reader
uses keyset pagination (never OFFSET), which is the honest answer to "your table has 10M
rows".

## D23 — Dashboard sessions: httpOnly cookie holding a random token, never the API key

**Context.** Milestone 4 needs a browser login. The assignment forbids privileged keys in
frontend source/build variables, plaintext keys in `localStorage`/`sessionStorage`/URLs,
and — implicitly — any weakening of `/mcp`'s Bearer-only contract. The dashboard also has
no SSR layer (plain Vite SPA), so "sessions" means either client-stored secrets or a
server-verified cookie.

**Decision.** `POST /api/auth/login` accepts `{ "key": "umk_…" }` **in the JSON body**
(never a URL/query/header). The key is verified through the same
`sha256(key‖pepper)` + `timingSafeEqual` path as every other request (extracted to
`src/auth/verify.ts` so middleware and login cannot drift). On success the gateway:

1. generates 32 random bytes (base64url) as the session token,
2. stores **only** `sha256(token)` as the `web_sessions` primary key, bound to the key's
   `user_id`/`key_id`, with a 12-hour `expires_at`,
3. returns `Set-Cookie: urumi_session=<token>; HttpOnly; SameSite=Strict; Secure; Path=/`.

Subsequent `/api` requests authenticate from that cookie. The middleware honors the cookie
**only** when (a) the path starts with `/api` (so `/mcp` stays Bearer-only, exactly as
before), (b) no `Authorization` header is present (a malformed Bearer never falls back to
the cookie), and (c) a `sessions` repository exists. `/healthz`, `/readyz` and
`POST /api/auth/login` remain the only public routes (D21 extended by one entry — login
must be reachable by an unauthenticated client by definition). Logout deletes the session
row *before* clearing the cookie. Revoking the underlying API key kills future sessions
too, because `verifySession` re-checks the key's `revoked_at` on every request.

**Alternatives.** (a) Store the API key itself in a cookie or localStorage — rejected:
plaintext key in the browser violates the assignment, and `HttpOnly` protects a *key*
worse than a *token* (a key is reusable forever; a token expires and is server-revocable).
(b) JWT sessions — rejected: no signing-key management, no server-side revocation without
adding a denylist (which is a table with extra steps), and the session store is one
primary-key lookup. (c) Bearer header re-sent from JS each request — rejected: the key
would live in JS-reachable storage by necessity.

**Trade-offs.** Sessions are server state: a database outage fails logins and sessions
fail closed (`503`, same posture as C6 write-ahead). 12 hours is a fixed TTL with no
"remember me" and no sliding refresh — chosen for an admin tool, not a consumer app.
`Secure` is set even in dev (localhost counts as trustworthy); a browser that refuses
`Secure` cookies over plain HTTP would need a dev exception we deliberately did not add.
Cookie auth is honored under `/api` only, which is a narrower exception than "all non-MCP
routes" and is asserted by tests (`test/auth-middleware.test.ts`).

## D24 — Upstream enable/disable persists in PostgreSQL, applied as a registry override

**Context.** Milestone 4's toggle cannot be environment-variable-only (a browser cannot
restart the gateway) and cannot be in-memory-only (the assignment requires documenting
restart persistence). Upstream *URLs* remain configuration (C4: clients never choose
where a connection points), but the on/off bit is an operational state that belongs to
the admin API.

**Decision.** Fixed table `upstream_overrides (upstream_id PK CHECK ∈
{woocommerce, inventory, support}, enabled, updated_at, updated_by → users)`. The toggle
endpoint (`POST /api/upstreams/<id>:enable|disable`) runs a strict sequence:

1. admin gate (`requireAdmin` → `access_denied` audit row on refusal),
2. validation: well-formed spec (400) → id in the fixed `UPSTREAM_IDS` set (400
   `unknown_upstream` — never an arbitrary URL/connection target) → upstream actually
   configured in this deployment (409 `upstream_not_configured`),
3. idempotent no-op if already at the target state (`changed: false`, no audit row),
4. **persist first** — if the `upstream_overrides` write fails, the registry is untouched
   (500 + audit row with `outcome: error`, `error_code: persist_failed`),
5. apply `registry.setEnabled(id, enabled)` second (failure → 500 + `apply_failed`),
6. exactly one `upstream_enabled`/`upstream_disabled` audit row (D22's additive actions).

On boot, `index.ts` reads all overrides and applies them **before** the first
`registry.refresh()`; a failed override read is fatal at startup (fail closed — the
gateway never starts in a state that contradicts its own audit trail).

**Alternatives.** (a) SIGHUP-style env reload — impossible for a browser-driven action
without a file the pod does not have. (b) In-memory only — simpler, but a restart would
silently re-enable a disabled upstream while the audit log says otherwise; rejected. (c)
Persisting the URL itself or letting the API accept a URL — rejected outright (C4 SSRF:
clients select *which configured upstream*, never *where it points*).

**Trade-offs.** Two sources of truth exist (env vars seed the registry, DB overrides
refine it) — resolved by a documented precedence: DB override wins when present. Disable
does not stop an in-flight call (no cancellation race introduced); it changes discovery
(`tools/list` shrinks) and rejects subsequent `tools/call`. Because `enabledOverride` is
a distinct field from `state.config.enabled`, unset-env and admin-disabled remain
distinguishable (`configured` vs `enabled` in `GET /api/upstreams`), and a disabled-via-
DB upstream still reports honestly if its URL is missing.

## D25 — Inventory and Support ship as independent seeded-demo MCP servers; registration stays config-only

**Context.** Milestone 5 must prove the architecture's central claim — *adding an upstream
requires no gateway code changes* — under the assignment's fixed constraints: ₹0 budget, no
paid or unreliable third-party APIs, and an explicit rule against faking a live integration.
No real inventory system or helpdesk is available on this machine (the same honest position
as the missing WooCommerce store), and the four new tool names
(`inventory_list_products`, `inventory_adjust_stock`, `support_list_tickets`,
`support_create_ticket`) are already pinned by docs §5.3 and gateway tests.

**Decision.** Two new *processes*, not modules:

1. `services/inventory-mcp` and `services/support-mcp` mirror the shape proven by the
   WooCommerce server (official SDK, Streamable HTTP at `/mcp`, per-session servers,
   probes, draining, redacting logger, fail-fast env) and change only their domain: a
   deterministic seeded store behind an injectable seam (`InventoryDataSource` /
   `SupportDataSource`, plus an injectable clock for ticket timestamps) and exactly two
   tools each. Ports 8083/8084 match the `.env.example` placeholders.
2. **Seeded demo data is labelled as such, everywhere** — tool descriptions, server
   instructions and every payload carry `source: "seeded-demo"`; nothing in the repo may
   read as a real warehouse or ticketing integration. State lives in memory and resets on
   restart, which is honest for a demo and documented as a limitation.
3. Registration is strictly configuration: `INVENTORY_MCP_URL` / `SUPPORT_MCP_URL` flow
   through the existing `UPSTREAM_URL_ENV` map; discovery, prefix routing, timeouts,
   failure isolation, authorization and audit are reused untouched (the milestone's diff
   under `apps/gateway/src` is empty).
4. Grants (C5) are treated as a *separate layer* from registration: the test harness's
   static grants cover the new tools so both allowances and denials are verified, while
   migration 001's fail-closed seed ("unknown tools fail closed until a grant is added on
   purpose") is left unchanged — no migration was edited or added in M5, because seed
   grants are per-principal ops SQL, not routing, and `test/integration/postgres.test.ts`
   pins the seed as shipped.
5. Verification happens at two altitudes: fake upstreams (fast, controllable) for routing
   semantics, and **spawned real server processes** (`test/real-upstreams.test.ts`, with a
   mock WooCommerce REST store standing in for the paid API) for the full path — payload
   provenance, one audit row per call, runtime disable, and SIGKILL isolation with no
   host/port/URL leakage.

**Alternatives.** (a) One combined "demo sources" server exposing all four tools — rejected:
it would prove nothing about multi-upstream routing and would couple two upstreams into one
failure domain. (b) Backing the stores with a real free-tier inventory/helpdesk API —
rejected: it violates the spirit of "no paid APIs", adds network flakiness, and still could
not honestly be called *your* inventory system. (c) Copying `@mcp/shared` into the servers
or sharing domain code with the WooCommerce server — rejected: the servers stay independent
processes that share only the SDK/zod/express stack, which is what makes the "new upstream"
claim meaningful. (d) Extending the migration seed with inventory/support grants in the
same milestone — rejected as scope creep across a pinned contract (see Decision 4 above);
recorded as a remaining requirement instead.

**Trade-offs.** Duplicated server scaffolding across three services (accepted: process
isolation and independent deployability are the point; the duplication is small and each
copy is fully tested). In-memory state means writes evaporate on restart (documented). The
seed-grant deferral means a fresh deployment publishes the new tools but the demo users
cannot call them until grants are added on purpose — fail-closed by design, surfaced in the
READMEs and the milestone report rather than papered over. Process-to-process tests spawn
three Node children, so the gateway suite costs a few hundred milliseconds more than fakes
alone — negligible next to what they prove.

---

## D26 — Docker images: pinned alpine bases, repo-root context, runtime-only config

**Context.** Milestone 6 wraps the five deployables in images without changing any
service contract, and without pretending that a successful `docker build` proves
deployment (that is Milestone 7's job).

**Decision.**
- `node:26.7-alpine` (minor-pinned; matches the Node 26 runtime the suites run on —
  D13's "the lockfile is the real guarantee" covers npm dependencies, the tag pins the
  OS/runtime layer) for the four Node services, and
  `nginxinc/nginx-unprivileged:1.30-alpine` for the dashboard: the unprivileged
  flavour runs as uid 101 out of the box, so non-root is the image's default rather
  than a patched-afterthought.
- One build context — the repository root, trimmed by a single root `.dockerignore`
  (tests, docs, `.env*`, `node_modules`, `dist` never reach the context). npm
  workspaces resolve exactly as on the host, and the four Node Dockerfiles share a
  byte-identical `deps` stage so the builder caches a single `npm ci` layer across
  all images.
- Each final stage proves its own dependency closure: a fresh base runs
  `npm ci --omit=dev --workspace=@mcp/<name>`, so a production import missing from
  the lockfile breaks the *build* instead of the container. The final image holds
  ~29 MB of production-only `node_modules` — no typescript, no vite.
- Zero configuration baked in: hosts, ports, upstream URLs, pepper and database URL
  arrive via `docker run -e …`; healthchecks read the same env vars the app does;
  unconfigured runs exit 1 with the exact missing-variable list (fail-safe, not
  fail-weird).
- The dashboard's `/api` proxy is optional at runtime (`GATEWAY_UPSTREAM` unset ⇒
  scripted 503), because architecture §8 gives `/api` to the Ingress in Kubernetes —
  the proxy exists for plain-Docker use, and its startup-time DNS resolution is
  documented as a limitation rather than hidden.

**Trade-offs.** Local tags only (`urumi/<name>:0.1.0`): pushing to a registry has no
consumer before M7 and would put distribution into the critical path of a building
milestone. `npm ci` runs twice per image (full in `deps`, prod-only in `runtime`) in
exchange for the shared cache layer and a minimal final layer — copying
`node_modules` out of the builder instead would defer dependency errors to runtime.
The legacy builder (Docker 29 deprecation warning) was used because the Dockerfiles
avoid BuildKit-only syntax, so installing `docker buildx` later changes nothing.

## D27 — Helm chart: bare service names, Recreate+PVC Postgres, init-container migrations, secrets split by environment

**Context.** Milestone 7 deploys the six Milestone 6 images (plus PostgreSQL and a labelled
mock store) onto the existing kind cluster. The chart has to express startup ordering without
`depends_on`, keep database state across pod and node restarts, keep every credential out of
git, and stay honest about what a production operator must still supply.

**Decision.**
- **Bare resource names** (`gateway`, `woocommerce-mcp`, `postgres`, …) exactly as
  architecture §8 maps them, so every URL in the system is plain service DNS
  (`http://woocommerce-mcp:8081/mcp`, `postgres:5432`); release identity lives in labels,
  and the documented contract is one release per namespace. A config-only registration
  model (D25) extends naturally: adding an upstream is a Service + a URL, never a code change.
- **PostgreSQL = Deployment + PVC + `strategy: Recreate`.** One `ReadWriteOnce` volume must
  never back two servers (a rolling update would briefly do exactly that), and Recreate is
  the smallest honest way to say so. The official image's entrypoint starts as root to
  initialise the data directory and then drops the server process to `postgres` — the chart
  therefore does *not* set `runAsNonRoot` on that one pod, and says why, instead of shipping
  a setting that breaks the deploy.
- **Migrations run in the gateway's init container**, not as Helm hooks. The runner tracks
  applied files in `schema_migrations` (already idempotent), so every pod start re-runs it
  safely and upgrades apply new files automatically; hooks would run only at install/upgrade
  and would need delete-policy ceremony. The init container also receives
  `MCP_APP_DB_PASSWORD`, so the same pass creates the least-privilege `mcp_gateway_app` role
  (D7) that the runtime then uses via `DATABASE_URL` — the admin URL exists only in the init
  container.
- **No blocking wait for MCP upstreams.** The gateway's startup refresh already tolerates
  unreachable upstreams (`/readyz` reports them per-upstream) and `toolsFor()` re-fetches on
  TTL expiry, so the first `tools/list` after a start race self-heals. An init/wait container
  would have made the *gateway* depend on *every* upstream — the opposite of D25's isolation.
- **One Secret, seven keys named after the env vars they feed.** Local values render it from
  obvious `local-dev-only-…` placeholders; production sets `secrets.create=false` and points
  `existingSecret` at a Secret created outside the chart. Key material is generated inside
  the gateway pod (`generateApiKey` + the pepper from the Secret) and inserted via the admin
  connection — the pepper never appears in values, git, or pod logs.
- **Numeric `runAsUser`/`runAsGroup` pinned in the chart** (1000 for the `node` images, 101
  for nginx). The kubelet refuses `runAsNonRoot` when the image declares a *named* `USER`,
  which the first install proved; pinning the IDs the images already use makes the
  non-root posture explicit instead of implicit.
- **The mock store is a first-class, clearly-labelled workload** (ConfigMap script on
  `node:26.7-alpine`, ClusterIP, disabled in production values), configured with the *same*
  Secret keys as `woocommerce-mcp` so it can only accept exactly the credentials the server
  was given. Production points `woocommerceMcp.storeUrl` at the real store instead.
- **Access and exposure follow the cluster we actually have.** kind was created without
  extra port mappings and must not be recreated, so the documented demo path is
  `kubectl port-forward`; local values still create the NodePorts the pinned plan called
  for (reachable inside the VM network). The three MCP servers, PostgreSQL and the mock get
  hardcoded ClusterIP services — not a value an operator can flip to `LoadBalancer`. The
  dashboard's `GATEWAY_UPSTREAM` proxy is on locally (one port-forward serves UI + API) and
  off in production values, where the Ingress owns `/api` per §8. Ingress TLS and
  NetworkPolicy ship as *integration points* (TLS off until a real certificate exists;
  NetworkPolicy on in production values with a documented "requires an enforcing CNI" note,
  because Kind's kindnet does not enforce).

**Trade-offs.** Bare names forfeit side-by-side releases in one namespace (labels keep Helm's
bookkeeping intact; namespaces are the isolation boundary anyway). `Recreate` means a
brief database outage on upgrade — the correct trade for a single-RWO Postgres that must not
run twice. The chart carries no Helm `test` pods or hook-based smoke tests: the verification
walkthrough in `infra/helm/README.md` (lint, template review, server dry-run, live e2e,
restarts) is the source of truth, because it exercises real authz and persistence rather than
a pod that only proves HTTP 200.

## D28 — Milestone 8 security posture: default-deny SSRF allow-list, in-memory per-process limits, opt-in trust proxy

**Context.** The threat model's remaining controls (C3 extensions, C4, C7, C8 and the B1
hardening) had to be implemented without breaking the documented local, Docker and kind
flows, without new dependencies, and with tests that fail when a control is removed.

**Decision.**

- **C4 SSRF guard defaults to deny.** `UPSTREAM_ALLOWED_PRIVATE_HOSTS` starts empty, so a
  literal non-routable upstream address (loopback, RFC1918, link-local/metadata, CGNAT,
  IPv6 equivalents) is refused at boot and a hostname resolving privately is refused at
  connect time. Every documented flow carries its allow-list: `.env.example` and the local
  Helm values allow the loopback/service names they need; the production values allow only
  the three in-cluster service DNS names. The literal `*` is a documented development
  escape hatch, never a production value. The classifier runs on WHATWG-normalized
  hostnames, so decimal/hex IPv4 encodings cannot smuggle loopback.
- **Redirects are refused cross-origin by the MCP SDK transport itself** — no separate
  redirect hop-count was added; a same-origin redirect stays on the (already checked)
  configured host, and a cross-origin `Location` is never followed (tested).
- **Response-size cap rides the SDK's pluggable fetch** (`createCappedFetch`): Content-Length
  rejected up front, chunked bodies aborted mid-stream, default 10 MiB, 0 disables.
- **C7 limits are in-memory and per-process** (token buckets for per-key tool calls and
  per-IP failed logins; a semaphore per upstream). That is correct for the single-replica
  deployments this milestone validates; a multi-replica gateway needs a shared store and
  gets none silently — documented as a limitation instead of half-implemented.
- **`TRUST_PROXY` is opt-in** (default 0). The login throttle keys on `req.ip`; the Helm
  values set 1 hop so the dashboard's nginx forwards the real client IP, and the
  production values note that an extra Ingress hop means 2.
- **B1 host allow-listing uses the downward API.** Each internal MCP server gets
  `MCP_ALLOWED_HOSTS=$(POD_IP),<service>,<service>.<ns>.svc.cluster.local` — the pod IP
  (expanded by kubelet before the process starts) keeps the HTTP probes working, the
  service names keep the gateway working, and everything else gets 403. The gateway
  itself stays off this list: it is authenticated and must remain reachable through
  port-forward and NodePort with `localhost` Host headers.
- **C8 least privilege:** every workload gets its own ServiceAccount with
  `automountServiceAccountToken: false`, asserted by `scripts/security/assert-helm-security.sh`
  (wired into `check.sh`) so a regression fails the build, not the review.
- **Body-size limit is injected into the SDK's own parser.** `createMcpExpressApp` mounts
  `express.json()` with its defaults at creation; the gateway wraps `express.json` for the
  duration of that call so the parser is created with `JSON_BODY_LIMIT` (default 100kb —
  unchanged from body-parser's default) and restores it immediately. No second parser, no
  SDK fork.

**Trade-offs.** Default-deny means a fresh `.env` copied from an older README snippet fails
to boot with a message naming `UPSTREAM_ALLOWED_PRIVATE_HOSTS` — deliberate: the fix is one
env var, the failure mode it prevents is a gateway connecting to a cloud metadata service.
The `$(POD_IP)` trick couples the chart to Kubernetes env expansion (documented in the
template). The `express.json` wrap touches a module export for two synchronous statements —
contained, commented, and covered by the 413 tests; the alternative (forking the SDK app
assembly) costs more than it protects.

---

## D29 — Chat agent provider: Groq-compatible OpenAI adapter, optional and off-by-default

**Context.** Milestone 9 needs a real LLM behind `POST /api/chat`. Budget is ₹0, so no
paid provider; the repo's existing plan (README components, D11) names the **Groq free
tier** as the default. Local models must stay possible for contributors without a key.

**Decision.**
- One provider implementation: `OpenAiCompatProvider` (apps/gateway/src/agent/provider.ts)
  speaks the OpenAI chat-completions shape with an injected `fetch`, so Groq works out of
  the box (`LLM_BASE_URL` defaults to `https://api.groq.com/openai/v1`, model
  `llama-3.3-70b-versatile`) and any local OpenAI-compatible server (e.g. Ollama) works by
  overriding `LLM_BASE_URL` alone — no API key required for local.
- Server-side env only: `GROQ_API_KEY`, `GROQ_MODEL`, `LLM_BASE_URL`,
  `LLM_REQUEST_TIMEOUT_MS` (45s). The key never reaches the dashboard bundle, API
  responses, audit rows, or logs (`safeConfigSummary` records presence only).
- The agent is **optional**: with no key and no base URL, `buildLlmConfig()` returns
  `null`, the app boots normally, and `/api/chat` answers `503 agent_not_configured`.
  Nothing is stubbed or fabricated (same policy as the empty-workspace rule).
- Provider failures map to coarse kinds (`rate_limited`/`timeout`/`unavailable`/
  `rejected`/`malformed`) → HTTP 429/504/502 with generic messages; provider bodies are
  never echoed to clients (L4). No automatic retries — free-tier limits would amplify them.
- The live-provider smoke test is the opt-in `scripts/llm-smoke.sh` (skips cleanly with
  exit 0 when the target gateway URL or its API key is unset; the Groq key is the
  *gateway's* input — env var or Kubernetes Secret — and is never read or printed by the
  script); it is deliberately **not** part of
  `scripts/check.sh`, so the automated suite never depends on a third party.

**Trade-offs.** Chat-completions (not responses/streaming) keeps the client tiny and the
test suite fully mockable via `ScriptedProvider`, at the cost of no streaming — text
appears only after the bounded loop finishes. Pinning a default model name can break if
Groq retires the model; the env override and honest 502 mapping are the chosen mitigation
rather than a hardcoded fallback list.

---

## D30 — One tool-execution pipeline for `/mcp` and the chat agent

**Context.** The agent must call gateway tools, but a second execution path would double
the authorization, audit and SSRF surface — and a loopback HTTP self-call would defeat the
C4 allow-list (the gateway's own host is not on it) while failing to reuse the caller's
principal.

**Decision.**
- Extract `executeToolCall()` (apps/gateway/src/tool-executor.ts): C7 per-key rate
  limiting → C5 authorization (role ceiling + grants) → registry lookup + zod validation →
  SSRF/caps/timeouts → exactly **one** audit row per attempt → bounded result. Both the
  `/mcp` transport handler and the chat agent loop call this function.
- The agent executes as the **authenticated dashboard principal** (session cookie →
  keyId/role/grants), and the tool list offered to the model is pre-filtered through the
  same `authorize()` used at execution time. Outcome labels in the API response
  (`success`/`error`/`denied`/`invalid`) are computed server-side, never taken from the
  model's prose.
- `/mcp` request semantics are unchanged (shared-pipeline refactor covered by the full
  pre-existing gateway suite); MCP framing, session auth and error envelopes stay where
  they were.

**Trade-offs.** The agent cannot run "as itself" with a dedicated key (an earlier shape in
§9.3) — using the caller's principal is simpler, attribution is natural (audit rows name
the user), and revocation is one key revocation. The cost: chat availability is coupled to
the caller's session, and a future autonomous agent would need a service principal added
deliberately.
