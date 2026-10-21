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
locally) and Milestone 7 complete (one Helm chart — gateway, three MCP servers,
dashboard, PostgreSQL with a PVC and a labelled local mock store — installed and
end-to-end validated on the kind cluster `urumi-local`, with `values-prod.yaml`
documenting every operator-supplied production input).**

| Area | Status |
| --- | --- |
| Repository layout + npm workspaces | ✅ `npm install` resolves all 6 workspaces |
| `packages/shared` contract types | ✅ builds, type-checks, imports (5 WooCommerce tool names) |
| `services/woocommerce-mcp` | ✅ 5 tools over Streamable HTTP (`/mcp`), health probes, 69 tests, no real store needed |
| Documentation (`docs/`) | ✅ architecture, decisions (D1–D27), threat model, learning guide |
| Gateway (`apps/gateway`) | ✅ aggregates upstream tools, qualified-name routing, timeouts, health probes, API-key auth + RBAC + audit + dashboard REST (login/session, tools, upstream toggles), 108 unit tests + 9 real-PostgreSQL integration tests, no Docker needed for the unit suite |
| Dashboard (`apps/dashboard`) | ✅ React 19 + Vite 8 SPA: login, overview, tools, admin upstream toggles, read-only audit viewer, labelled chat foundation; 14 tests + typecheck + production build |
| Inventory MCP server | ✅ `list_products` + `adjust_stock` over Streamable HTTP, deterministic 12-item seeded store, 39 tests, registered via `INVENTORY_MCP_URL` (no gateway code changes) |
| Support MCP server | ✅ `list_tickets` + `create_ticket` over Streamable HTTP, deterministic 8-ticket seeded store, 38 tests, registered via `SUPPORT_MCP_URL` (no gateway code changes) |
| Docker images | ✅ five multi-stage images (`urumi/<name>:0.1.0`: gateway, three MCP servers, dashboard), non-root, runtime-config only, built and container-tested — see [infra/docker/README.md](./infra/docker/README.md) |
| Kubernetes / Helm | ✅ one chart (`infra/helm/mcp-gateway`) with `values-local.yaml` + `values-prod.yaml`, installed and e2e-validated on kind `urumi-local` (7 workloads, PVC-backed PostgreSQL, chart/external secrets, port-forward access) — see [infra/helm/README.md](./infra/helm/README.md) |
| PostgreSQL schema, API keys, audit log | ✅ migrations (001–002), two seeded users, hashed revocable keys, append-only audit incl. upstream-toggle rows, session + override tables (`npm run migrate`; integration-tested against PostgreSQL 17) |
| LLM / chat agent | ⬜ not implemented (no API key required or used; the dashboard chat page is an explicitly-labelled foundation) |

No feature should be described as working unless `npm run check` proves it. Files in this repo
are deliberately honest: empty workspaces have **no placeholder endpoints** that could be
mistaken for finished features. The WooCommerce MCP server is tested against a **mock**
WooCommerce REST API — it has **not** been verified against a real store (none is available
on this machine); see [services/woocommerce-mcp/README.md](./services/woocommerce-mcp/README.md).
The gateway is verified both against **fake in-process MCP upstreams** and — since Milestone 5 —
against the **real Inventory, Support and WooCommerce MCP server processes** over Streamable
HTTP (`test/real-upstreams.test.ts`), with the mock REST store still standing in for the paid
WooCommerce API; see [apps/gateway/README.md](./apps/gateway/README.md). Authentication,
sessions, upstream toggles and audit logging are
verified against a **real PostgreSQL 17** in a disposable container via `TEST_DATABASE_URL`
(`test/integration/postgres.test.ts`); without that variable the integration suite skips with
a printed reason, while the 268 tests that need no database (69 + 108 + 14 + 39 + 38) still
run — 277 tests in total with the database.

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
| Ollama | optional local LLM (Milestone 9) | optional; Groq free tier is the default plan |

Also not present: a WooCommerce store. Milestone 1 shipped against a **mock** WooCommerce REST
API (no store, Docker or network needed); verifying against a real store — a free local
container or trial store — remains an open follow-up.

**Environment status (updated 2026-10-21):** Docker (via Colima), kubectl, kind and Helm are
installed, the kind cluster `urumi-local` is running, and the Helm chart is deployed there
(release `urumi`, namespace `urumi` — see [infra/helm/README.md](./infra/helm/README.md)).
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

---

## Roadmap

| # | Milestone | Deliverable |
| --- | --- | --- |
| 0 | **Inspect, document, scaffold** | ✅ done |
| 1 | WooCommerce MCP server | ✅ done: 5 tools over Streamable HTTP, tested against a mock store |
| 2 | **Gateway core** | ✅ done: MCP server + client, discovery, aggregation, routing, timeouts |
| 3 | Auth + audit | ✅ done: 2 seeded users, hashed revocable keys, roles, append-only audit (Postgres) |
| 4 | Dashboard | ✅ done: sessions, React UI (overview/tools/upstreams/audit/chat foundation), persisted upstream toggles |
| 5 | Inventory + Support servers | ✅ done: two seeded servers, config-only registration, process-to-process gateway tests |
| 6 | Docker images | ✅ done: five multi-stage images built and container-tested (no registry push) |
| 7 | Kubernetes + Helm | ✅ done: one chart, `values-local.yaml` + `values-prod.yaml`, installed and e2e-validated on kind |
| 8 | Security hardening | ← you are here: threat-model C1–C7 with tests |
| 9 | Chat agent + LLM | Groq free tier or local Ollama, through the same gateway path |

Details and the *why* for each ordering: [docs/architecture.md § 11](./docs/architecture.md).
