# MCP Gateway on Kubernetes (WooCommerce first)

**Assignment:** Urumi AI FDE Internship — build an MCP Gateway on Kubernetes with WooCommerce
as the first data source. Budget: **₹0** (free/open-source tooling only).

---

## Purpose

One safe, uniform doorway (an **MCP Gateway**) that lets AI clients use several backend systems
as *tools* — starting with a WooCommerce store — instead of every client integrating each
system separately.

The gateway is an **MCP server** to its callers (dashboard chat, IDEs, scripts) and an
**MCP client** to the systems behind it (a WooCommerce MCP server we write, plus independent
inventory and support MCP servers). It aggregates tool discovery, enforces permissions and
timeouts, and writes an audit log for every call.

Read [docs/architecture.md](./docs/architecture.md) first — it explains the whole design in
beginner-friendly language.

---

## Current status

**Milestone 0 complete (scaffold), Milestone 1 complete (WooCommerce MCP server),
Milestone 2 complete (gateway core), Milestone 3 complete (authentication,
authorization and audit logging against a real PostgreSQL), Milestone 4 complete
(dashboard backend + React UI: sessions, tool/upstream/audit APIs, upstream toggles
persisted in PostgreSQL), Milestone 5 complete (independent Inventory and Support
MCP servers, registered with the gateway via configuration only, verified
process-to-process with no gateway core changes), Milestone 6 complete (five
production Docker images, multi-stage and non-root, built and container-validated
locally), Milestone 7 complete (one Helm chart — gateway, three MCP servers,
dashboard, PostgreSQL with a PVC and a labelled local mock store — installed and
end-to-end validated on the kind cluster `urumi-local`, with `values-prod.yaml`
documenting every operator-supplied production input), Milestone 8 complete
(threat-model controls C1–C8 + B1 hardening, each with a failing-if-removed test),
Milestone 9 complete (LLM chat agent loop through the shared gateway pipeline,
live-verified on the Groq free tier) and Milestone 10 complete (dashboard
Team/Settings areas, a tool-permission indicator that mirrors the server's
authorization exactly, a real WordPress/WooCommerce store inside the same cluster
live-verified through `/mcp`, an external MCP client compatibility test, and the
[requirement matrix](./docs/requirement-matrix.md)).**

| Area | Status |
| --- | --- |
| Repository layout + npm workspaces | ✅ `npm install` resolves all 6 workspaces |
| `packages/shared` contract types | ✅ builds, type-checks, imports (5 WooCommerce tool names) |
| `services/woocommerce-mcp` | ✅ 5 tools over Streamable HTTP (`/mcp`), health probes, 70 tests; unit tests run against the in-process mock, and since M10 the same server is live-verified against a real in-cluster store (see below) |
| Documentation (`docs/`) | ✅ architecture, decisions (D1–D32), threat model, learning guide, [requirement matrix](./docs/requirement-matrix.md) |
| Gateway (`apps/gateway`) | ✅ aggregates upstream tools, qualified-name routing, timeouts, health probes, API-key auth + RBAC + audit + dashboard REST (login/session, settings, tools, upstream toggles), **267 tests** including the real-PostgreSQL integration suite (which skips with a printed reason without `TEST_DATABASE_URL`), plus an env-gated live external-client test |
| Dashboard (`apps/dashboard`) | ✅ React 19 + Vite 8 SPA: login, overview, tools, admin upstream toggles, read-only audit viewer, **Team** (members + API keys) and **Settings** areas, working chat (server-side agent, gateway-audited tool calls), tool-permission indicator mirroring `authorization.ts` exactly; **96 tests** + typecheck + production build |
| Inventory MCP server | ✅ `list_products` + `adjust_stock` over Streamable HTTP, deterministic 12-item seeded store, 39 tests, registered via `INVENTORY_MCP_URL` (no gateway code changes) |
| Support MCP server | ✅ `list_tickets` + `create_ticket` over Streamable HTTP, deterministic 8-ticket seeded store, 38 tests, registered via `SUPPORT_MCP_URL` (no gateway code changes) |
| Docker images | ✅ five multi-stage images (`urumi/<name>:0.1.0`: gateway, three MCP servers, dashboard), non-root, runtime-config only, built and container-tested — see [infra/docker/README.md](./infra/docker/README.md) |
| Kubernetes / Helm | ✅ one chart (`infra/helm/mcp-gateway`) with `values-local.yaml` + `values-prod.yaml`, installed and e2e-validated on kind `urumi-local` (9 workloads incl. the real WordPress/WooCommerce store, PVC-backed PostgreSQL, chart/external secrets, port-forward access) — see [infra/helm/README.md](./infra/helm/README.md) |
| PostgreSQL schema, API keys, audit log | ✅ migrations (001–002), two seeded users, hashed revocable keys, append-only audit incl. upstream-toggle rows, session + override tables (`npm run migrate`; integration-tested against PostgreSQL 17) |
| LLM / chat agent | ✅ `POST /api/chat` agent loop: Groq (free tier) or local OpenAI-compatible server via `LLM_BASE_URL`; tools from the gateway registry, executed through the shared authz/audit pipeline; disabled cleanly (503) with no key — see [docs/decisions.md D29/D30](./docs/decisions.md). In Kubernetes the key is an optional `GROQ_API_KEY` in the release Secret ([infra/helm/README.md](./infra/helm/README.md) "Enabling the chat agent") |

