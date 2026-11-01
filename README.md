# MCP Gateway on Kubernetes (WooCommerce first)

One authenticated **MCP gateway** in front of a real WooCommerce store and two more
backends — with per-user API keys, tool-level permissions, rate limits, SSRF
protection, encrypted upstream credentials, a full audit log, and a dashboard chat
agent that works even when the hosted LLM quota is exhausted (local Ollama
fallback). Runs on local Kubernetes; the same Helm charts target a k3s VPS via
values changes only. **₹0 budget** — free and open-source tooling throughout.

---

## Overview

This project builds the four layers of a small-but-real MCP platform on Kubernetes:

1. **Store** — a WordPress + WooCommerce shop (persistent, seeded with demo products).
2. **WooCommerce MCP server** — a first-party Streamable-HTTP MCP server exposing
   products/orders as tools over the WooCommerce REST API.
3. **Gateway and dashboard** — a React dashboard and Node backend where admins
   register MCP servers; the gateway is an MCP *client* to every upstream and an
   MCP *server* exposing all their tools through one endpoint.
4. **Chat agent** — an LLM tool-loop in the dashboard that calls tools through the
   same gateway pipeline (hosted provider first, local model as fallback).

Every tool call — from the chat, an IDE, or MCP Inspector — goes through one
execution pipeline that enforces identity, permissions, rate limits and audit.

## Features

- **One MCP endpoint** with aggregated tool discovery; qualified names
  (`<upstream>_<tool>`) make name collisions impossible
- **Roles and permissions**: admin/member, per-user grant lists, a write-verb
  ceiling for members, ungranted tools hidden from discovery *and* rejected on call
- **API keys**: `sha256(key‖pepper)` at rest, revocable, shown once at issue time
- **Upstream management**: add/edit/disable/remove servers at runtime (URL +
  optional static credential, AES-256-GCM encrypted at rest)
- **Audit log**: one row per tool call (user, server, tool, time, duration,
  outcome), filterable in the dashboard
- **Failure isolation**: per-upstream timeouts and bounded concurrency; one dead
  upstream fails alone and the dashboard reports why
- **Observability**: per-server call/error/latency metrics aggregated from the
  audit log; live health re-probe on demand
- **Chat agent**: bounded tool-loop with provider fallback (Groq free tier →
  local Ollama), honest provider reporting, safe retries
- **Operations**: Helm chart with local/production values, upgrade/rollback
  tested, multi-replica gateway verified (`scripts/scale-drill.sh`)

## Architecture

```mermaid
flowchart LR
  U["User or client"] -->|API request| G["MCP gateway"]
  G -->|qualified tool name| R["Upstream registry"]
  R --> W["woocommerce-mcp"]
  R --> I["inventory-mcp"]
  R --> S["support-mcp"]
  W --> ST["WordPress and WooCommerce"]
  I --> D1["Inventory data"]
  S --> D2["Support data"]
  G -.->|not exposed to the browser| ST
```

The gateway authenticates the caller, authorizes the tool, applies rate limits
and writes an audit row before anything reaches an upstream.

```mermaid
flowchart LR
  U["User"] -->|chat message| A["Chat agent in the gateway"]
  A -->|tool definitions| P["LLM provider"]
  P -->|tool calls| A
  A -->|same execution pipeline| G["MCP gateway"]
  G --> W["Authorized upstream tool"]
  W -->|tool result| A
  P -->|final answer| U
```

The LLM provider is hosted Groq first and the local Ollama fallback second.

The browser never calls upstream MCP servers directly; upstream credentials stay
server-side. Deep dive: [docs/architecture.md](./docs/architecture.md)
(§12 summarises the design trade-offs).

## Repository layout

