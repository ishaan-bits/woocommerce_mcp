# Architecture — MCP Gateway with WooCommerce

> **Status: design document. Nothing described here is implemented yet**, except where the
> [Implemented today](#10-implemented-today-vs-planned) section says so.
> Audience: a backend beginner preparing for a technical interview. Read top to bottom.

---

## 1. What we are building and why

**Goal:** one safe, uniform doorway that lets AI clients (chat agents, IDEs, dashboards) use
several backend systems as *tools*, instead of every client integrating each system separately.

Today the doorway only needs to reach a WooCommerce store. Later it also reaches an inventory
system and a support system. The doorway is called the **MCP Gateway**.

**The four words you need on day one:**

| Word | Plain-English meaning |
| --- | --- |
| **MCP** | *Model Context Protocol* — an open standard (JSON-RPC over HTTP or stdio) that defines how an AI application discovers and calls "tools" living in another program. Think: USB-C for AI-to-tool connections. |
| **MCP server** | A program that *offers* tools ("list products", "get order"). |
| **MCP client** | A program that *consumes* tools — usually an AI host such as a chat app or IDE. |
| **Gateway** | One service that plays **both roles at once**: it is an MCP *server* to its users and an MCP *client* to the systems behind it. |

**Non-goals for now:** no LLM, no API keys for AI services, no paid anything, no Kubernetes
manifests yet (those are later milestones).

---

## 2. The components and what each one is for

```text
                        ┌──────────────────────────────────────────┐
   MCP clients          │              MCP GATEWAY                │
  (dashboard chat,  ───►│  /mcp  ── MCP server (downstream)       │
   IDE, scripts)        │            │                            │
                        │            ▼ aggregation / authz /      │
   Dashboard UI    ───► │  /api  ── REST backend   routing / audit│
   (React + Vite)       │            │                            │
                        │            ▼ MCP client (upstream)      │
                        └────────────┼────────────────────────────┘
                                     │  Streamable HTTP
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     ┌─────────────────┐   ┌──────────────────┐   ┌─────────────────┐
     │ woocommerce-mcp │   │  inventory-mcp   │   │   support-mcp   │
     │  (built by us)  │   │  (independent)   │   │  (independent)  │
     └────────┬────────┘   └────────┬─────────┘   └────────┬────────┘
              │ WooCommerce REST    │ own data              │ own data
              ▼                     ▼                       ▼
        WooCommerce store       PostgreSQL              PostgreSQL
```

| Component | Directory | Purpose |
| --- | --- | --- |
| **Gateway** | `apps/gateway` | The single doorway. Authenticates callers, aggregates tools from upstreams, routes each call, enforces timeouts, writes audit logs. Also hosts the REST API the dashboard UI talks to. |
| **Dashboard** | `apps/dashboard` | React + Vite UI: chat window, tool list, upstream on/off switches, audit log viewer. It is a *client* of the gateway, not an MCP server. |
| **WooCommerce MCP** | `services/woocommerce-mcp` | **We write this.** Translates MCP tool calls into WooCommerce REST API calls. Owns the WooCommerce credentials. |
| **Inventory MCP** | `services/inventory-mcp` | Independent server. Proves the gateway is generic: registering it must require no gateway code changes. |
| **Support MCP** | `services/support-mcp` | Independent server, same reasoning as inventory. |
| **Shared** | `packages/shared` | Contract types only — tool names, roles, audit-log shape, upstream config shape. One definition imported everywhere so the pieces cannot silently drift apart. |
| **Infra** | `infra/docker`, `infra/helm` | Container images and Helm charts (later milestone). |
| **Docs** | `docs` | This file, plus decisions, threat model, learning guide. |

**Why a monorepo?** One `npm install`, one `git clone`, one place to see the whole system.
For a single-person project the coordination cost of several repositories would exceed any
benefit. (Recorded as decision D1 in [decisions.md](./decisions.md).)

---

## 3. MCP clients, MCP servers, and the gateway

### 3.1 The protocol in one paragraph

MCP uses **JSON-RPC 2.0** messages. A session starts with `initialize` (both sides exchange
protocol version and *capabilities*), then the client may send `tools/list` to discover tools
and `tools/call` to run one. A tool has a `name`, a human `description`, and a JSON Schema
`inputSchema` describing its arguments. The description matters: an LLM reads it to decide
which tool to call.

### 3.2 The gateway is a server *and* a client

```text
Downstream direction  (who talks to us)   : gateway = MCP server  → endpoint /mcp
Upstream direction    (who we talk to)    : gateway = MCP client  → each MCP server
```

Concretely:

- **As an MCP server**, the gateway answers `initialize`, `tools/list`, `tools/call` for anyone
  holding a valid API key. The tool list it returns is *aggregated* from every enabled upstream.
- **As an MCP client**, the gateway holds one MCP session per upstream server, performs its own
  `initialize`, caches each upstream's tool list, and forwards `tools/call` requests to the
  right upstream.

Why both? Because without a gateway every client would need N integrations, N credential sets
and N retry policies. With a gateway there is one integration, one place to enforce
permissions, one audit trail. The trade-off is that the gateway becomes a single point of
failure — mitigated by timeouts and failure isolation (section 8).

### 3.3 Two different upstream protocols — deliberately

- **WooCommerce is not MCP.** It exposes a classic REST API. So *we* write an MCP server that
  wraps that REST API. We control the tool names and schemas.
- **Inventory and Support are MCP servers** (their own processes, their own `/mcp` endpoints).
  The gateway must treat them as *untrusted upstreams it merely connects to*, never as code
  paths inside the gateway.

That difference is exactly what makes the gateway's "upstream registry" design testable: adding
a fourth upstream later should be a configuration change, not a rewrite.

---

## 4. MCP over Streamable HTTP

MCP ships with two transport families:

| Transport | How it works | Used for |
| --- | --- | --- |
| **stdio** | Parent process spawns the server as a child; messages over stdin/stdout. | Local servers (e.g. an IDE plugging in a filesystem server). |
| **Streamable HTTP** | One HTTP endpoint. Client `POST`s JSON-RPC messages; server answers with a normal JSON response *or* upgrades to a Server-Sent Events (SSE) stream. A `Mcp-Session-Id` header keeps the conversation bound to one session. `GET` opens the server→client stream, `DELETE` ends the session. | Any remote server — which is what we need, because everything runs in Kubernetes. |

(An earlier remote transport, "HTTP + SSE", used two endpoints and is deprecated. We use the
current **Streamable HTTP** transport, defined in MCP spec `2025-03-26` and carried forward in
`2025-06-18`.)

**Why Streamable HTTP is the right choice here:**

1. **Network-native.** Kubernetes routes HTTP with Services and Ingress; stdio cannot be load
   balanced or exposed across pods.
2. **Session affinity without sticky logic.** The `Mcp-Session-Id` header lets us keep state
   per client, and later scale by storing session state deliberately rather than by accident.
3. **Both directions on one connection.** Server-initiated messages (progress updates, or
   later `notifications/tools/list_changed` when an upstream toggles) can flow back to the
   client on the open SSE stream, while ordinary request/response stays plain JSON.
4. **Firewall friendly.** A single HTTPS endpoint is far easier to secure than a second
   event-stream endpoint.

**Endpoint layout we will implement:**

```text
POST   /mcp   → JSON-RPC request  (initialize, tools/list, tools/call, ...)
GET    /mcp   → SSE stream for server-initiated messages (optional)
DELETE /mcp   → close session
```

Everything under `/mcp` requires an API key. The dashboard's browser UI does *not* speak MCP
for its admin screens — it uses `/api/*` REST (section 6).

---

## 5. Tool discovery, aggregation, naming collisions, and routing

These four ideas are the technical heart of the gateway.

### 5.1 Discovery

On startup (and on demand) the gateway connects to each **enabled** upstream as an MCP client,
completes `initialize`, and calls `tools/list`. The result — name, description, JSON Schema —
is cached in an in-memory **tool registry**, with a TTL and an explicit refresh hook (the
dashboard's "refresh tools" action).

The registry is the single source of truth for what the gateway will accept.

### 5.2 Aggregation

The gateway merges every upstream's tool list into one list and serves that merged list to
downstream clients. A downstream client therefore sees *one* server with, say, 12 tools,
instead of three servers with 5, 4 and 3.

### 5.3 Naming collisions

Our WooCommerce server must expose exactly these local tool names (assignment requirement):

```text
list_products   create_product   list_orders   get_order   update_order_status
```

But a future `inventory-mcp` could perfectly well expose its own `list_products`. If the
gateway forwarded bare names, the two would collide and routing would become ambiguous.

**Rule: the gateway publishes *qualified* names, built from the upstream id and the local
name, joined with an underscore:**

```text
local (upstream) name     published (downstream) name
─────────────────────     ──────────────────────────
list_products       →     woocommerce_list_products
get_order           →     woocommerce_get_order
list_products       →     inventory_list_products      (no collision)
create_ticket       →     support_create_ticket
```

Rules of the scheme:

- Prefixes come from a fixed upstream id (`woocommerce`, `inventory`, `support`), so the
  mapping is deterministic and reversible.
- On `tools/call`, the gateway splits on the first `_` against the *known* upstream ids — it
  never guesses from the raw string.
- Unknown prefix → structured `unknown tool` error, never a blind forward.
- Upstream-local names still keep their original form, satisfying the assignment.

**Alternative considered:** forward bare names and only qualify when a collision is detected.
Rejected: the published tool list would change shape depending on which upstreams happen to be
enabled, which makes clients and docs unstable. Recorded as decision D5.

### 5.4 Routing a call

```text
tools/call { name: "woocommerce_list_products", arguments: {...} }
   │
   ├─ 1. authenticate API key → principal (user, role, allowed tools)   → 401 + audit auth_failed
   ├─ 2. authorize: role ceiling + upstream grant + tool grant          → MCP -32003 / REST 403 + audit "denied"
   ├─ 3. validate arguments against the cached JSON Schema (ajv)        → -32602 + audit
   ├─ 4. strip prefix → upstreamId + local name; check upstream enabled → error + audit
   ├─ 5. forward over that upstream's MCP session with a timeout
   │        ├─ success → audit "success", return result
   │        └─ timeout/crash → audit "timeout"/"error", return structured error
   └─ 6. every path writes exactly one audit row
```

Step 5 is where **failure isolation** lives: the timeout is per call and per upstream, so a
hung WooCommerce call can never hold the whole gateway open (section 8).

---

## 6. The dashboard backend versus the MCP endpoint

Both live in the `gateway` process, but they are different surfaces for different consumers:

| | MCP endpoint | Dashboard backend |
| --- | --- | --- |
| Path | `/mcp` | `/api/*` |
| Protocol | MCP (JSON-RPC) | Plain REST + JSON |
| Consumer | AI clients, MCP SDKs, the future chat agent | The React dashboard |
| Jobs | tool discovery, tool execution | login/session, upstream enable/disable, audit-log queries, tool-list mirror, chat history |
| Typical verbs | `tools/list`, `tools/call` | `GET /api/upstreams`, `POST /api/upstreams/woocommerce:enable`, `GET /api/audit` |

**Why not one protocol for both?**

1. Browsers and MCP SDKs speak different dialects; forcing the dashboard through MCP would add
   a translation layer with no benefit.
2. The admin operations (toggle an upstream, read the audit log) are *not* MCP concepts — MCP
   has no "disable an upstream" primitive.
3. Keeping them separate lets us apply different rate limits and different schemas to each.

**The important invariant:** both surfaces share the *same* authentication, authorization,
tool registry and audit writer. The MCP endpoint is the only path that *executes* tools; the
REST backend only configures and observes. So there is exactly one place where a tool call can
happen, and exactly one place where it gets logged.

---

## 7. WooCommerce REST API and how our MCP server uses it

### 7.1 What the store exposes

WooCommerce (a WordPress plugin) publishes a REST API under:

```text
https://<your-store>/wp-json/wc/v3/...
```

Authentication uses a **consumer key** (`ck_...`) and **consumer secret** (`cs_...`) created in
the store admin (WooCommerce → Settings → Advanced → REST API) with a `read` or `read/write`
permission. On HTTPS the credentials are sent as HTTP Basic auth. The secret is displayed
exactly once at creation — that is why it belongs in a Kubernetes Secret, never in git.

Relevant endpoints:

| Our MCP tool | WooCommerce call | Notes |
| --- | --- | --- |
| `list_products` | `GET /wp-json/wc/v3/products` | pagination `page`/`per_page`, `search`, `status` |
| `create_product` | `POST /wp-json/wc/v3/products` | **write** operation |
| `list_orders` | `GET /wp-json/wc/v3/orders` | filter by `status`, `after`/`before` |
| `get_order` | `GET /wp-json/wc/v3/orders/{id}` | |
| `update_order_status` | `PUT /wp-json/wc/v3/orders/{id}` | body `{ "status": "..." }` |

### 7.2 How our MCP server sits in front of it

`services/woocommerce-mcp` is a thin, honest translator:

```text
MCP tools/call ──validate args──► WooCommerce REST call ──map response──► MCP result
                     │                       │
                     │                       └── credentials read from env/Secret,
                     │                           used only inside this process
                     └── wrong/missing args rejected BEFORE any HTTP call
```

Responsibilities of this server:

- Define the five tools with JSON Schemas (via zod) and clear descriptions for LLMs.
- Map tool arguments to REST query/body parameters — and map errors back to MCP error codes.
- Own the WooCommerce credentials. No other component ever sees them (threat-model control C3).
- Never invent data: if WooCommerce says `404`, the tool returns an error, not a mock.

Non-responsibilities: authentication of *gateway callers*, audit logging, aggregation — those
belong to the gateway. Keeping the boundary crisp is what lets the same server be reused by a
different client tomorrow.

---

## 8. Kubernetes, Docker, Helm — who does what

*None of this exists yet; it is planned for a later milestone. This section defines the words.*

| Concept | One-line responsibility | In our project |
| --- | --- | --- |
| **Docker image** | A frozen, versioned bundle of code + runtime. | One image per deployable: gateway, dashboard, three MCP servers, Postgres (official image). |
| **Pod** | The smallest deployable unit: one or more containers sharing a network and filesystem. | Each service runs in its own Pod so it can fail, restart and scale independently. |
| **Deployment** | Declares "keep N copies of this Pod running, rolling-update them safely". | `replicas: 2` for the gateway later; `1` for MCP servers initially. |
| **Service** | Stable virtual IP + DNS name that load-balances to a set of Pods (which may be replaced any moment). | `gateway` → `:8080`, `woocommerce-mcp` → `:8081`, `postgres` → `:5432`. Pod IPs are never hardcoded. |
| **Ingress** | Routes external HTTP(S) traffic to Services by hostname/path; usually terminates TLS. | One host: `/mcp` and `/api` → gateway, `/` → dashboard. |
| **Secret** | A small object holding sensitive data, mounted as files or env vars. | WooCommerce consumer key/secret, `API_KEY_PEPPER`, database password, (later) LLM key. Never in git, never in the image. |
| **ConfigMap** | Non-sensitive configuration. | ports, timeouts, upstream URLs. |
| **PersistentVolume / PVC** | Storage that survives a Pod restart. | PostgreSQL data. |
| **Helm** | A package manager for Kubernetes: a chart = templates + `values.yaml`. | One chart per environment style: `values-local.yaml` (kind/k3d, NodePorts, tiny resources) and `values-prod.yaml` (TLS, replicas, real limits). Helm is **mandatory** for this assignment. |

**Why Helm matters beyond convenience:** it is the mechanism that makes "same stack, two
environments" a config diff instead of two drifting copies of YAML.

**Environment status (updated 2026-10-21):** Colima (Docker engine), Docker CLI, kubectl, kind
and Helm **are installed**, and a local kind cluster `urumi-local` is running (created with
explicit approval for Milestones 6–7). No image has been built and no chart exists yet, so the
deployment milestones still have nothing real to describe — see the README prerequisites
section.

---

## 9. Request flows

### 9.1 Happy path — an MCP client calls `list_products`

```text
 Client                Gateway                    woocommerce-mcp           WooCommerce
   │                      │                              │                        │
   │ POST /mcp            │                              │                        │
   │ tools/list           │                              │                        │
   ├─────────────────────►│                              │                        │
   │                      │ lookup enabled upstreams,    │                        │
   │                      │ merge cached tool lists      │                        │
   │  [woocommerce_list_   │                              │                        │
   │   products, ...]     │                              │                        │
   │◄─────────────────────┤                              │                        │
   │                      │                              │                        │
   │ POST /mcp            │                              │                        │
   │ tools/call           │                              │                        │
   │ woocommerce_list_    │ 1. authn API key             │                        │
   │ products {page: 1}   │ 2. authz role + tool grant   │                        │
   ├─────────────────────►│ 3. validate args (zod)       │                        │
   │                      │ 4. strip prefix, check       │                        │
   │                      │    enabled + start timer     │                        │
   │                      │ 5. forward on MCP session    │                        │
   │                      ├─────────────────────────────►│                        │
   │                      │                              │ GET /wc/v3/products    │
   │                      │                              │ Basic ck_/cs_ (Secret) │
   │                      │                              ├───────────────────────►│
   │                      │                              │      200 [ ... ]       │
   │                      │                              │◄───────────────────────┤
   │                      │  result / structured error   │                        │
   │                      │◄─────────────────────────────┤                        │
   │                      │ 6. audit row (outcome, ms)   │                        │
   │  tools/call result   │                              │                        │
   │◄─────────────────────┤                              │                        │
```

### 9.2 Failure path — WooCommerce is down or slow

Nothing else changes. The gateway:

1. hits its per-upstream timeout (`UPSTREAM_TIMEOUT_MS`) and aborts;
2. returns a **structured tool error** (not a crash, not an empty success) so the LLM or user
   sees "woocommerce upstream timed out after 10s";
3. writes an audit row with `outcome: "timeout"`;
4. leaves every *other* upstream's tools fully usable — `inventory_list_products` still works;
5. marks the upstream unhealthy in the registry so the dashboard can show it red.

The gateway pod is never restarted because an upstream failed. A crashed *gateway* is a
different matter — that is what the Deployment's restart policy and (later) readiness probes
are for.

### 9.3 The dashboard chat agent (future)

The chat agent is **not a second integration**. It is an MCP client that happens to live next
to the gateway:

```text
 Browser ── React UI ──POST /api/chat──► Gateway
                                            │
                       ┌────────────────────┤
                       │ chat module: LLM   │  (Groq free tier later, or local Ollama)
                       │ decides: call      │
                       │ woocommerce_list_  │
                       │ products ?         │
                       └─────────┬──────────┘
                                 ▼
                 SAME tool registry → SAME authz → SAME routing → SAME audit log
                                 ▼
                        upstream MCP servers → WooCommerce
```

Key points for the interview:

- The agent's tool calls traverse the **same** registry, permission checks and audit writer as
  any external MCP client. There is no privileged back door.
- The agent authenticates as its own principal (its own API key / internal identity), so its
  calls are attributable and revocable like anyone else's.
- The LLM only *chooses* arguments; the gateway still validates them. A prompt-injected model
  cannot bypass schema validation, role checks or upstream allow-lists.
- No LLM is wired up in this milestone — this is the intended shape only.

---

## 10. Implemented today vs planned

### Implemented in Milestone 0 (verifiable now)

- Monorepo layout with npm workspaces; `npm install` resolves all six workspaces.
- `packages/shared` contract types — builds, type-checks and imports cleanly.
- This documentation set: `architecture.md`, `decisions.md`, `threat-model.md`,
  `learning-guide.md`, `README.md`, `.env.example`, `.gitignore`.

### Implemented in Milestone 1 (verifiable now)

`services/woocommerce-mcp` is a genuine MCP server built on the official TypeScript SDK,
serving **Streamable HTTP at `/mcp`** with these five tools:

| Tool | WooCommerce call | Kind |
| --- | --- | --- |
| `list_products` | `GET /wp-json/wc/v3/products` | read |
| `create_product` | `POST /wp-json/wc/v3/products` | write (not idempotent) |
| `list_orders` | `GET /wp-json/wc/v3/orders` | read |
| `get_order` | `GET /wp-json/wc/v3/orders/{id}` | read |
| `update_order_status` | `PUT /wp-json/wc/v3/orders/{id}` | write (idempotent per status) |

Also implemented: `/healthz` and `/readyz` probes; session lifecycle with capacity cap,
idle sweep and graceful draining; per-request timeouts via `AbortSignal`; a JSON logger that
redacts `ck_`/`cs_` credentials; environment validation that fails fast with one issue per
problem; and a **69-test suite** (`npm test`) that needs **no real store, no Docker and no
network** — a mock WooCommerce REST API plus the official SDK client over loopback exercise
the full MCP handshake, tool calls, validation failures and upstream error mapping.

**Honest gaps.** The server has **not** been verified against a real WooCommerce store (none
is available on this machine; see README). Basic auth requires the store to be served over
HTTPS (D17); `list_orders` accepts a single status per call because that is all the
WooCommerce endpoint supports.

### Implemented in Milestone 2 (verifiable now)

`apps/gateway` is both an MCP server (downstream) and an MCP client (upstreams), built on the
same official TypeScript SDK:

| Piece | Implementation |
| --- | --- |
| MCP server side | Streamable HTTP at `/mcp`, one SDK `Server` per session (D15 pattern); `tools/list` serves the aggregated registry, `tools/call` routes by prefix |
| MCP client side | one SDK `Client` + streamable-HTTP transport per upstream; lazy connect bounded by `UPSTREAM_CONNECT_TIMEOUT_MS`, per-call timeout via `RequestOptions.timeout` |
| Qualified naming (D5) | `woocommerce_list_products` etc. — split on the **first** known upstream prefix, so local names may contain underscores |
| Registry | discovers each upstream's tools with `tools/list`, caches them for `TOOL_CACHE_TTL_MS` (default 60 s), re-discovers when stale |
| Contract check (D14) | at discovery, warns `woocommerce_tool_contract_drift` if any of the five contract tool names disappears upstream |
| Pre-forward validation (D18) | ajv compiles each tool's **published** JSON Schema; invalid arguments are rejected with `McpError -32602` before any outbound call |
| Failure isolation (learning-guide Stage 3 checkpoint) | a timed-out upstream returns a structured `isError` result (`upstream '<id>' did not respond within N ms` — never an internal URL); other upstreams keep working; a stopped-but-known upstream keeps serving its last-known list for one TTL window; an upstream that never answered is omitted from `tools/list` yet still answers clearly if called by name |
| Probes | `/healthz` OK once listening; `/readyz` reports sessions plus per-upstream `reachable`/`last_error` **without** failing the gateway itself |
| Draining | `SIGTERM`/`SIGINT` stop new sessions, answer `503`, finish in-flight work, exit 0 |

Verified at that milestone by a **36-test suite** (grown to 77 + 5 PostgreSQL integration
tests by Milestone 3; `npm test -w @mcp/gateway`) using the official SDK client
against in-process fake upstreams over loopback — including an upstream that answers slowly
past the timeout, one that never accepts connections, and a disabled one — so the suite runs
with **no Docker, no network and no real upstream process**.

**Honest gaps.** Upstreams are enabled by setting `*_MCP_URL` environment variables;
dashboard-side toggles come in Milestone 4.
Rate limiting and bounded per-upstream concurrency (threat-model C7) are not enforced yet.
The gateway has **not** been run against the real `services/woocommerce-mcp` process — tests
use fake upstreams, and the live pairing belongs to Milestones 6–7.

### Implemented in Milestone 3 (verifiable now)

PostgreSQL-backed authentication, authorization and audit (threat-model B2/C1/C2/C5/C6):

| Piece | Implementation |
| --- | --- |
| Schema + migrations | `apps/gateway/migrations/001_init.sql` — `users`, `api_keys`, `audit_log` — applied by `npm run migrate` through a tracked `schema_migrations` table; seeds the two demo principals (`admin-demo`, `reader-demo`) with their grants |
| API keys (C1 / D8) | `umk_` + base64url(32 random bytes), shown **once** at issuance, stored as `sha256(key‖API_KEY_PEPPER)` hex plus a 12-char public prefix; constant-time verification (`crypto.timingSafeEqual`), **no caching**, so revocation binds on the next request |
| Auth middleware (B2) | fail-closed on missing / malformed / structurally invalid / unknown / revoked credentials — all with the *same* 401 body (no oracle), the exact reason recorded only in the audit row; a database outage answers 503 and denies (`service_unavailable`); `/healthz` and `/readyz` stay public per D21 |
| Authorization (C2 / C5) | check order: role ceiling (reader cannot reach write-verb tools) → upstream grant → exact `tools:<qualified>` grant, all derived from the authenticated principal; MCP denials answer `McpError -32003`, admin-API denials answer `403` and still write an `access_denied` row |
| Admin API | `GET /api/me`, `GET/POST /api/keys`, `POST /api/keys/:id/revoke` (idempotent), `GET /api/audit` (limit 1–100, keyset `before` cursor per D22) — admin-only, reader receives 403 |
| Audit writer (C6 / §5.4) | the single `createAuditWriter` path, awaited write-ahead, **exactly one row per tool call including denials**; `action` column per D22; fields sanitized (control characters stripped, 200-char cap, conservative error-code charset); plaintext keys, arguments and responses are never stored |
| Least-privilege DB role | migration runner creates `mcp_gateway_app`: `INSERT`+`SELECT` on `audit_log` (append-only), `SELECT` on `users`/`api_keys`, column-limited `UPDATE (revoked_at)` on `api_keys`, no `DELETE` anywhere |

Verified by a **77-test suite** (`npm test -w @mcp/gateway`) where fakes sit only at the
upstream and database edges, plus a **5-test PostgreSQL integration suite**
(`test/integration/postgres.test.ts`) that runs migrations, the auth middleware, the admin
API, the DB-role privilege checks and the full MCP exactly-one-audit-row flow against a
**real PostgreSQL 17** container. The integration suite runs when `TEST_DATABASE_URL` is
set and prints an explicit skip reason when it is not — it is never skipped silently.

**Honest gaps.** Two seeded local users only — there is no dashboard login/session yet
(Milestone 4), no rate limiting or bounded per-upstream concurrency (threat-model C7), and
key bootstrap in tests writes directly through the repository (production bootstrap tooling
is ops work). The integration suite has not been exercised against a managed PostgreSQL
with TLS; it runs against a disposable local container.

### Planned — deliberately **not** present yet

- Any source in `apps/dashboard`, `services/inventory-mcp` or
  `services/support-mcp` (package manifests only — no placeholder endpoints, so nothing can
  be mistaken for a working feature).
- Docker images, Kubernetes manifests, Helm charts (`infra/*` contain explanatory READMEs only).
- A real WooCommerce store's credentials, LLM integration, dashboard login/session,
  rate limiting / bounded per-upstream concurrency (threat-model C7).

Nothing in this repository should be described as "working" unless a check in
`scripts/check.sh` proves it.

---

## 11. Implementation sequencing (why this order)

| # | Milestone | Why it comes here |
| --- | --- | --- |
| 0 | **Inspect, document, scaffold** | You cannot interview-well on code you have not drawn first, and you cannot draw it without knowing your toolchain. |
| 1 | **WooCommerce MCP server** | Smallest end-to-end unit: one server, one real external API, no gateway. Proves Streamable HTTP works before anything depends on it. |
| 2 | **Gateway core** (MCP server + client, registry, routing, timeouts) | Now there are exactly two moving parts to debug. |
| 3 | **Postgres + auth** (two users, hashed API keys, roles, audit log) | Auth without a data store is theatre; data store without a call path has nothing to protect. |
| 4 | **Dashboard backend + React UI** ← you are here | UI over a stable API, not over a moving target. |
| 5 | **Inventory + Support MCP servers** | Proves the "add an upstream without touching gateway code" claim. |
| 6 | **Docker images** | Wrap each unit once its runtime deps are final. |
| 7 | **Kubernetes + Helm (local, then prod values)** | Deployment last, so manifests describe reality instead of guesses. |
| 8 | **Security hardening + threat-model review** | Controls verified against the running system. |
| 9 | **Chat agent + LLM (Groq free tier / Ollama)** | Optional intelligence layer on top of a correct, audited gateway. |

Each stage ends with a reviewable demo; none of them starts before the previous one is
explained back in your own words.