No feature should be described as working unless `npm run check` proves it. Files in this repo
are deliberately honest: empty workspaces have **no placeholder endpoints** that could be
mistaken for finished features. The WooCommerce MCP server's **unit suites** run against an
in-process **mock** WooCommerce REST API by default; since Milestone 10 a **real store** runs
inside the same cluster (WordPress + WooCommerce, Helm-provisioned, no paid services) and was
live-verified end to end — authenticated REST responses *and* `tools/call` through the
gateway — with the exact commands and results recorded in the
[requirement matrix](./docs/requirement-matrix.md) §3. The gateway is verified both against
**fake in-process MCP upstreams** and — since Milestone 5 — against the **real Inventory,
Support and WooCommerce MCP server processes** over Streamable HTTP
(`test/real-upstreams.test.ts`); authentication, sessions, upstream toggles and audit logging
are verified against a **real PostgreSQL 17** in a disposable container via `TEST_DATABASE_URL`
(`test/integration/postgres.test.ts`); without that variable the integration suite skips with
a printed reason, while the tests that need no database still run — **510 tests in total with
the database** (96 dashboard + 267 gateway + 39 inventory + 38 support + 70 woocommerce),
497 without it.

---

## Planned stack

| Layer | Choice | Why |
| --- | --- | --- |
| Backend language | TypeScript (strict) on Node.js ≥ 23.6 | Official MCP SDK is TypeScript-first; native type stripping runs tests straight from `.ts` |
| MCP | `@modelcontextprotocol/sdk`, **Streamable HTTP** at `/mcp` | Current standard, network-native for Kubernetes |
| HTTP layer | Express 5 | Best-documented; SDK-compatible |
| Frontend | React 19 + Vite 8 | Fast dev server, static build |
| Application data | PostgreSQL (`pg`) | Users, hashed API keys, audit log |
| Validation | zod | Tool schemas + REST input validation |
| Monorepo | npm workspaces | Already installed; no extra tooling |
| Containers | Docker (multi-stage, non-root) | Later milestone |
| Orchestration | Kubernetes (local: kind/k3d) + **Helm** | Helm mandatory; local and prod `values-*.yaml` |

Verification of these versions happened against the npm registry on 2026-10-21 — see
[docs/decisions.md](./docs/decisions.md) (D13).

---

## Repository structure

```text
mcp/
├── apps/
│   ├── dashboard/              # React + Vite frontend        [implemented]
│   └── gateway/                # API + MCP gateway            [implemented]
├── services/
│   ├── woocommerce-mcp/        # Our WooCommerce MCP server   [implemented]
│   ├── inventory-mcp/          # Independent inventory server [implemented]
│   └── support-mcp/            # Independent support server   [implemented]
├── packages/
│   └── shared/                 # Shared contract types        [implemented]
├── infra/
│   ├── docker/                 # 5 multi-stage Dockerfiles      [implemented]
│   └── helm/                   # Helm charts                    [README only]
├── docs/
│   ├── architecture.md         # What and why, explained plainly
│   ├── decisions.md            # ADR-style choices and trade-offs
│   ├── threat-model.md         # Security controls C1–C8 (C1/C2/C6 live since M3)
│   └── learning-guide.md       # Staged study plan + interview questions
├── scripts/
│   └── check.sh                # All validation for this milestone
├── .env.example                # Every env var, with placeholders (no secrets)
├── .gitignore
├── package.json                # npm workspaces root
├── tsconfig.base.json          # shared strict compiler settings
└── README.md                   # this file
```