```text
mcp/
├── apps/
│   ├── dashboard/              # React 19 + Vite SPA (dark-first control-plane UI)
│   └── gateway/                # API + MCP gateway + chat agent + auth/audit
├── services/
│   ├── woocommerce-mcp/        # First-party WooCommerce MCP server (5 tools)
│   ├── inventory-mcp/          # Inventory MCP server (seeded demo data)
│   └── support-mcp/            # Support MCP server (seeded demo data)
├── packages/shared/            # Shared contract types
├── infra/
│   ├── docker/                 # Multi-stage, non-root Dockerfiles
│   └── helm/mcp-gateway/       # One chart: values-local.yaml + values-prod.yaml
├── scripts/                    # check.sh, security demo, scale drill
└── docs/                       # architecture, threat model, decisions, runbook
```

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Backend | TypeScript (strict) on Node.js ≥ 23.6 | Official MCP SDK is TypeScript-first; tests run from `.ts` |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP | Current standard; what IDE clients speak |
| HTTP | Express 5 | SDK-compatible, well documented |
| Frontend | React 19 + Vite 8 | Static SPA; `/api` proxied to the gateway |
| Data | PostgreSQL 17 (`pg`), WordPress + MariaDB | Users/keys/audit; the real store |
| Validation | zod | Tool schemas + REST input validation |
| Local LLM | Ollama (optional), `qwen2.5:3b` | Free, offline, no API key; keeps chat usable at ₹0 |
| Packaging | npm workspaces, Docker, Kubernetes, Helm | One chart, two values files |

## Prerequisites

| Tool | Needed for |
| --- | --- |
| Node.js ≥ 23.6 + npm | everything |
| Docker (e.g. Colima) | image builds and the kind node |
| kind, kubectl, Helm | the local cluster and chart |
| Ollama (optional) | local LLM fallback for chat |

All free. Versions actually used are listed in [docs/requirement-matrix.md](./docs/requirement-matrix.md).

## Getting started

```bash
git clone https://github.com/ishaan-bits/woocommerce_mcp && cd woocommerce_mcp
npm install
npm run check          # typecheck + build + full tests + security assertions
```

Run pieces locally during development:

```bash
cd services/woocommerce-mcp && WOOCOMMERCE_STORE_URL=... WOOCOMMERCE_CONSUMER_KEY=... WOOCOMMERCE_CONSUMER_SECRET=... npm run dev
cd services/inventory-mcp && npm run dev      # http://127.0.0.1:8083/mcp
cd services/support-mcp && npm run dev        # http://127.0.0.1:8084/mcp
cd apps/gateway && WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp \
  INVENTORY_MCP_URL=http://127.0.0.1:8083/mcp SUPPORT_MCP_URL=http://127.0.0.1:8084/mcp npm run dev
cd apps/dashboard && npm run dev              # http://127.0.0.1:5173 (proxies /api)
```

Environment variables are documented in [.env.example](./.env.example)
(placeholders only — real values live in Kubernetes Secrets).

## Local URLs and demo access

With the cluster up (see [infra/helm/README.md](./infra/helm/README.md)):

```bash
echo "127.0.0.1 dashboard.urumi.test shop.urumi.test" | sudo tee -a /etc/hosts
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
```

| What | URL |
| --- | --- |
| Dashboard | `http://dashboard.urumi.test:18080` |
| Storefront | `http://shop.urumi.test:18080` |
| Store admin | `http://shop.urumi.test:18080/wp-login.php` |
| MCP endpoint | `http://dashboard.urumi.test:18080/mcp` |
| Gateway (curl/SDK fallback) | `http://127.0.0.1:8080` via `kubectl -n urumi port-forward svc/gateway 8080:8080` |

**Demo credentials** live only in the git-ignored `.tmp/demo-keys.json`
(permissions 0600; two entries: `admin`, `reader`). Copy without printing:

```bash
python3 -c "import json;print(json.load(open('.tmp/demo-keys.json'))['admin']['key'])" | pbcopy
```

If the file is missing, create keys with the documented bootstrap in
[infra/helm/README.md](./infra/helm/README.md) ("Secrets and API-key bootstrap").

**Demo walkthrough:** [docs/demo-runbook.md](./docs/demo-runbook.md) (T0–T11 —
storefront checkout → admin order → external MCP client → two-upstream prompt →
key revocation → upstream disable → failure isolation → audit → restart
persistence). **Guided recording:** [docs/recording-script.md](./docs/recording-script.md).

**Placing an order:** open `http://shop.urumi.test:18080/shop/`, pick a product →
Add to cart → Checkout → **Cash on delivery** → Place order. The order appears in
WooCommerce admin and through `woocommerce_list_orders`. (Cash on delivery is
enabled once via `wc/v3/payment_gateways/cod`; the runbook §0 has the command.)

**External MCP clients:** point MCP Inspector / Claude Code / Cursor at
`http://dashboard.urumi.test:18080/mcp` with `Authorization: Bearer <key>`.
The repo also carries an SDK-based compatibility test
(`apps/gateway/test/external-client.test.ts`, env-gated).

## Local LLM (Ollama) — optional chat fallback

