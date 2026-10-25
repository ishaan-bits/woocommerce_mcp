# MCP Gateway on Kubernetes (WooCommerce first)

**Assignment:** Urumi AI FDE Internship — build an MCP Gateway on Kubernetes with WooCommerce
as the first data source. Budget: **₹0** (free/open-source tooling only).

---

## For recruiters (start here)

**What this is.** A production-shaped **MCP Gateway on Kubernetes**: one authenticated
endpoint that lets AI clients (a dashboard chat, IDEs like Claude Code/Cursor, MCP
Inspector) use a real WooCommerce store and two more backends as *tools*, with
per-user API keys, role-based tool permissions, rate limits, SSRF protection,
encrypted upstream credentials and a full audit log — all running in a local kind
cluster with Helm charts that deploy unchanged to a k3s VPS.

**Architecture in one breath.** React dashboard → gateway (MCP server to callers,
MCP client to upstreams) → three Streamable-HTTP MCP servers (WooCommerce /
Inventory / Support) → a real WordPress+WooCommerce store and PostgreSQL.
Start with [docs/architecture.md](./docs/architecture.md); the choice-vs-tradeoff
summary is its **§12 "System design and tradeoffs"**.

**Main security properties.** API keys stored as `sha256(key‖pepper)` only; roles
(admin/member) enforced server-side with **no admin bypass** — grants bind admins
too; upstream credentials never reach browsers or MCP clients (AES-256-GCM at rest,
D34); SSRF allow-listing on every upstream URL; per-key rate limits + bounded
concurrency; structured logs scrubbed of secrets; exactly-one audit row per tool
call, attributed to the human. Details: [docs/threat-model.md](./docs/threat-model.md)
(incl. §3c — the assignment's four threat scenarios).

**Prerequisites.** macOS/Linux with Node ≥ 23.6, Docker (Colima), kind, kubectl,
Helm — all free. Full table: [Prerequisites](#prerequisites).

**Quick start (local demo, ~10 min).**
```bash
git clone https://github.com/ishaan-bits/woocommerce_mcp && cd woocommerce_mcp
npm install && npm run check          # 574 tests, no cluster needed
colima start                          # Docker VM (kind cluster lives here)
kubectl -n urumi get pods             # 9/9 Running (see infra/helm/README.md to install from scratch)
# demo access — one port-forward + /etc/hosts (or curl --resolve):
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
# dashboard → http://dashboard.urumi.test:18080    store → http://shop.urumi.test:18080
```

**Demo.** Follow [docs/demo-runbook.md](./docs/demo-runbook.md) (T0–T11: storefront
checkout → WooCommerce admin → external MCP client → two-upstream prompt → key
revocation → upstream disable → failure isolation → audit → restart persistence)
with the two demo identities (admin-demo / reader-demo). Everything is verified
**locally** on kind; the storefront/admin browser steps are performed
**manually** at demo time, and the chat steps are **blocked** by the Groq
free-tier quota (below). For a guided walkthrough
see [docs/recording-script.md](./docs/recording-script.md) (5–7 minute outline).

**Test results (2026-10-26).** `scripts/check.sh` → **575/575** (107 dashboard +
321 gateway incl. 14 PostgreSQL integration + 39 inventory + 38 support + 70
woocommerce), Helm security assertions 7/7, `npm audit` **0 vulnerabilities**
(a high-severity `body-parser` DoS advisory, GHSA-27r3-jxmh-p828, was resolved
by a lockfile-only bump to `body-parser@2.4.0` — no manifest or API changes),
secret scans clean.

**Dashboard UI.** The React dashboard is a dark-first developer control plane
(refined violet/indigo design system, collapsible icon sidebar, per-page
health summary from real API state, metric panels, server cards, tool schema
explorer, audit detail viewer, safe code rendering in chat). Everything is
genuine data — no fabricated metrics or statuses. Local dev: `npm run dev -w
@mcp/dashboard` (Vite, `/api` proxied to `VITE_GATEWAY_API_URL`, default
`http://127.0.0.1:8080`) or `npm run build -w @mcp/dashboard` + `npx vite
preview`; light/dark follows the OS with a manual toggle.

**Known limitations (honest).**
- **Everything above is locally verified** on kind (`urumi-local`). The **VPS/k3s
  deployment is documented but not executed** (`infra/helm/README.md` "Deploying
  to a future VPS") — **no public deployment of this system exists**; don't let a
  static-frontend URL stand in for one.
- **Chat's live LLM turns are quota-blocked**: the Groq free tier returned real
  `429`s; the gateway's bounded, `Retry-After`-aware retry behavior is verified
  with mocks (D35) and the UI offers a safe retry. This is an external limitation,
  not "fixed by code".
- The assignment PDF, requirement matrix and evidence trail:
  [docs/Urumi-MCP-Gateway-Assignment.pdf](./docs/Urumi-MCP-Gateway-Assignment.pdf) ·
  [docs/requirement-matrix.md](./docs/requirement-matrix.md) ·
  [docs/threat-model.md](./docs/threat-model.md) ·
  [docs/decisions.md](./docs/decisions.md) (D1–D35).

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
[requirement matrix](./docs/requirement-matrix.md)). Milestone 11 (in progress)
brings admin-managed dynamic upstreams with AES-256-GCM-encrypted credentials,
member self-serve API keys, Ingress hosts for storefront + dashboard, a more
reliable chat path (bounded provider retries, honest health indicator), and the
**two-user definition-of-done walkthrough** — reproducible step by step in
[docs/demo-runbook.md](./docs/demo-runbook.md) with each step's evidence status.**

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
| LLM / chat agent | ✅ `POST /api/chat` agent loop: Groq (free tier) or local OpenAI-compatible server via `LLM_BASE_URL`; tools from the gateway registry, executed through the shared authz/audit pipeline; disabled cleanly (503) with no key — see [docs/decisions.md D29/D30](./docs/decisions.md). Transient provider rate limits are retried in-request with a bounded, `Retry-After`-aware policy (never on timeouts/5xx — no duplicate token spend); a still-rate-limited provider answers 429 with `retry_after_seconds` and the UI offers "Retry last message" (the topbar stays "Connected" — provider availability is not gateway health, [docs/decisions.md D35](./docs/decisions.md)). In Kubernetes the key is an optional `GROQ_API_KEY` in the release Secret ([infra/helm/README.md](./infra/helm/README.md) "Enabling the chat agent") |

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
a printed reason, while the tests that need no database still run — **574 tests in total with
the database** (106 dashboard + 321 gateway + 39 inventory + 38 support + 70 woocommerce),
560 without it.

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
│   └── helm/                   # One chart, values-local/prod   [implemented]
├── docs/
│   ├── Urumi-MCP-Gateway-Assignment.pdf  # the original assignment (source of truth)
│   ├── demo-runbook.md         # Two-user definition-of-done walkthrough + evidence
│   ├── architecture.md         # What and why, explained plainly (§12: design tradeoffs)
│   ├── decisions.md            # ADR-style choices and trade-offs (D1–D35)
│   ├── threat-model.md         # Security controls C1–C8 + the 4 PDF threat scenarios
│   ├── requirement-matrix.md   # Every PDF requirement → evidence
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

# access — local ingress on kind (see infra/helm/README.md "Access" for details)
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80
# then: dashboard http://dashboard.urumi.test:18080 — store http://shop.urumi.test:18080
# (add both hosts as 127.0.0.1 in /etc/hosts, or skip DNS with curl --resolve)
```

The chart keeps the three MCP servers, PostgreSQL and the mock store on
ClusterIP-only services, stores database state in a PersistentVolumeClaim, and
reads every credential from a Kubernetes Secret (dev placeholders locally,
operator-created in production). An API key must be bootstrapped before any
tool call — exact commands in [infra/helm/README.md](./infra/helm/README.md).

### Local URLs, login flow, and troubleshooting

The local domain approach (K6): the chart's Ingress gives the demo two stable
hostnames. The kind cluster runs the community `ingress-nginx` controller
(chart 4.15.1, namespace `ingress-nginx`); because the kind node publishes no
host ports (and port 80 binding needs root), reach it through a single
port-forward:

```bash
# one-time (or per session): point the demo hosts at the forwarded port
echo "127.0.0.1 dashboard.urumi.test shop.urumi.test" | sudo tee -a /etc/hosts
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
```

| What | URL |
| --- | --- |
| Dashboard (browser login) | `http://dashboard.urumi.test:18080` (Ingress `/` → dashboard, `/mcp` + `/api` → gateway) |
| Storefront (WordPress/WooCommerce) | `http://shop.urumi.test:18080` (Ingress `/` → wordpress:80; `wp-login.php` works there too) |
| Dashboard (port-forward fallback) | `http://127.0.0.1:8088` |
| Gateway REST + health (curl) | `http://127.0.0.1:8080` |
| MCP endpoint (Bearer `Authorization` only — cookies are ignored here) | `http://dashboard.urumi.test:18080/mcp` (or `http://127.0.0.1:8080/mcp`) |

No `/etc/hosts` access (or checking scripts)? `curl --resolve
dashboard.urumi.test:18080:127.0.0.1 http://dashboard.urumi.test:18080/` works
the same, and the store's canonical URLs always carry `shop.urumi.test:18080`
— WordPress's canonical redirects are forced onto the configured site URL, so
a bare `port-forward svc/wordpress 8082:80` visit 301s to
`http://shop.urumi.test:18080/…` instead of leaking a stale host.

Use the exact addresses below — nothing serves on plain `http://127.0.0.1`
(port 80), so a port-less address is never the app:

Port-forwards die whenever the forwarded pods restart; restore them with:

```bash
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
kubectl -n urumi port-forward svc/dashboard 8088:8080 &   # fallback path
kubectl -n urumi port-forward svc/gateway 8080:8080 &     # curl / health
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
| "Gateway unreachable — is it running?" | Port-forward died (pod restarted) | Run the `port-forward` commands above |
| Login works in Chrome/Firefox but loops in Safari | Secure cookie set over plain http (fixed by D33 `auto`) | `kubectl -n urumi logs deploy/gateway \| grep session_cookie_secure` → expect `"auto"` |

Safe checks that never print keys or cookies:

```bash
curl -s http://127.0.0.1:8080/healthz        # {"status":"ok"}
curl -s http://127.0.0.1:8080/readyz         # 200
kubectl -n urumi logs deploy/gateway --tail=30   # config_loaded lists session_cookie_secure
```

### Place an order (storefront, cash on delivery)

The store is a real WordPress/WooCommerce in the cluster. Open
`http://shop.urumi.test:18080/shop/` (or the port-forwarded equivalent),
pick a product, **Add to cart**, then `…/checkout/` → fill contact + billing →
choose **Cash on delivery** → **Place order**. The confirmation page shows the
order number, and the order appears immediately in **WooCommerce → Orders**
(`wp-admin/admin.php?page=wc-orders`) *and* through the platform's own tools
(`woocommerce_list_orders` from the dashboard chat or any MCP client).
Cash on delivery is a one-time store setting (the PDF's "test-friendly
method") — exact commands, screenshots-as-evidence and the whole two-user demo
are in [docs/demo-runbook.md](./docs/demo-runbook.md) §1.

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

## Demo credentials and secrets

**Everything sensitive lives outside git.** `.env` is git-ignored and
`.env.example` holds placeholders only; the Kubernetes release Secret
(`urumi-secrets`, operator-created in production) carries the database
passwords, `API_KEY_PEPPER`, the upstream credential vault key
(`UPSTREAM_CREDENTIAL_KEY`), WooCommerce consumer key/secret, the WordPress
admin password and the optional `GROQ_API_KEY`. Demo **gateway API keys**
(`umk_…`) are created at bootstrap time (commands in
[infra/helm/README.md](./infra/helm/README.md) "Secrets and API-key bootstrap")
and shown to you exactly once — keep them in a local file outside the repo
(the demo runbook uses a git-ignored `keys.json`), pass them as shell variables,
and never paste them into screenshots, issues or commits. Revoke and re-issue
any key that leaks (dashboard → Team / Settings → Revoke — see
[docs/demo-runbook.md](./docs/demo-runbook.md) §5). The repository is scanned
for key-shaped strings before every commit; only clearly-labelled test fixtures
(fakes like `gsk_test_…`) are allowed.

## Local demo vs public deployment

What you get from this repo **today** is the local demonstration: the kind
cluster `urumi-local` with two stable demo hosts —
`http://dashboard.urumi.test:18080` and `http://shop.urumi.test:18080` —
reachable through one `kubectl port-forward` to the `ingress-nginx` controller
plus `/etc/hosts` entries (or `curl --resolve` / Playwright
`--host-resolver-rules`). Ports: `18080` = ingress (both hosts), `8088` =
dashboard fallback, `8080` = gateway fallback (curl/SDK). Nothing serves on
port 80 locally.

A **public** deployment (VPS/k3s, real DNS, TLS) is documented step by step in
[infra/helm/README.md](./infra/helm/README.md) "Deploying to a future VPS" and
differs **only through Helm values** (`values-prod.yaml`: real domain + TLS at
the ingress, operator Secrets instead of dev placeholders, storage class,
2 gateway replicas) — but it has **not been executed or verified** and no
domain, certificate or host is provisioned by this project. The design
tradeoffs of that split are in [docs/architecture.md §12](./docs/architecture.md).

## Teardown (preserves data by default)

None of the demo steps require destroying anything — the store's orders and
users intentionally accumulate. When you *do* want to tear down, the safe
sequence is in [infra/helm/README.md](./infra/helm/README.md) "Cleanup
(preserves data by default)": scale workloads to zero or `helm uninstall` —
both keep the PostgreSQL and WordPress PVCs (`helm.sh/resource-policy=keep`);
delete the PVCs or the kind cluster only if you explicitly want to lose the
data (marked destructive in that document). To stop the local demo access
points only: `pkill -f "port-forward"`.

## Standout Features Implemented

Status of the assignment's "Other ways to stand out" categories, with the
evidence behind each claim (an honest ✅ means implemented **and** covered by
tests; "verified in cluster" means checked against the running kind cluster):

| Category | Status | Where | Tests | In cluster? | Limitations |
| --- | --- | --- | --- | --- | --- |
| **2. Tool permissions** | ✅ implemented | per-user grants + reader write-ceiling in `apps/gateway/src/auth/authorization.ts`; **unauthorized tools hidden from `tools/list`** (`apps/gateway/src/mcp-server.ts`) and rejected if called directly; identical rule for chat and external clients | `authz-e2e.test.ts` (hiding + rejection), `authorization.test.ts`, dashboard `permissions.test.ts` parity | ✅ verified 2026-10-26: admin sees all 9 tools, member sees only their 5 granted reads (writes hidden) | dashboard *catalogue* intentionally lists everything with permission badges — it is an inspection view, not the client tool list |
| **6. Security hardening** | ✅ implemented | SSRF allow-list + private-address classifier (`config.ts`), AES-256-GCM credential vault (D34), non-root images, `automountServiceAccountToken: false`, NetworkPolicy template with `allowIngressNamespaces` exception, log scrubbing | `ssrf.test.ts`, `upstream-credentials.test.ts`, `logger.test.ts`, helm assertions 10/10 | ✅ verified — **NetworkPolicy enforcement proven live** (deny-policy probe: blocked, selective, restored; kindnet kind v0.33 enforces) | policy stays disabled by default: enabling without the ingress-namespace exception blocks the demo Ingress |
| **8. Observability** | ✅ implemented | per-server tool-call metrics (calls, errors, avg/max latency, last call) aggregated from the audit log: `toolStats()` in `db/postgres-audit-repository.ts`, served on `GET /api/upstreams` (`stats`), rendered on the Upstreams page; **clear failure reasons** (`upstream-registry.ts` describeError) | `api.test.ts` (stats shape + member safety), `postgres.test.ts` (SQL aggregation), dashboard `selectors.test.ts` | ✅ verified 2026-10-26: live stats (e.g. woocommerce 215 calls / 2 errors / avg 33 ms) and `last_error` now reads "connection failed — the server is not reachable from the gateway" during a pod-kill drill | metrics cover this gateway's own audit history (not a time-series DB) |
| **9. Upgrades and rollback** | ✅ documented **and tested** | `infra/helm/README.md` "Upgrades and rollback" | verified drill (below) | ✅ verified 2026-10-26: `helm upgrade` → revision 20; `helm rollback` → revision 21; 9/9 pods, 3 PVCs, all data intact | none |
| 1. VPS deployment | 🟡 documented only | `values-prod.yaml`, helm README VPS outline | — | ❌ never deployed | no reliable free VPS at ₹0 — explicitly not claimed |
| **7. Scaling** | ✅ implemented & **verified** | 2 gateway replicas with **sticky MCP sessions** (Service `sessionAffinity: ClientIP` — MCP transports are per-pod in-memory, D37), PG-backed dashboard sessions, per-key rate limits | chart assertions 8/9; rate-limit suites | ✅ 2026-10-26 drill: 2 pods, both reach all upstreams, one MCP session ran initialize→tools/list→tools/call→tools/list through the Service; dashboard login OK | rate limiter is per-process (documented trade-off, D37); local values keep 1 replica (RAM) |
| 4. Many tools | ✅ evaluated — **not needed** | 9 tools across 3 servers: grants-filtered `tools/list`, dashboard search/filter, qualified names for collisions | — | — | scale-out strategy would add abstraction the PDF itself says to avoid at this size |\n| 3. OAuth · 5. Hosted MCP servers | not attempted | — | — | — | working core prioritized per the PDF |
| Bonus: multi-store provisioning | **not attempted** | — | — | — | PDF says attempt only after the core; deliberately skipped |

### Reproduce the scaling verification (stand-out 7)

```bash
bash scripts/scale-drill.sh
```

Output interpretation: each line is `PASS`/`FAIL`/`BLOCKED`. Two checks must
not be confused — **check 2** proves *each replica independently reaches every
upstream* (`/readyz` inside each pod, explicitly labelled "NOT a session
test"); **check 3** proves *MCP session continuity* (initialize → tools/list →
tools/call → tools/list on ONE session through the Service while 2 replicas
run). Sessions are pinned to their pod by `sessionAffinity: ClientIP` — the
documented design (D37) — so this is **not** a cross-replica session-migration
test (in-memory MCP sessions cannot migrate). The script restores the original
replica count via a trap even on failure, never touches PVCs/data, and never
prints credentials. Latest run (2026-10-26): **RESULT: PASS**.

### Latest verification status (2026-10-26)

Every mandatory definition-of-done item was re-verified live with
PASS/BLOCKED labels in [docs/requirement-matrix.md §15](./docs/requirement-matrix.md)
(including the NetworkPolicy enforcement probe). Summary: 12 PASS, 1 BLOCKED
(chat-agent product creation — Groq quota, provider untouched), 0 FAIL.

## Submission checklist

**Mandatory requirements** — ✅ complete and verified (local Kubernetes, Helm
local+prod values, everything in-cluster with persistent storage, Ingress +
local domains, probes/limits, no hardcoded secrets, first-written WooCommerce
MCP with 5 tools and documented REST rationale, internal-only upstreams,
gateway add/edit/disable/remove with encrypted static credentials, one MCP
endpoint with qualified-name collision handling, failure isolation + timeouts,
server-side credentials, 3 upstreams, roles/keys/revocation/hashed storage,
audit log in dashboard, chat agent with tool loop acting as the user). The
**two user-A chat lines of the definition of done remain quota-blocked** (see
Known limitations) — everything else in the DoD is live-executed
(`docs/demo-runbook.md` T0–T11).

**Multi-store provisioning bonus** — **not implemented** (by choice).

**Other standout categories** — see "Standout Features Implemented" above:
✅ 2 (tool permissions), ✅ 6 (security hardening), ✅ 8 (observability),
✅ 9 (upgrades/rollback); 🟡 1 (VPS — documented), 🟡 7 (scaling — prepared);
not attempted: 3, 4, 5.

**Demo video requirements** — outline ready in
`docs/recording-script.md` (7-minute script incl. the honest chat-quota
fallback); **the video itself is not yet recorded**.

**GitHub repository** — `https://github.com/ishaan-bits/woocommerce_mcp`,
`main` branch, clean history, no secrets (scanned), assignment PDF included.

**Remaining submission actions** (in order):
1. Record the demo video (`docs/recording-script.md`) and submit the form.
2. Optional: one live chat turn when the Groq quota resets → flip D3/D4 in
   `docs/requirement-matrix.md` from ⛔ to ✅ with evidence.
3. Optional: rebuild images at deploy time on any future host (the fix for
   the body-parser advisory is in the lockfile; running images carry it since
   the 2026-10-26 rebuild).

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
| 11 | Assignment reconciliation + DoD | ✅ done (VPS remains outline-only): admin-managed dynamic upstreams with AES-256-GCM credentials (D34), member self-serve keys, Ingress hosts for dashboard+storefront, chat reliability (D35), and the **two-user definition-of-done walkthrough** live-executed end to end — [docs/demo-runbook.md](./docs/demo-runbook.md) |

Details and the *why* for each ordering: [docs/architecture.md § 11](./docs/architecture.md).