---

## Prerequisites

**Installed and verified on this machine (2026-10-21):**

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | v26.7.0 (project requires ≥ 23.6.0) | everything |
| npm | 11.19.0 | workspaces, installs |
| Git | 2.55.0 | version control |
| Python 3 | 3.9.6 | not required by the project |
| Colima | 0.10.3 | runs the local Docker engine VM (Docker Desktop not used) |
| Docker CLI | 29.9.1 (server 29.5.2 via Colima) | image builds (Milestone 6) |
| kubectl | 1.37.1 | Kubernetes (Milestone 7) |
| kind | 0.33.0 | local cluster (Milestone 7) — cluster `urumi-local` running |
| Helm | 4.3.1 | charts (Milestone 7) |

**Still not installed:**

| Tool | Needed from | Install when (all free) |
| --- | --- | --- |
| Ollama | optional local LLM (Milestone 9) | optional; Groq free tier is the default plan — configure via `LLM_BASE_URL` |

Also not present: an *external/hosted* WooCommerce store (none is needed). Milestone 1
shipped against a **mock** WooCommerce REST API (no store, Docker or network needed); the
Milestone 10 chart provisions a **real** WordPress + WooCommerce *inside* the same cluster
and it was verified live end to end — see
[requirement-matrix.md §3](./docs/requirement-matrix.md). The labelled mock stays available
for offline demos.

**Environment status (updated 2026-10-22):** Docker (via Colima), kubectl, kind and Helm are
installed, the kind cluster `urumi-local` is running, and the Helm chart is deployed there
(release `urumi`, namespace `urumi` — see [infra/helm/README.md](./infra/helm/README.md)).
The Milestone 9 chat agent is live end-to-end verified there on the Groq free tier
(smoke HTTP 200 + a model → tool → model round-trip with an audit row, provider model
`openai/gpt-oss-120b`).
`npm run check` still runs **no container/Kubernetes check** by design: the application
milestones are validated by Node/TypeScript tests, and deployment validation is the chart's
own documented procedure (`helm lint`/`template` + the cluster walkthrough).

---

## Getting started

```bash
npm install     # install workspace dependencies
npm run check   # validate: workspace tree, typecheck, build, tests, import smoke test, audit
```

Environment variables are documented in [.env.example](./.env.example). Copy to `.env` when a
milestone needs it (`.env` is git-ignored). To run the WooCommerce MCP server locally:

```bash
cd services/woocommerce-mcp
WOOCOMMERCE_STORE_URL=... WOOCOMMERCE_CONSUMER_KEY=... WOOCOMMERCE_CONSUMER_SECRET=... npm run dev
```

The Inventory and Support servers need no configuration at all (seeded demo data):

```bash
cd services/inventory-mcp && npm run dev   # http://127.0.0.1:8083/mcp (12 seeded items)
cd services/support-mcp && npm run dev     # http://127.0.0.1:8084/mcp (8 seeded tickets)
```

To run the gateway locally (it needs at least one upstream URL; all three together):

```bash
cd apps/gateway
WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp \
INVENTORY_MCP_URL=http://127.0.0.1:8083/mcp \
SUPPORT_MCP_URL=http://127.0.0.1:8084/mcp \
npm run dev
```

See [services/woocommerce-mcp/README.md](./services/woocommerce-mcp/README.md),
[services/inventory-mcp/README.md](./services/inventory-mcp/README.md) and
[services/support-mcp/README.md](./services/support-mcp/README.md) for the tools,
endpoints, test strategy and known limitations of each server, and
[apps/gateway/README.md](./apps/gateway/README.md) for gateway endpoints, environment
variables, routing rules and test strategy.

With the gateway running, start the dashboard dev server (proxies `/api` to it):

