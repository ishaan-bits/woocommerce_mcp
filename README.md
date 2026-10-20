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

**Milestone 0 complete (scaffold), Milestone 1 complete (WooCommerce MCP server) and
Milestone 2 complete (gateway core).**

| Area | Status |
| --- | --- |
| Repository layout + npm workspaces | ✅ `npm install` resolves all 6 workspaces |
| `packages/shared` contract types | ✅ builds, type-checks, imports (5 WooCommerce tool names) |
| `services/woocommerce-mcp` | ✅ 5 tools over Streamable HTTP (`/mcp`), health probes, 69 tests, no real store needed |
| Documentation (`docs/`) | ✅ architecture, decisions, threat model, learning guide |
| Gateway (`apps/gateway`) | ✅ aggregates upstream tools, qualified-name routing, timeouts, health probes, 36 tests, no Docker/network needed |
| Dashboard, inventory/support MCP servers | ⬜ **not implemented** — package manifests only, no source, no endpoints |
| Docker images / Kubernetes / Helm | ⬜ **not implemented** — `infra/*` contain explanatory READMEs only |
| PostgreSQL schema, API keys, audit log | ⬜ not implemented |
| LLM / chat agent | ⬜ not implemented (no API key required or used) |

No feature should be described as working unless `npm run check` proves it. Files in this repo
are deliberately honest: empty workspaces have **no placeholder endpoints** that could be
mistaken for finished features. The WooCommerce MCP server is tested against a **mock**
WooCommerce REST API — it has **not** been verified against a real store (none is available
on this machine); see [services/woocommerce-mcp/README.md](./services/woocommerce-mcp/README.md).
The gateway is tested against **fake in-process MCP upstreams** — it has **not** been paired
with the real WooCommerce MCP server process yet (that live pairing belongs to Milestones 6–7);
see [apps/gateway/README.md](./apps/gateway/README.md).

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
│   ├── dashboard/              # React + Vite frontend        [manifest only]
│   └── gateway/                # API + MCP gateway            [implemented]
├── services/
│   ├── woocommerce-mcp/        # Our WooCommerce MCP server   [implemented]
│   ├── inventory-mcp/          # Independent inventory server [manifest only]
│   └── support-mcp/            # Independent support server   [manifest only]
├── packages/
│   └── shared/                 # Shared contract types        [implemented]
├── infra/
│   ├── docker/                 # Dockerfiles                  [README only]
│   └── helm/                   # Helm charts                  [README only]
├── docs/
│   ├── architecture.md         # What and why, explained plainly
│   ├── decisions.md            # ADR-style choices and trade-offs
│   ├── threat-model.md         # Planned security controls C1–C8
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
installed, and a local kind cluster `urumi-local` is running (created for Milestones 6–7 with
explicit approval). No container or Kubernetes artifact exists yet — the Dockerfiles and the
Helm chart still belong to Milestones 6–7, so `npm run check` runs **no container/Kubernetes
check** until then. That does not block the application milestones (3–5, pure Node/TypeScript).

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

To run the gateway locally (it needs at least one upstream URL):

```bash
cd apps/gateway
WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp npm run dev
```

See [services/woocommerce-mcp/README.md](./services/woocommerce-mcp/README.md) for the tools,
endpoints, test strategy and known limitations, and
[apps/gateway/README.md](./apps/gateway/README.md) for gateway endpoints, environment
variables, routing rules and test strategy.

---

## Roadmap

| # | Milestone | Deliverable |
| --- | --- | --- |
| 0 | **Inspect, document, scaffold** | ✅ done |
| 1 | WooCommerce MCP server | ✅ done: 5 tools over Streamable HTTP, tested against a mock store |
| 2 | **Gateway core** | ← you are here: MCP server + client, discovery, aggregation, routing, timeouts |
| 3 | Auth + audit | 2 users, hashed revocable keys, roles, audit log (Postgres) |
| 4 | Dashboard | React UI: chat, tool list, upstream toggles, audit view |
| 5 | Inventory + Support servers | prove "add an upstream without gateway code" |
| 6 | Docker images | one image per deployable |
| 7 | Kubernetes + Helm | one chart, `values-local.yaml` + `values-prod.yaml` |
| 8 | Security hardening | threat-model C1–C7 with tests |
| 9 | Chat agent + LLM | Groq free tier or local Ollama, through the same gateway path |

Details and the *why* for each ordering: [docs/architecture.md § 11](./docs/architecture.md).