Chat's primary provider is the Groq free tier; its quota is intermittent. The
optional local fallback keeps chat working with zero external dependency:

```bash
brew install ollama && brew services start ollama   # free, no account, no API key
ollama pull qwen2.5:3b                              # ~1.9 GB; verified tool-calling
# verify the gateway can reach it (pods talk to the Mac via host.docker.internal):
kubectl -n urumi exec deploy/gateway -c gateway -- node -e "fetch('http://host.docker.internal:11434/api/version').then(r=>r.json()).then(console.log)"
```

`values-local.yaml` enables it (`gateway.llm.fallback` = `ollama` /
`qwen2.5:3b`); **`values-prod.yaml` leaves it unset — Ollama is never required**.
Apply with `helm upgrade … -f values-local.yaml` and
`kubectl -n urumi rollout restart deploy/gateway` (ConfigMap changes don't
restart pods by themselves). The chat reply reports which provider answered
("Using local model qwen2.5:3b"). Behaviour and policy:
[docs/decisions.md](./docs/decisions.md) D39. Troubleshooting: `ollama ps`
(model loads on first use), re-run the reachability check above, and note that
when both providers fail the error names both and keeps the turn's tool results.

## Testing and verification

```bash
npm run check                                          # full gate (typecheck, build, tests)
TEST_DATABASE_URL=postgres://mcp:local_pw@127.0.0.1:5433/mcp?sslmode=disable bash scripts/check.sh   # + PostgreSQL integration
bash scripts/security-demo.sh                          # live security demo (needs DEMO_ADMIN_KEY / DEMO_READER_KEY)
bash scripts/scale-drill.sh                            # multi-replica gateway drill (self-restoring)
```

Latest full gate: **615/615 tests** (111 dashboard + 348 gateway incl.
PostgreSQL integration + 39 inventory + 38 support + 79 woocommerce),
Helm security assertions **10/10**, `npm audit` **0 vulnerabilities**,
secret scans clean. The scaling drill prints PASS/FAIL per check and restores
the original replica count even on failure — its output distinguishes
per-replica upstream reachability from MCP session continuity (sessions are
pinned by `ClientIP` affinity; in-memory MCP sessions do not migrate between
replicas).

**Security controls — active by default vs optional:**

| Control | State |
| --- | --- |
| Hashed, revocable API keys; hidden+rejected unauthorized tools; AES-256-GCM upstream credentials; SSRF allow-list; per-key rate limits; non-root containers; no Kubernetes API access from workloads | **active** |
| Sticky-session Service for multi-replica safety; per-server metrics | **active** |
| NetworkPolicy (same-namespace ingress) | **optional — off by default**; enforcement verified on this CNI, but enabling it requires allow-listing the ingress namespace (`networkPolicy.allowIngressNamespaces`) or the demo Ingress is blocked |
| TLS / real DNS / public VPS | **not active locally** (documented only) |

## Kubernetes deployment

One chart, two values files — the only differences between local and production
are configuration:

| | `values-local.yaml` | `values-prod.yaml` |
| --- | --- | --- |
| Ingress | `dashboard.urumi.test` / `shop.urumi.test`, no TLS | real DNS + TLS (operator) |
| Secrets | local dev placeholders | operator-created Secret (`secretKeyRef`) |
| Gateway | 1 replica | 2 replicas + ClientIP session affinity |
| Local LLM fallback | enabled (Ollama on the host) | unset (not required) |

- Install/verify/cleanup (data-preserving): [infra/helm/README.md](./infra/helm/README.md)
- Upgrades and rollback: `helm upgrade` / `helm rollback <revision>` — tested
  (rev 20 → 21) over the same PVCs; databases are never part of a rollback
- Production values render zero Secret manifests and zero Ollama configuration
  (assertions 3, 6, 10)
- **Teardown preserves data** — PVCs carry `helm.sh/resource-policy: keep`;
  deleting them is only done deliberately (documented with warnings)

## Security

Threat model with the assignment's four required scenarios:
[docs/threat-model.md](./docs/threat-model.md) (§3c). Highlights:

- Client keys authenticate to the **gateway only** (never forwarded upstream);
  stored as `sha256(key‖pepper)`, revocable, compared in constant time
- Upstream credentials: store keys in a Kubernetes Secret; admin-added upstream
  credentials encrypted at rest (AES-256-GCM, bound to the upstream id)
- No admin bypass: grants bind admins exactly like members; write verbs are a
  hard ceiling for the member role