```bash
cd apps/dashboard
npm run dev    # http://127.0.0.1:5173 — log in with a umk_… API key
```

See [apps/dashboard/README.md](./apps/dashboard/README.md) for the browser-auth flow,
features, deferred chat capabilities and test strategy.

### Docker images (Milestone 6)

```bash
# build all five images — full list, sizes and the validation log:
#   [infra/docker/README.md](./infra/docker/README.md)
docker build -f infra/docker/gateway/Dockerfile -t urumi/gateway:0.1.0 .

# run the gateway against a throwaway PostgreSQL (containers need HOST=0.0.0.0)
docker run -d --name pg -e POSTGRES_USER=mcp -e POSTGRES_PASSWORD=local_pw -e POSTGRES_DB=mcp postgres:17-alpine
docker run --rm -e DATABASE_URL=postgres://mcp:local_pw@pg:5432/mcp urumi/gateway:0.1.0 node dist/db/migrate.js
docker run -d -p 8080:8080 -e GATEWAY_HOST=0.0.0.0 \
  -e DATABASE_URL=postgres://mcp:local_pw@pg:5432/mcp \
  -e API_KEY_PEPPER=change-me-to-a-long-random-string \
  -e WOOCOMMERCE_MCP_URL=http://woocommerce-mcp:8081/mcp \
  urumi/gateway:0.1.0
```

Every image is non-root, carries a `/healthz` Docker healthcheck and takes **all**
configuration at `docker run -e` time (nothing is baked into layers). The image
contract — required variables, `HOST=0.0.0.0`, network aliases, the dashboard's
optional `/api` proxy, and exactly what was container-tested — lives in
[infra/docker/README.md](./infra/docker/README.md).

### Kubernetes + Helm (Milestone 7)

```bash
# import the images into the kind node (kind load can choke on multi-platform
# indexes; the ctr round-trip is the reliable equivalent)
for img in urumi/gateway:0.1.0 urumi/woocommerce-mcp:0.1.0 \
           urumi/inventory-mcp:0.1.0 urumi/support-mcp:0.1.0 \
           urumi/dashboard:0.1.0 postgres:17-alpine node:26.7-alpine; do
  docker save "$img" | docker exec -i urumi-local-control-plane ctr -n k8s.io images import -
done

# install the whole stack (gateway, 3 MCP servers, dashboard, PostgreSQL + PVC,
# labelled mock store) — full walkthrough, verification results, secrets
# bootstrap, production values and cleanup: infra/helm/README.md
helm upgrade --install urumi infra/helm/mcp-gateway -n urumi --create-namespace \
  -f infra/helm/mcp-gateway/values-local.yaml

# access (local kind has no ingress controller; port-forward is the demo path)
kubectl -n urumi port-forward svc/dashboard 8088:8080   # http://127.0.0.1:8088
```

The chart keeps the three MCP servers, PostgreSQL and the mock store on
ClusterIP-only services, stores database state in a PersistentVolumeClaim, and
reads every credential from a Kubernetes Secret (dev placeholders locally,
operator-created in production). An API key must be bootstrapped before any
tool call — exact commands in [infra/helm/README.md](./infra/helm/README.md).

### Local URLs, login flow, and troubleshooting

Use the exact addresses below — nothing serves on plain `http://127.0.0.1`
(port 80), so a port-less address is never the app:

| What | URL |
| --- | --- |
| Dashboard (browser login) | `http://127.0.0.1:8088` |
| Gateway REST + health (curl) | `http://127.0.0.1:8080` |
| MCP endpoint (Bearer `Authorization` only — cookies are ignored here) | `http://127.0.0.1:8080/mcp` |

Port-forwards die whenever the forwarded pods restart; restore them with:

```bash
kubectl -n urumi port-forward svc/dashboard 8088:8080 &
kubectl -n urumi port-forward svc/gateway 8080:8080 &
```

**Expected login flow.** Open `http://127.0.0.1:8088` → the sign-in form
(a silent `GET /api/me` → 401 on a fresh visit is normal and shows no message)
→ paste a gateway API key (`umk_…`, sent once in the JSON body of
`POST /api/auth/login`, never stored in the browser) → 200 + the
`urumi_session` cookie (`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
plus `Secure` whenever the request arrived over HTTPS — `SESSION_COOKIE_SECURE=auto`,
D33) → the app lands on `#/overview` and later `/api/*` calls answer 200.
A reload stays signed in for the cookie's 12-hour lifetime.

**When it does not work:**

| Symptom | Meaning | Fix |
| --- | --- | --- |
| Banner "That key was rejected (unknown, malformed or revoked)." | Wrong/revoked key: login 401, no cookie set | Re-issue or re-copy the key (bootstrap commands above) |
| Toast "Session expired — sign in again to continue." once + the sign-in banner | Cookie died mid-use (12 h TTL or key revoked) | Sign in again; a *repeated* toast would be a regression (D33 tests) |
| "Gateway unreachable — is it running?" | Port-forward died (pod restarted) | Run the two `port-forward` commands above |
| Login works in Chrome/Firefox but loops in Safari | Secure cookie set over plain http (fixed by D33 `auto`) | `kubectl -n urumi logs deploy/gateway \| grep session_cookie_secure` → expect `"auto"` |

Safe checks that never print keys or cookies:

```bash
curl -s http://127.0.0.1:8080/healthz        # {"status":"ok"}
curl -s http://127.0.0.1:8080/readyz         # 200
kubectl -n urumi logs deploy/gateway --tail=30   # config_loaded lists session_cookie_secure
```

### External MCP clients (Milestone 10)

Anything that speaks MCP over Streamable HTTP can point straight at the
gateway's `/mcp` endpoint with a `Bearer` API key. Two supported paths:

```bash
# 1) Live compatibility test — the official MCP TypeScript SDK as an external
#    client (initialize → tools/list → tools/call) against a running gateway.
#    Skips with a printed reason when the env vars are unset; the key is read
#    from the environment and never printed or asserted on.
kubectl -n urumi port-forward svc/gateway 8080:8080 &
GATEWAY_URL=http://127.0.0.1:8080 GATEWAY_API_KEY=umk_... \
  node --test apps/gateway/test/external-client.test.ts

# 2) MCP Inspector (standard GUI client for exploration and debugging):
npx @modelcontextprotocol/inspector
#   Connection type:  HTTP
#   Transport URL:    http://127.0.0.1:8080/mcp   (after the port-forward above)
#   Headers:          Authorization: Bearer <your gateway API key>
```

Keys stay out of URLs, shell history files, and the repository — pass them at
run time only.

---

## Roadmap

| # | Milestone | Deliverable |
| --- | --- | --- |
| 0 | **Inspect, document, scaffold** | ✅ done |
| 1 | WooCommerce MCP server | ✅ done: 5 tools over Streamable HTTP, tested against a mock store |
| 2 | **Gateway core** | ✅ done: MCP server + client, discovery, aggregation, routing, timeouts |
| 3 | Auth + audit | ✅ done: 2 seeded users, hashed revocable keys, roles, append-only audit (Postgres) |
| 4 | Dashboard | ✅ done: sessions, React UI (overview/tools/upstreams/audit/chat), persisted upstream toggles |
| 5 | Inventory + Support servers | ✅ done: two seeded servers, config-only registration, process-to-process gateway tests |
| 6 | Docker images | ✅ done: five multi-stage images built and container-tested (no registry push) |
| 7 | Kubernetes + Helm | ✅ done: one chart, `values-local.yaml` + `values-prod.yaml`, installed and e2e-validated on kind |
| 8 | Security hardening | ✅ done: threat-model C1–C8 + B1 hardening implemented and test-verified (SSRF guard, rate/concurrency/limit controls, log scrubbing, ServiceAccounts, host allow-listing) |
| 9 | Chat agent + LLM | ✅ done: Groq-compatible agent loop through the same gateway path (shared authz/audit pipeline); optional — 503 without a key |
| 10 | Real store + dashboard overhaul | ✅ done: WordPress/WooCommerce in-cluster (Helm, pinned versions, idempotent seed) live-verified through `/mcp`; Team/Settings dashboard areas; tool-permission indicator mirroring `authorization.ts` (regression-tested on both sides); env-gated external MCP client test + Inspector docs; security assertions; [requirement matrix](./docs/requirement-matrix.md) |

Details and the *why* for each ordering: [docs/architecture.md § 11](./docs/architecture.md).