- SSRF guard on every upstream URL (private/metadata address classifier +
  allow-list), validated on create/edit and at boot
- Logs scrubbed of keys, tokens, cookies, database URLs and credentials
- One audit row per tool call, attributed to the authenticated human

## Standout features

| Category | Status | Where |
| --- | --- | --- |
| 2. Tool permissions | ✅ implemented & verified | `auth/authorization.ts`, `mcp-server.ts` (hidden + rejected), `authz-e2e.test.ts` |
| 6. Security hardening | ✅ implemented & verified | SSRF suites, `upstream-credentials.ts`, helm assertions 10/10 |
| 7. Scaling | ✅ implemented & verified | `scripts/scale-drill.sh` (2 replicas, sessions + upstreams), D37 |
| 8. Observability | ✅ implemented & verified | `toolStats()` → `/api/upstreams`, dashboard metrics, live health refresh |
| 9. Helm upgrades/rollback | ✅ documented & tested | `infra/helm/README.md`, drill rev 20→21 |
| 4. Many tools | ✅ evaluated — not needed at this scale | 9 tools; filtered discovery + search + qualified names |
| 1. VPS deployment | 🟡 documented only | `values-prod.yaml` + VPS outline — never deployed |
| 3. OAuth · 5. Hosted MCP servers · multi-store bonus | not implemented | deliberate scope choices |

Evidence trail: [docs/requirement-matrix.md](./docs/requirement-matrix.md).

## Design trade-offs

- **Why a gateway?** N clients × M backends becomes N+M integrations, with one
  enforced choke point for identity, permissions, limits and audit. Cost: one
  more hop and one component to operate.
- **Why hashed keys?** A leaked database must not leak usable credentials.
- **Why can't the browser call upstreams directly?** Upstream credentials live
  server-side; SSRF, credentials and audit stay in one place.
- **Per-pod MCP sessions + ClientIP affinity** (vs a shared session store): no
  new stateful dependency; the trade-off is sticky routing for replicas > 1
  (documented, drill-tested).
- **Optional local LLM**: keeps chat usable without any provider quota;
  production never needs a developer's machine.
- **Compact tool results** (real fields only): keeps responses inside the model
  context and the safety cap — the cause of an early factual-accuracy bug where
  truncated 17 KB results made a model invent product-ID ranges (fixed and
  regression-tested, `docs/requirement-matrix.md` §18).

## Known limitations

- No public deployment: the VPS/k3s path is documented, not executed (₹0
  constraint — no reliable free host). Local kind deployment is fully verified.
- Hosted LLM quota (Groq free tier) is intermittent; the local fallback covers
  chat, and both providers are verified — but a 3B local model occasionally
  under-uses tools (mitigated by system rules, not eliminated).
- NetworkPolicy is ready and CNI-enforced but intentionally disabled by default
  (needs the ingress-namespace allow-list).
- Per-key rate limits are per-process; multi-replica multiplies the effective
  burst (documented, D37).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | full design, MCP protocol, §12 trade-offs |
| [docs/threat-model.md](./docs/threat-model.md) | controls C1–C8 + the four assignment scenarios |
| [docs/decisions.md](./docs/decisions.md) | decision records D1–D40 |
| [docs/requirement-matrix.md](./docs/requirement-matrix.md) | every PDF requirement → evidence |
| [docs/demo-runbook.md](./docs/demo-runbook.md) | two-user end-to-end demo (T0–T11) |
| [docs/recording-script.md](./docs/recording-script.md) | 7-minute demo recording outline |
| [docs/learning-guide.md](./docs/learning-guide.md) | study guide |
| [docs/Urumi-MCP-Gateway-Assignment.pdf](./docs/Urumi-MCP-Gateway-Assignment.pdf) | original assignment |
| [infra/helm/README.md](./infra/helm/README.md) | deployment, secrets bootstrap, upgrades, VPS outline |

## Status

Milestones 0–11 are complete (scaffold → store → gateway → auth/audit →
dashboard → extra MCP servers → Docker → Kubernetes/Helm → security → chat
agent → real store → assignment reconciliation with the live two-user DoD
walkthrough). Follow-up passes added the stand-out features above, the local
LLM fallback, and the product-listing accuracy fix. The roadmap and its
rationale live in [docs/architecture.md §11](./docs/architecture.md).

**Remaining before final submission:** record the demo video
([docs/recording-script.md](./docs/recording-script.md)) and submit the form.
