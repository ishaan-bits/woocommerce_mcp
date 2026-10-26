# Requirement matrix — original assignment (PDF) and milestones

Section 0 reconciles the **original assignment PDF** (`docs/Urumi-MCP-Gateway-Assignment.pdf`,
8 pages) against this repository as of the start of Milestone 11. Sections 1–10
map each milestone to the code that implements it and the check that proves it.
Every "verification" cell names a command in this repo; live checks were run
against the kind cluster `urumi-local` (Helm release `urumi`, namespace `urumi`)
and can be repeated with the shown commands. Nothing here is claimed without a
passing check — see "Explicitly not claimed" at the bottom.

## 0. Original assignment (PDF) — mandatory requirement reconciliation

Statuses were recorded **before** any Milestone 11 code changes, from evidence
in this repository and the live cluster. Documentation alone is never counted
as "verified" for a functional requirement; where only docs exist the status is
`🟡 partial` or `❌ missing` with the gap named. `⛔` means the environment or
this milestone's rules prevent it. `optional` rows are the PDF's bonus/stand-out
items, which the PDF itself marks non-mandatory.

### 0.1 Kubernetes and Helm (PDF p.3)

| # | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| K1 | Runs on local Kubernetes (Kind/k3d/Minikube) | ✅ verified | kind cluster `urumi-local`, Helm release `urumi` in ns `urumi`, 9 live deployments (§9) |
| K2 | Deployable to a production-like VPS (k3s) with the same Helm charts, config changes only | 🟡 partial | `values-prod.yaml` renders/lints clean and `infra/helm/README.md` has "Deploying to a future VPS (outline — prepared, not executed here)" — **no VPS was ever deployed** (§9) |
| K3 | Helm mandatory (no Kustomize); local/prod differences via values files | ✅ verified | only `infra/helm/mcp-gateway` + `values-local.yaml`/`values-prod.yaml`; no Kustomize manifests in repo; `helm lint` 2/2 (§6) |
| K4 | Everything runs in the cluster: store, store DB, WooCommerce MCP, gateway, dashboard | ✅ verified | 9 deployments incl. `wordpress`, `wordpress-db`, `woocommerce-mcp`, `gateway`, `dashboard` (§3, §9) |
| K5 | Store DB and WordPress content use persistent storage | ✅ verified | 3 PVCs `Bound`; `helm.sh/resource-policy=keep` so uninstall preserves them (§9) |
| K6 | Storefront and dashboard exposed through **Ingress** with stable URLs; local domain approach documented | ✅ verified | `ingress-nginx` (chart 4.15.1) installed on kind `urumi-local`; Ingress `mcp-gateway` serves `dashboard.urumi.test` (`/` → dashboard, `/mcp` + `/api` → gateway) and `shop.urumi.test` (`/` → wordpress); local-domain approach documented (README, `infra/helm/README.md` "Access", `docs/architecture.md` §8) incl. the single `:18080` port-forward + `/etc/hosts`/`--resolve` path; live-checked (curl + Playwright: both hosts render, login forms answer, canonical URLs stable) |
| K7 | Readiness/liveness checks and resource requests+limits on every workload | ✅ verified | all 9 deployments have both probes + CPU/memory limits (§9) |
| K8 | No hardcoded secrets in source; credentials in Kubernetes Secrets | ✅ verified | `scripts/security/assert-helm-security.sh` 7/7 (prod render ships 0 Secret manifests, no inline credential literals), tree/commit secret scans 0 matches (§6, §7) |

### 0.2 WooCommerce MCP server (PDF p.4)

| # | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| W1 | Written by us, no existing WooCommerce MCP plugin | ✅ verified | `services/woocommerce-mcp` first-party source, 70 tests |
| W2 | Speaks MCP over Streamable HTTP | ✅ verified | SDK Streamable HTTP server; reached through the gateway by the official SDK client (§5) |
| W3 | Exposes ≥ list products, create product, list orders, get order, update order status | ✅ verified | exactly those 5 tools; live `woocommerce_list_products` → 4 real SKUs (§3) |
| W4 | Not reachable from outside the cluster; only the gateway can call it | ✅ verified | ClusterIP-only service; security-demo check "internal services not exposed" (§9) |
| W5 | Documented how it talks to the store and why | ✅ verified | `docs/architecture.md` §7 (REST API rationale) + `services/woocommerce-mcp/README.md` |

### 0.3 Gateway (PDF p.4)

| # | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| G1 | Admins can **add, edit, disable and remove** upstream MCP servers by URL with an **optional static credential (header or bearer)** | ✅ resolved | Milestone 11 Phase 1 (D34): admin API `POST/PUT/DELETE /api/upstreams` + `UpstreamsPage` UI (name, URL, enable, optional `bearer`/`header` credential); registry `addOrUpdateServer`/`removeServer` with live re-discovery; unique-URL enforcement; fixed ids refuse edit/delete. Credential is **encrypted at rest** (AES-256-GCM, AAD-bound to the upstream id), 3-state patch (omit/null/object), never returned or logged; feature fails closed 503 without `UPSTREAM_CREDENTIAL_KEY`. Tests: `upstream-crud.test.ts`, `upstream-credentials.test.ts`, `postgres.test.ts` (D34) |
| G2 | One MCP endpoint; tools/list returns every enabled server's tools; calls routed to the right server | ✅ verified | `/mcp` single endpoint, 9 live tools, qualified-name routing (§5, §9) |
| G3 | Same tool name on two servers handled by a documented scheme | ✅ verified | `<upstream>_<tool>` qualified names, collision tests, `docs/architecture.md` §5 |
| G4 | Slow/dead upstream doesn't break listing/calls to others; timeouts + clear error | ✅ verified | C7 isolation tests, per-upstream timeouts, chat maps 504, registry semaphore tests (§ matrix rows in threat-model C7) |
| G5 | Upstream credentials stay server-side; never sent to browser or MCP client | ✅ verified | WooCommerce consumer key/secret exist only as env in the `woocommerce-mcp` Pod. Admin-entered dynamic credentials (Phase 1) are AES-256-GCM ciphertext in Postgres and plaintext only inside the gateway process to the upstream hop; responses/audit/logs carry redaction or a boolean `has_credential` only (URLs admin-only, C4). Tests: `upstream-credentials.test.ts` (round-trip/AAD/fail-closed), `upstream-crud.test.ts` ("encrypted credential: stored as ciphertext only, redacted from responses and logs"), live Phase 1 redaction check (threat-model C3) |
| G6 | ≥3 upstream servers connected | ✅ verified | `woocommerce`, `inventory`, `support` → 9 tools live (§9) |

### 0.4 Team and access (PDF p.4)

| # | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| T1 | ≥2 roles: admin (manages servers+members) and member (uses tools) | ✅ verified | role enum `admin`/`reader` (member ≡ reader; naming documented in dashboard `roleLabel`), RBAC tests incl. "grants bind admins too" (§2) |
| T2 | Per-user gateway API key, revocable, stored hashed | ✅ verified | sha256+pepper storage, `key_revoked` audit, live revoked key → 401 (§9 security-demo 7/7) |
| T3 | Every tool call audited (user, server, tool, timestamp, duration, outcome), visible in the dashboard | ✅ verified | `audit_log` columns + Audit page filters; live rows attributed per user (§9) |

### 0.5 Chat agent (PDF p.4)

| # | Requirement | Status | Evidence / gap |
| --- | --- | --- | --- |
| C1 | Dashboard chat uses an LLM to call tools through the gateway and **shows which tools it called** | ✅ verified (automated) | agent loop + provider tests; `ChatPage` renders `tool_calls` under each reply (`aria-label="Tool calls"`). Live LLM calls: Milestone 9 only — **not re-run in Milestone 11** (no-spend rule) |
| C2 | Acts as the logged-in user; calls appear in audit under that user | ✅ verified | agent executes with the request principal through the shared pipeline (D30), agent tests assert audit attribution |
| C3 | Model/provider free choice | ✅ verified | Groq free tier or any OpenAI-compatible base URL (D29); clean 503 with no key |
| C4 | LLM API keys follow the same secret rule | ✅ verified | optional `GROQ_API_KEY` via `secretKeyRef` only; prod renders no key; no literals (K8) |

### 0.6 Definition of done — two-user demo (PDF pp.3–4)

| # | DoD step | Status | Evidence / gap |
| --- | --- | --- | --- |
| D1 | Storefront: add product to cart, check out with test-friendly method (COD) | ✅ verified | Phase 4 live (Playwright against `shop.urumi.test:18080`): catalog → product → add to cart → block checkout → **Cash on delivery** (enabled once via `wc/v3/payment_gateways/cod`, the PDF's sanctioned test method) → order-received **#17** (`$12.00`, "Payment: Cash on delivery"). Runbook **T1** (`docs/demo-runbook.md`); re-runnable with `scripts/demo/storefront-checkout.cjs` |
| D2 | Order visible in WooCommerce admin | ✅ verified | Phase 4 live (Playwright): wp-admin login (password from `urumi-secrets` via env, never printed) → **WooCommerce → Orders** shows `#17 Ada Lovelace … Processing $12.00` next to seeded #14/#15. Cross-check through our own tool: user B `woocommerce_list_orders` → `[14, 15, 17]`. Runbook **T2** |
| D3 | User A chat: agent creates a product; it appears on the storefront | ✅ verified (live 2026-10-26) | chat agent created **"Local LLM Demo Product"** (SKU `LLM-DEMO-001`, $5.99) via `woocommerce_create_product` **through the gateway** (`provider: groq:openai/gpt-oss-120b` in the quota window; the local Ollama fallback answers the same tool loop when quota blocks — verified separately, §17). Product visible on `/shop/` and at `product/local-llm-demo-product/` |
| D4 | User A: place order by hand, ask agent "orders today", it returns that order | ✅ verified (live 2026-10-26) | storefront checkout (browser) placed order **#22** ($5.99) for the chat-created product; the chat agent's "What orders came in today?" called `woocommerce_list_orders` and returned **#22, $5.99** |
| D5 | User B external client: gateway URL + own key only → sees tools of every enabled server, answers the orders question | ✅ verified | Phase 4 live: official MCP SDK vs deployed gateway → 3/3 (handshake + `tools/list` 9 tools from 3 servers; `tools/call`; two-upstream D6) and the orders question returns **#17**; `GATEWAY_URL=… GATEWAY_API_KEY=… node --test apps/gateway/test/external-client.test.ts`. Runbook **T5** |
| D6 | One prompt needing tools from **two different upstreams** | ✅ verified | Phase 4 live: one member session calls `woocommerce_list_products` **and** `inventory_list_products` successfully (reader grants cover both). Automated twins: `external-client.test.ts` "DoD D6" (live-gated) + `dod-flow.test.ts` "D6" (deterministic harness). Runbook **T6** |
| D7 | Revoke user B's key → next call rejected | ✅ verified | Phase 4 live: user B self-serves a key (`POST /api/me/keys` → 201, plaintext once) → call works → user A `POST /api/keys/:id/revoke` → 200 → next MCP call **401**, `GET /api/me` **401**; `key_created`/`key_revoked` audited. Tests: `dod-flow.test.ts` D7/D10, `api.test.ts`, `auth-middleware.test.ts`, postgres integration. Runbook **T7** |
| D8 | Disable one upstream → its tools disappear from chat agent **and** external client | ✅ verified | Phase 4 live round-trip: 9→7→9 tools; `inventory_*` gone from the member's `tools/list` **and** the `GET /api/tools` mirror the chat/Tools UI uses; `woocommerce_*` intact; `upstream_disabled`/`upstream_enabled` audited. Tests: `dod-flow.test.ts` D8 (agent offered list + client list), `mcp-protocol.test.ts`. Runbook **T8** |
| D9 | Kill one upstream pod → others keep working; dashboard shows the dead one as unreachable | ✅ verified | Phase 4 live (scale `inventory-mcp` to 0 for an observable window; literal `kubectl delete pod` variant in the runbook): `inventory_list_products` → tool error *"upstream 'inventory' is unreachable (the connection failed)"*, sibling `woocommerce_list_products` → success, `GET /api/upstreams` → `reachable:false` + `last_error`, recovery after restore. Tests: `dod-flow.test.ts` D9, `mcp-failure.test.ts`, `real-upstreams.test.ts` (SIGKILL). Cosmetic gap noted: `last_error` renders as generic `TypeError`. Runbook **T9** |
| D10 | Every call above appears in the audit log attributed to the right user | ✅ verified | Phase 4 live audit table (runbook **T10**): 14 `tool_call` rows attributed to user B with upstream/tool/outcome/duration, `key_created` (B), `key_revoked` (A, names the key), `upstream_disabled`/`upstream_enabled` (A), `auth_failed` for the revoked key's attempts. Tests: `dod-flow.test.ts` D10, `postgres.test.ts` (exactly-one row per call) |

### 0.7 User stories (PDF p.2)

| # | Story | Status | Evidence / gap |
| --- | --- | --- | --- |
| A1 | Admin sees registered servers with status (Connected/Unreachable/Disabled) and their tools | ✅ verified | `UpstreamsPage` status badges (`Healthy` / `Degraded (unreachable)` / `Disabled` via `upstreamHealthText`) + expandable tool lists, `ToolsPage` catalogue |
| A2 | WooCommerce already registered as the first server | ✅ verified | config builds registry from `UPSTREAM_IDS` starting with `woocommerce`; live first row |
| A3 | Admin adds another server by URL and credential, edits/disables/removes it | ✅ resolved | same evidence as G1 (Milestone 11 Phase 1); live on kind: admin created a dynamic server with a credential against the real `inventory-mcp`, its tools joined `tools/list` and were callable, member view redacted the URL, delete removed the row and unregistered the server |
| A4 | Invite members, issue/revoke their keys | ✅ verified | Team page + `POST /api/users`, `POST /api/keys`, `POST /api/keys/:id/revoke` |
| A5 | Audit log of every tool call: who, which server/tool, when, duration, success | ✅ verified | Audit page + T3 |
| M1 | Member generates **their own** API key in the dashboard | ✅ verified | self-serve `POST/GET /api/me/keys` (user id always from the credential, plaintext returned once, `key_created` audited) + member-visible "Your API keys" card on Settings; live-checked on kind — reader mints a key and it authenticates immediately |
| M2 | One gateway URL + own key in an MCP client → sees every enabled server's tools | ✅ verified | D5 evidence (§5 live) |
| M3 | Use dashboard chat agent answered with those tools | ✅ verified | C1/C2 (chat available to authenticated users; executes under own grants) |
| M4 | Never sees or needs upstream credentials | ✅ verified | threat-model C3; no API returns upstream credentials (Phase 1 must keep this true for dynamic credentials) |

### 0.8 Repo deliverables (PDF p.7)

| # | Deliverable | Status | Evidence / gap |
| --- | --- | --- | --- |
| R1 | README: local setup instructions | ✅ verified | README setup + live-checked commands used every milestone |
| R2 | README: VPS/production-like (k3s) setup | 🟡 partial | outline documented, explicitly **not executed** (K2) |
| R3 | README: how to **place an order**, connect an external MCP client, use the chat agent | ✅ verified | README "Place an order (storefront, cash on delivery)" + "External MCP clients" + the LLM/chat agent row; full scripted walkthrough in `docs/demo-runbook.md` (order placement T1/T2 live-executed, 2026-10-22) |
| R4 | Source: dashboard, backend/gateway, WooCommerce MCP server, chat agent | ✅ verified | `apps/dashboard`, `apps/gateway`, `services/woocommerce-mcp`, agent in `apps/gateway/src/agent` |
| R5 | Helm charts + values files (local and production) | ✅ verified | `infra/helm/mcp-gateway` + both values files |
| R6 | Short "System design and tradeoffs" note (architecture, aggregation/routing/failure, prod changes) | ✅ verified | `docs/architecture.md` **§12 "System design and tradeoffs"** — framed as the PDF asks: architecture choices (one gateway server+client, shared `executeToolCall`), aggregation/routing/failure handling (qualified names, structural isolation), production deltas (DNS/TLS, storage class, secret `keyRef`s, replicas) with the unverified VPS step called out |
| R7 | Threat-model note with the 4 required bullets (shared upstream creds vs members; why client tokens aren't passed through; untrusted upstreams/tool-description manipulation; member-vs-member) | ✅ verified | `docs/threat-model.md` **§3c** covers all four, each mapped to controls + test names; C3 rewritten (no longer claims "the gateway holds only URLs" — now states both credential classes and what a member can do with a credential they never see) |
| R8 | If bonus/stand-out attempted: list which and where | ✅ verified | §0.9 table now carries a "Where to find" column (tool permissions, SSRF on admin-added URLs, NetworkPolicies/non-root, encrypted upstream credentials); README "Stand-out items attempted" points at it; unattempted items say so |
| R9 | Repo contains the original assignment PDF | ✅ verified | tracked at `docs/Urumi-MCP-Gateway-Assignment.pdf` (8 pages, included in the Milestone 11 commit); §0 reconciles every mandatory requirement against it |

### 0.9 Bonus / stand-out items (PDF pp.5–6 — optional, recorded honestly)

| Item | Status | Where to find |
| --- | --- | --- |
| Bonus: multi-store provisioning | not attempted (PDF: attempt only after core; explicitly out of Milestone 11 scope) | — |
| Stand-out 1: VPS (k3s) deployment | 🟡 outline only — documented, **not implemented or verified** | `infra/helm/README.md` "Deploying to a future VPS (outline — prepared, not executed here)" |
| Stand-out 2: tool permissions — restricted tools **hidden from the tool list** and **rejected** when called directly | ✅ implemented + verified | `apps/gateway/src/mcp-server.ts` (tools/list filtered by the same authorize predicate as execution), `auth/authorization.ts`; `authz-e2e.test.ts` (hiding + rejection); **live 2026-10-26**: admin 9 tools, member 5 (writes hidden). The dashboard catalogue keeps listing everything with permission badges — an inspection view, not the client list |
| Stand-out 3: OAuth on the gateway | not attempted | — |
| Stand-out 4: handling many tools | not attempted | — |
| Stand-out 5: hosted MCP servers by container image | not attempted | — |
| Stand-out 6: security hardening — SSRF protection when admin adds a URL | ✅ for config URLs **and** admin-entered dynamic URLs (Phase 1): the C4 allow-list + private-address classifier run on create/edit; metadata addresses refused at boot | `apps/gateway/src/config.ts` (`assertUpstreamTargetAllowed`), `upstream-crud.test.ts` ("URL validation applies the C4 private-address allow-list") |
| Stand-out 6: NetworkPolicies / non-root | ✅ **enforcement verified** + non-root | `templates/networkpolicy.yaml` (same-namespace-only ingress + `networkPolicy.allowIngressNamespaces` exception for the Ingress controller); **live probe 2026-10-26: kindnet (kind v0.33) DOES enforce** — deny-all on one pod blocked same-namespace traffic, unselected pods unaffected, policy deleted → restored; kept disabled by default because enabling it without the ingress-namespace exception breaks the demo Ingress; containers run non-root ✅ |
| Stand-out 6: **upstream credentials encrypted at rest** | ✅ AES-256-GCM vault (Phase 1): ciphertext in Postgres, AAD-bound to the upstream id, 503 fail-closed without the key | `apps/gateway/src/upstream-credentials.ts`, `upstream-credentials.test.ts`, migration `004_dynamic_upstreams.sql` |
| Stand-out 7: multi-replica gateway + rate limits per key | ✅ implemented **and verified** | per-key rate limits (`limits.ts`) + PG-backed web sessions + Service `sessionAffinity: ClientIP` (MCP transports are per-pod in-memory — D37); chart assertions 8/9; **drill 2026-10-26**: `replicas=2` → both pods reach all 3 upstreams (`/readyz` per pod), one MCP session survived initialize→tools/list→tools/call→tools/list through the Service, dashboard login OK, restored to 1. Local values keep 1 replica (RAM) |
| Stand-out 8: metrics (calls/error rate/latency per server) + clear failure reasons | ✅ implemented + verified | `db/postgres-audit-repository.ts` `toolStats()` (SQL aggregation over the audit log), `GET /api/upstreams` `stats` field, Upstreams page line, `upstream-registry.ts` friendly `describeError`; tests: `api.test.ts`, `postgres.test.ts`, dashboard `selectors.test.ts`; **live 2026-10-26**: real stats shown, and `last_error` during a pod-kill reads "connection failed — the server is not reachable from the gateway" (was `TypeError`) |
| Stand-out 9: upgrade/rollback with Helm | ✅ documented **and tested** | `infra/helm/README.md` "Upgrades and rollback"; drill **2026-10-26**: `helm upgrade` → revision 20, `helm rollback` → revision 21, 9/9 pods + 3 PVCs + all data intact |

### 0.10 Discrepancy log (PDF vs repository at Milestone 11 start)

| # | Discrepancy | Resolution |
| --- | --- | --- |
| X1 | PDF mandates admin add/edit/remove of upstreams **with credentials** (G1/A3); repo is deploy-time config only | ✅ resolved | migration `004_dynamic_upstreams.sql`, AES-256-GCM credential vault (never plaintext in DB/logs/API), live registry add/remove/toggle, admin API `POST/PUT/DELETE /api/upstreams` + dashboard UI; live-checked on kind (create with credential → tools discovered from the real inventory-mcp → redaction → delete) |
| X2 | PDF mandates **Ingress** for storefront + dashboard with documented local domain (K6); repo has none | ✅ resolved | same evidence as K6 — `ingress.storefrontHost` chart value + storefront rule in `templates/ingress.yaml`, `ingress-nginx` controller on the existing kind cluster, docs in README/`infra/helm/README.md`/architecture §8; port-forward paths preserved as fallback |
| X3 | DoD/user stories need the member to reach **multiple** upstreams and a two-upstream prompt (D6, M2); `reader-demo` is granted only `woocommerce` | ✅ resolved | migration `005_demo_grants.sql` (additive, keyed on the two seed users, sorted-DISTINCT so re-runs are a no-op): admin gains the 4 inventory/support tools; reader gains `inventory`+`support` upstreams and the 2 read-only tools (writes stay admin-only). Live on kind: one reader key calls `inventory_list_products` **and** `woocommerce_list_products` in a single MCP session |
| X4 | Member story M1: self-service key issuance; repo issues keys admin-only | ✅ resolved | same evidence as M1 — `POST/GET /api/me/keys` + Settings-page UI; `listKeysForUser` scopes the listing to the caller so no other member's keys are visible |
| X5 | Threat model must contain the 4 PDF bullets (R7) and stop claiming the gateway holds only URLs once dynamic credentials exist | ✅ resolved | `docs/threat-model.md` §3c (all four bullets with control/test mapping) + C3 rewritten for the two credential classes (D34) |
| X6 | README lacks order-placement how-to; "System design and tradeoffs" note and stand-out list missing (R3/R6/R8) | ✅ resolved | README "Place an order (storefront, cash on delivery)" + "Stand-out items attempted"; `docs/architecture.md` §12 |
| X7 | Stale claim in §9 below ("the PDF is not present") | fixed in this edit — PDF now tracked at `docs/Urumi-MCP-Gateway-Assignment.pdf` |

## 1. Backend regressions and honest settings (Phase A)

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| `GET /api/settings` reports display config honestly and returns `null` for anything unset (no invented defaults) | `apps/gateway/src/api/routes.ts` (settings route), `apps/gateway/src/config.ts` (`gatewayPublicUrl`), `apps/gateway/test/helpers/config.ts` (null default) | `apps/gateway/test/api.test.ts`, `test/config.test.ts` — full gateway suite green |
| Store-mode label is deploy-time configuration, never a runtime guess | `WOOCOMMERCE_STORE_MODE` in `templates/gateway.yaml`, echoed by the settings route | `test/api.test.ts`; live: `GET /api/settings` with a Bearer key |
| Audit rows stay filterable after the `action` dimension (D22) | `apps/gateway/src/db/*audit-repository.ts` | `test/audit.test.ts`, `test/integration/postgres.test.ts` (run with `TEST_DATABASE_URL`) |

## 2. Dashboard overhaul and the tool-permission indicator (Phase B)

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| Team (members/API keys) and Settings areas, route-driven SPA (`#/team`, `#/settings`) | `apps/dashboard/src/pages/TeamPage.tsx`, `SettingsPage.tsx`, `src/lib/routes.ts` | dashboard suite (`npm run test -w @mcp/dashboard`), `tsc` typecheck, `vite build` |
| Permission indicator shows **exactly** what the server enforces — grants bind admins too (no admin bypass) | `apps/dashboard/src/lib/permissions.ts` (`canUseTool` mirrors `apps/gateway/src/auth/authorization.ts` check order: parse → reader write ceiling → upstream grant → tool grant) | Regression tests on **both** sides: `apps/dashboard/test/permissions.test.ts` ("REGRESSION: admins are bound by their grants…", parity matrix) and `apps/gateway/test/authorization.test.ts` ("REGRESSION: grants bind admins too…") |
| Copy never claims "admin = all tools" | `MemberForm.tsx` role hint + grant explainer reworded | same dashboard suite; code search for `bypass`/`full access` |
| Live parity: indicator "allowed" ⇔ gateway accepts the call | — | Live against the deployed gateway: key with 5 `tools:woocommerce_*` grants → `woocommerce_list_products` returns the 4 real products; `inventory_list_products` (not granted) returns JSON-RPC error `-32003 … not granted to this principal` |

## 3. Real WordPress/WooCommerce store in Kubernetes (Phase C)

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| One Helm chart provisions MariaDB + WordPress (init container: version-pinned WP core + WooCommerce, idempotent seed of 4 products / 2 orders / API key) | `templates/wordpress-db.yaml`, `templates/wordpress.yaml` (ConfigMap `init.sh`/`seed.php`) | `helm lint` (local + prod), live: `kubectl -n urumi logs deploy/wordpress -c wp-init` → `wordpress-init: store ready` |
| Store mode chosen at deploy time with **no silent fallback** (mock needs the mock chart; real needs WordPress or an explicit URL) | `templates/woocommerce-mcp.yaml` `fail` guards, `values.schema.json` | Negative renders all fail: `--set woocommerceMcp.storeMode=mock --set mockStore.enabled=false`, `storeMode=real wordpress.enabled=false storeUrl=`, `storeMode=banana` (schema) |
| REST API reachable at pretty `/wp-json/…` (no query strings, architecture §7) | init writes `.htaccess` directly (WP-CLI cannot detect Apache from CLI SAPI) + `urumi-links.conf` mounted at `/etc/apache2/conf-enabled/` (`AllowOverride All`) | live: `wget http://wordpress/wp-json/` → `HTTP/1.1 200`; products/orders fetched with Basic auth |
| Basic auth works for plain-HTTP in-cluster traffic | init `--extra-php` sets `$_SERVER['HTTPS']='on'` for the `wordpress` host (WC only authenticates Basic over HTTPS) | live: authenticated `wc/v3/products` → 4 products, `wc/v3/orders` → 2 completed orders (secrets read from env in-container, never printed) |
| Liveness/readiness probe the pod can actually pass | probes use numeric `port: 80`, `path: /wp-login.php` (a named port resolved to 8082 under kubelet) | live: pod `1/1 Running`, `RESTARTS 0` across the liveness window after rollout |
| WooCommerce MCP uses the real store in cluster | `WOOCOMMERCE_STORE_URL=http://wordpress` (mode label `WOOCOMMERCE_STORE_MODE=real` on the gateway) | live: `GET /api/upstreams` → `woocommerce mode: real` |
| The gateway serves the real products over MCP | gateway → `woocommerce-mcp` → WordPress | live: `tools/call woocommerce_list_products` over `/mcp` → 4 products (`URUMI-TEA-001`, `URUMI-CHAI-001`, `URUMI-COF-001`, `URUMI-MUG-001`) |

## 4. Agent-loop regression tests (Phase D)

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| Agent loop regressions: grounding, authz inside the loop, injection containment, round limits, provider failures, secrets | `apps/gateway/test/agent/agent.test.ts` (incl. the live-Groq round-2 wire-shape regression) | gateway suite (runs in `npm run test`, green) |
| Provider adapter wire shape and error mapping (never leaks the key) | `apps/gateway/test/agent/provider.test.ts` | gateway suite |
| Chat HTTP surface (401/403/429/503/504, shared C7 bucket) | `apps/gateway/test/chat-api.test.ts` | gateway suite |

## 5. External MCP client compatibility (Phase E)

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| Official MCP TypeScript SDK acts as an outside client against a **live** gateway; explicit skip with printed reason when env is unset | `apps/gateway/test/external-client.test.ts` (gated on `GATEWAY_URL` + `GATEWAY_API_KEY`, key never printed) | Live: `GATEWAY_URL=… GATEWAY_API_KEY=… node --test apps/gateway/test/external-client.test.ts` → 2/2 pass; without env → explicit skip message |
| In-process protocol conformance for every suite run | `apps/gateway/test/mcp-protocol.test.ts` (SDK client over Streamable HTTP against the harness) | gateway suite |
| Documented how-to for humans (test + MCP Inspector) | README "External MCP clients (Milestone 10)" | this matrix row |

## 6. Helm / security verification (Phase F)

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| Chart regression assertions (ClusterIP-only internals, no token automount, prod ships no Secret, no credential literals, SSRF allow-list, optional chat key, WordPress secret wiring + store-mode agreement) | `scripts/security/assert-helm-security.sh` | `bash scripts/security/assert-helm-security.sh` → `ASSERT OK` (also runs inside `scripts/check.sh`) |
| Both value files lint and render; dangerous combinations fail | `values.schema.json`, template `fail` guards | `helm lint -f values-local.yaml`, `helm lint -f values-prod.yaml`; negative renders in section 3 |
| Least privilege for the new workloads | `wordpress.yaml`/`wordpress-db.yaml` securityContexts, `automountServiceAccountToken: false` (assertion 2) | assertion script |

## 7. Complete quality gates (Phase G)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck, build, unit + integration tests (PostgreSQL included), shared import smoke, Helm assertions, npm audit | `TEST_DATABASE_URL=… bash scripts/check.sh` | `All required checks passed.` (`npm audit`: 0 vulnerabilities) |
| All five images build | `docker build -f infra/docker/<name>/Dockerfile -t urumi/<name>:0.1.0 .` | five `Successfully tagged` results |
| Test totals | `TEST_DATABASE_URL=… npm run test` | see README "Current status" (updated each milestone) |
| Secret scan of the staged diff + tree | forbidden-pattern scan (demo keys, Groq keys, `umk_`/`ck_`/`cs_` literals) | run before the commit; 0 matches (only documented fixtures allowed) |

## 8. Documentation (Phase H)

| Requirement | Implemented in |
| --- | --- |
| This matrix | `docs/requirement-matrix.md` |
| Decision record for the real store (deploy-time selection, HTTPS marker, probe/`.htaccess` lessons) | `docs/decisions.md` D31 |
| README status/roadmap honesty (mock vs real, external clients, test totals) | `README.md` |
| Store README no longer claims "real store impossible" | `services/woocommerce-mcp/README.md` |

## 9. Continuation verification (same day, after the Milestone 10 commit)

Re-run against the live release (Helm `urumi`, namespace `urumi`); every row was
executed, not assumed. At the time of this continuation the original assignment
PDF was not in the workspace, so requirements were traced from `README.md`, this
matrix and `docs/decisions.md`; the PDF has since been added at
`docs/Urumi-MCP-Gateway-Assignment.pdf` and is reconciled in §0 above.

| Item | Evidence |
| --- | --- |
| Protocol negative paths through the gateway session | `tools/list` → 9 qualified tools; unknown tool → JSON-RPC `-32602 Unknown tool`; malformed `after` filter → `-32602 Input validation error` (ajv schema); tool outside the key's grants → `-32003 not granted to this principal` |
| Security demos against the deployed stack | `NAMESPACE=urumi bash scripts/security-demo.sh` → **7/7 PASS** (ClusterIP-only internal services, SSRF boot refusal for a metadata-service upstream, revoked key → 401, reader 403 + `denied` audit row, 39/60 burst calls rate-limited `-32000`/429, failed-logins → 429, no key/password material in 5000 gateway log lines) |
| Upstream enable/disable round-trip (D24) | `POST /api/upstreams/inventory:disable` → `tools/list` drops to 7 (WooCommerce's 5 intact) → `:enable` → back to 9; audit rows `upstream_disabled` / `upstream_enabled` recorded; idempotent `changed:false` contract per `routes.ts` |
| **Bug fix:** Team → Members tab stuck on the loading skeleton forever | Root cause: `refreshTeam` and `refreshKeys` shared one `useRef` seq inside a single mount effect, so the first loader's result was always discarded (`1 !== 2`). Fixed in `apps/dashboard/src/pages/TeamPage.tsx` (one sequencer per loader); pinned by `test/team-loaders.test.ts` (4 REGRESSION checks); live proof after redeploy: both member rows render, `Create member` present, zero skeletons |
| **Bug fix:** members table crash once the loader actually worked | `GET /api/users` answers camelCase (`allowedUpstreams`, `allowedTools`) while the client's `UserRecord` declared snake_case, so the first real render threw `Cannot read properties of undefined (reading 'length')`. Fixed: interface now mirrors the response (`client.ts`), consumers updated (`TeamPage.tsx`, `MemberForm.tsx`), pinned by `test/user-record.test.ts`; live proof: table renders upstreams/grants per member and the Edit form prefills `reader-demo` with no page errors |
| Pods restart without losing data (assignment restart clause) | `kubectl -n urumi rollout restart deploy/postgres deploy/wordpress` → after rollout: `GET /api/users` → 2, newest audit id still 264, `woocommerce_list_products` → the same 4 SKUs, orders `#15, #14`, in-cluster `curl localhost/wp-login.php` → 200; all three PVCs still `Bound`, no PVC touched |
| Production render cannot inherit local placeholders | `helm template … -f values-prod.yaml`: **0** Secret manifests (operator pre-creates `urumi-gateway-secrets` via `secretKeyRef`), **0** `local-dev-only` literals, **0** inline `value:` credentials; local render intentionally contains the placeholders (8, schema-checked) |
| Probes + resource limits on every workload | All 9 deployments (gateway, dashboard, 3 MCP servers, postgres, wordpress, wordpress-db, store mock) have `livenessProbe` and `readinessProbe` with CPU/memory limits; images run as named non-root users (`node`/`nginx`, pinned to numeric UIDs by the chart) |
| VPS deployment documented, nothing provisioned | New section "Deploying to a future VPS (outline — prepared, not executed here)" in `infra/helm/README.md`: registry push → pre-created Secret → `helm upgrade --install` with `values-prod.yaml` → bootstrap → verify; explicitly labelled untested here |
| Cleanup keeps data by default | `infra/helm/README.md` "Cleanup (preserves data by default)": scale-to-zero and `helm uninstall` keep the PVC (`helm.sh/resource-policy=keep`); destructive steps are commented as such |
| Full quality gates re-run | `TEST_DATABASE_URL=… bash scripts/check.sh` → rc 0 "All required checks passed" (incl. 7/7 helm security assertions); **502/502 tests pass** (94+261+39+38+70), 5/5 image builds, `helm lint` 2/2, `npm audit` 0 vulnerabilities, `git diff HEAD` secret scan 0 matches, external-client live suite **2/2** against the deployed gateway |
| External tool-call still returns real store shape | post-restart `woocommerce_list_products` → 4 products with SKUs `URUMI-TEA-001`, `URUMI-CHAI-001`, `URUMI-COF-001`, `URUMI-MUG-001` (never re-seeded this session) |

## 10. Login / session-expiry fix (continuation milestone: "FIX THE LOGIN")

| Item | Evidence |
| --- | --- |
| **Bug fix:** Safari/WebKit login bounced straight back with "Session expired — sign in again to continue." | Root cause (proven by two-engine reproduction *before* touching code): `sessions.ts` set `Secure` unconditionally, and WebKit silently drops a `Secure` cookie delivered on `http://127.0.0.1` — Chromium's localhost exemption had hidden this from every prior automated check. Pre-fix evidence: webkit `loginStatus:200` yet `storedSessionCookies:0` + bounce + two duplicate toasts; chromium control 1/1 OK. Fix (**D33**): `SESSION_COOKIE_SECURE=auto\|true\|false` (default `auto` = `Secure` iff `req.secure`, honouring `TRUST_PROXY`/`X-Forwarded-Proto`) plumbed `config.ts` → `routes.ts` → `sessions.ts` (`sessionSetCookie(token, ttl, secure)`, `sessionClearCookie(secure)`); Helm chart renders it (ConfigMap + schema enum, `values-prod` documents forcing `true` once TLS is enforced). Boot log confirms `"session_cookie_secure":"auto"`. |
| Session-expiry notice is single-shot and silent on fresh visits | `sessionExpiryShouldNotify()` (dashboard `state.ts`): only `connected` notifies; the 401 handler flips the session ref *synchronously* before React re-renders, so parallel 401s notify once; successful login and logout clear stale toasts (`useToasts().clear`). Pinned by `test/state.test.ts`: checking/anonymous/unreachable → silent, connected → notify, three consecutive 401s → `[true, false, false]`. |
| Regression tests added (+8 → **510 total**) | `apps/gateway/test/sessions.test.ts` (4: Secure-policy matrix, exact set/clear cookie strings with and without `Secure`, `readCookie` parser fail-closed cases); `test/api.test.ts` (+1: `SESSION_COOKIE_SECURE=true` forces `Secure` on set *and* clear over plain http; tightened: auto-over-http has **no** `Secure`, wrong **and** revoked keys → 401 with **no** `Set-Cookie`, raw key absent from `Set-Cookie` and body); `test/config.test.ts` (+1: default/`TRUE `/`false`/invalid env + boot-log summary); `state.test.ts` (+2, above). |
| Live proof in **both** engines after redeploy | `.tmp/login-repro.cjs` against `http://127.0.0.1:8088` — chromium **and** webkit, each: invalid key → `loginStatus:401`, `showsErrorBanner:true`, `stillOnSignIn:true`, `storedCookiesAfterFailure:0`; valid key → `200`, one cookie stored (`secure:false`, `httpOnly:true`, `SameSite:Strict`, `Path:/`, 12 h expiry), `#/overview`, `errorBannerStillPresent:false`, `toasts:[]`, `showsSessionExpired:false`; reload stays on `#/overview`. API trace: `401 /api/me` (silent fresh visit) then all `200`. |
| Live HTTP contract (plain http, `auto`) | login via dashboard proxy **and** direct: 200 + `urumi_session=<…>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` (no `Secure`); `/me` with the cookie → 200; wrong key → 401 uniform `{"error":"unauthorized"}` with **no** `Set-Cookie`; logout → 200 + `Max-Age=0` clear cookie. |
| Full quality gates re-run | `TEST_DATABASE_URL=… bash scripts/check.sh` → rc 0 "All required checks passed"; **510/510 tests** (96 dashboard + 267 gateway + 39 inventory + 38 support + 70 woocommerce), `helm lint` 2/2 (both values files), helm security assertions 7/7, `helm template` renders `SESSION_COOKIE_SECURE` and the schema rejects junk values, diff/staged secret scans 0 matches. |

## 11. Milestone 11 Phase 4 — definition-of-done walkthrough (runbook + live end-to-end)

The PDF's "Definition of done" is now fully mapped in
[`docs/demo-runbook.md`](./demo-runbook.md) (§10 maps every DoD line to its
evidence; no unperformed check is marked verified). Executed 2026-10-22 on the
existing cluster (no resets, no PVC touches, ₹0):

| DoD area | Live result (summary) | Deterministic tests added/pinned |
| --- | --- | --- |
| Store checkout + admin visibility (D1/D2) | Playwright: COD order **#17** placed through `shop.urumi.test:18080`; wp-admin Orders shows `#17 Ada Lovelace … Processing $12.00` | `services/woocommerce-mcp` suite (order tools) |
| External client as user B (D5/D6) | official SDK 3/3; orders question returns #17; two-upstream session (woocommerce + inventory) | `external-client.test.ts` "DoD D6" (live-gated), `dod-flow.test.ts` D6 |
| Key lifecycle (D7, M1) | self-serve mint → works → admin revoke → MCP/REST 401 | `dod-flow.test.ts` D7/D10, `api.test.ts`, `auth-middleware.test.ts` |
| Upstream disable/enable (D8) | 9→7→9 tools across **both** surfaces (client `tools/list` + `GET /api/tools` chat mirror); audited | `dod-flow.test.ts` D8 |
| Failure isolation (D9) | inventory outage fails alone (`… is unreachable (the connection failed)`), woocommerce keeps serving real products, `reachable:false` + `last_error` in `/api/upstreams`, clean recovery | `dod-flow.test.ts` D9, `mcp-failure.test.ts`, `real-upstreams.test.ts` |
| Audit attribution (D10) | 14 `tool_call` rows under user B, `key_revoked` under user A (naming the key), `upstream_disabled/enabled` under user A | `dod-flow.test.ts` D10, `postgres.test.ts` |
| Persistence (restart clause) | `rollout restart` of gateway + wordpress → orders `[14,15,17]`, 4 products, keys and audit intact | `postgres.test.ts` (migrations idempotent) |
| Chat agent as user A (D3/D4) | ✅ **completed later (2026-10-26)** — see the D3/D4 rows and §17 (hosted window + local Ollama fallback); at the time of this Phase-4 pass they were quota-blocked | `agent.test.ts`, `chat-api.test.ts` (incl. mocked 429/retry/recovery) |

New this phase: `apps/gateway/test/dod-flow.test.ts` (5 tests — the in-process
twin of the runbook's team-and-control steps) and the live-gated
"DoD D6" two-upstream test in `external-client.test.ts`. **Release-check
finding:** the storefront archive went blank for guests after the last
WordPress restart — root cause is WooCommerce's own **coming-soon** mode
(`woocommerce_coming_soon = yes`, the plugin's fresh-install default; our seed
never touches it), which serves guests a "Great things are on the horizon"
placeholder on store pages. Fixed with the plugin's own launch switch
(`woocommerce_coming_soon = no`) and re-verified (catalog back: 8 product
links; `scripts/demo/storefront-checkout.cjs` places order #19 end to end).
The runbook now includes this step for reviewers. Full gates after the
suite: `scripts/check.sh` rc 0 — **574/574 tests** (106 dashboard + 321
gateway incl. 14 PostgreSQL integration + 39 inventory + 38 support + 70
woocommerce), `helm lint` 2/2, helm security assertions 7/7, tree + diff
secret scans 0 real matches (documented fixtures only), `npm audit` 0, browser
smoke 4/4 (dashboard + storefront via ingress hosts).

## 12. Milestone 14 — recruiter delivery preparation (docs/readiness only)

No application behavior changed; no statuses above were upgraded — D3/D4 remain
`⛔ blocked` (LLM quota) and K2/R2 remain `🟡 partial` (VPS documented, not
deployed). What this pass added, with evidence:

| Deliverable | Evidence |
| --- | --- |
| Recruiter-first README entry point (what/architecture/security/prereqs/quick start/demo/tests/limitations, with links to architecture §12, this matrix, threat model, runbook) | `README.md` "For recruiters (start here)"; explicitly states **no public deployment exists** |
| Demo runbook review — two demo identities + secure credential handling (`.tmp/demo-keys.json`, 0600, git-ignored; keys loaded as shell vars without printing; regeneration path documented) | `docs/demo-runbook.md` identity block + §0; `git check-ignore .tmp/demo-keys.json` → `.gitignore:23` |
| Reproducible sequence kept (store data → two-upstream routing → reader permissions → revocation → upstream disable/failure isolation → audit → restart persistence) with browser/Groq steps marked MANUAL/BLOCKED | `docs/demo-runbook.md` T1–T11 + legend (dual-status note for T1–T4; §11 chat reliability) |
| Cleanup that never touches PVCs/persistent data | `docs/demo-runbook.md` §12 |
| Recording plan (5–7 min outline, screens/actions/narration, do-not-show checklist, truthful limitations) — **no video recorded** | `docs/recording-script.md` |
| Groq 429 limitation + verified retry behavior documented without re-testing quota | `docs/demo-runbook.md` §11 + `docs/recording-script.md` limitations + D35 |
| Link integrity + command drift check | local link scan **52 ok / 0 broken** (fixed one pre-existing `infra/helm/README.md` relative link); `npm run check` → `scripts/check.sh` confirmed |
| Full gates re-run | `TEST_DATABASE_URL=… bash scripts/check.sh` → **rc 0, 574/574**; helm security assertions **ASSERT OK 7/7**; `npm audit` 0; secret scans 0 (demo keys absent from git status/diff, file 0600) |

## 13. Post-audit improvements — stand-outs 2 + 8 (2026-10-26)

Two highest-value gaps selected from the stand-out audit (all nine categories
evaluated in the milestone report; OAuth / hosted servers / many-tools /
multi-store deliberately not attempted; VPS needs external hosting):

| Change | Files | Tests | Cluster verification (2026-10-26) |
| --- | --- | --- | --- |
| **Hide unauthorized tools from `tools/list`** (stand-out 2) — same `authorize` predicate as execution; chat already filtered | `apps/gateway/src/mcp-server.ts`; `upstream-crud.test.ts` golden path re-pinned to hidden-until-granted; `authz-e2e.test.ts` +2 tests; harness grants now mirror migration-005 seeds (`support_list_tickets`); `authz-e2e` probe retargeted to a name no server exposes | gateway suite green | admin `tools/list` = 9 (writes included), member = 5 reads (writes hidden); direct calls to hidden tools still `-32003` (unchanged) |
| **Observability metrics + clear failure reasons** (stand-out 8) | `db/audit-repository.ts` (`toolStats`, `UpstreamToolStats`), `db/postgres-audit-repository.ts` (SQL GROUP BY over `audit_log`), `api/routes.ts` (`stats` on `GET /api/upstreams`), `upstream-registry.ts` (`describeError` → friendly fixed strings), dashboard `client.ts`/`selectors.ts`/`UpstreamsPage.tsx` | `api.test.ts` (+1), `postgres.test.ts` (+1), dashboard `selectors.test.ts` (+3) | `/api/upstreams` shows real stats (woocommerce 215 calls / 2 errors / avg 33 ms); pod-kill drill: `last_error` = "connection failed — the server is not reachable from the gateway"; sibling upstream kept serving |
| **Helm upgrade/rollback drill** (stand-out 9 evidence) | `infra/helm/README.md` "Upgrades and rollback" (new section) | helm lint 2/2, assertions 7/7 | `helm upgrade` → revision 20; `helm rollback` → revision 21; 9/9 pods, 3 PVCs Bound, orders/keys intact |

Gate after the change: `TEST_DATABASE_URL=… bash scripts/check.sh` → **rc 0,
582/582** (110 dashboard + 325 gateway incl. 15 PostgreSQL integration + 39
inventory + 38 support + 70 woocommerce); `npm audit` 0 (body-parser fix
included in the rebuilt images).

## 14. Post-audit improvements — stand-out 7 + verification sweep (2026-10-26)

Bonus-phase selection from the stand-out audit (A–E priorities): the only
category with a real, safely closable gap was **scaling** (7); security (B) got
a verification sweep + two new chart assertions; many-tools (E) was evaluated
and correctly left alone; multi-store bonus judged unachievable within scope.

| Change | Files | Evidence |
| --- | --- | --- |
| Multi-replica gateway verified + documented (D37) | `infra/helm/README.md` "Scaling the gateway", `docs/decisions.md` D37 | live drill: 2 pods, per-pod upstream connectivity, single MCP session across requests (ClientIP affinity live-confirmed), dashboard PG session OK |
| Chart assertions 8–9 (least-privilege RBAC-free renders; multi-replica pinning) | `scripts/security/assert-helm-security.sh` | `ASSERT OK` 9/9 inside `check.sh`; prod `gateway.replicas: 2` enforced |
| Live security sweep refreshed | `scripts/security-demo.sh` | **7/7 PASS 2026-10-26** (ClusterIP internals, SSRF boot refusal, revoked-key 401, reader 403+audit, burst rate-limit, login throttle, log scrubbing) |
| Many-tools (4) evaluated, no code | this section + README | 9 tools; grants-filtered listing + dashboard search + qualified names already scale; per PDF "implement only if genuinely needed" |

Gate: `check.sh` rc 0, **582/582**, helm assertions **9/9**, `npm audit` 0.

## 15. Verification run — mandatory workflows + NetworkPolicy investigation (2026-10-26)

Labels: **PASS** (executed and succeeded now) · **FAIL** · **BLOCKED** (cannot run here) · **NOT IMPLEMENTED**.

| # | Mandatory DoD / requirement check | Label | Evidence from this run |
| --- | --- | --- | --- |
| 1 | Storefront + WooCommerce admin accessible | PASS | `shop /` 200, `wp-login.php` 200, dashboard 200 (via ingress) |
| 2 | Product created through the gateway flow (chat LLM postponed → gateway MCP tool directly) | PASS | `woocommerce_create_product` via `/mcp` → "DoD Drill Product" (`DOD-DRILL-001`) visible on `/shop/` |
| 2b | …through the chat agent itself | PASS | completed 2026-10-26 (hosted window + local fallback both verified): chat → `woocommerce_create_product` → visible on storefront (§ D3/D4 rows, §17) |
| 3 | Manually placed order visible in WooCommerce and retrievable | PASS | browser-placed order **#19** retrieved via member `woocommerce_list_orders` `[14,15,17,19]` + `get_order` |
| 4 | External MCP client with a member key connects, discovers permitted tools, retrieves the same order | PASS | member `tools/list` = exactly 5 permitted reads; `get_order #19` ok |
| 5 | Request routing through two upstreams | PASS | one session: `woocommerce_list_products` + `inventory_list_products` both ok |
| 6 | Revoking a key rejects the next request | PASS | **disposable** member key issued via `POST /api/keys` → worked → revoked → next request rejected (primary credentials untouched) |
| 7 | Disabling an upstream removes tools from discovery and prevents execution | PASS | member list 5→4 (inventory gone); forced call → `Upstream 'inventory' is disabled`; re-enable → 5 |
| 8 | Unavailable upstream does not bring down others | PASS | `inventory-mcp` scaled to 0 → inventory call fails alone, woocommerce ok |
| 9 | Dashboard reports upstream health correctly | PASS | `/api/upstreams`: inventory `reachable=false` + "connection failed — the server is not reachable from the gateway"; woocommerce healthy |
| 10 | Audit log: user, server, tool, timestamp, duration, outcome | PASS | product creation → admin; member calls → member; `key_created`/`key_revoked`; `upstream_disabled`/`upstream_enabled`; row fields complete (e.g. woocommerce/list_products/success/55 ms) |
| 11 | Local K8s/Helm requirements (probes, limits, boundaries, secrets) | PASS | 9/9 deployments with liveness+readiness+limits; 3 PVCs Bound; internals ClusterIP (only demo NodePorts); helm assertions **10/10** |
| 12 | Persistent data intact | PASS | orders 14/15/17/19 + 5 products (4 seeded + the DoD drill product, left intentionally) |
| 13 | Scaling (stand-out 7) reproducible | PASS | `bash scripts/scale-drill.sh` → **RESULT: PASS** (2 replicas, per-replica upstreams, one MCP session across 4 requests; restored to 1) |

**NetworkPolicy investigation (Milestone C):** the long-standing caveat was
**wrong for this cluster**. Empirical probe (deny-all-ingress policy on the
*unused mock-store pod only*, deleted afterwards): the request was **blocked**
(reproduced twice), an unselected service stayed at 200, and removing the
policy restored access → **kindnet (kind v0.33) enforces NetworkPolicy**.
Consequence discovered: the template policy (same-namespace only) would block
the `ingress-nginx` namespace — hence the new `networkPolicy.allowIngressNamespaces`
exception knob (rendering pinned by assertion 10). Policy remains **disabled by
default**; enabling requires the exception. Live status: **not enabled** (by
choice) — do not claim the policy is active in the running cluster, only that
it is real, enforced by the CNI when enabled, and correctly rendered.

## 16. Quality pass — reproducibility, a real observability fix, security activation test (2026-10-26)

| Item | Label | Evidence |
| --- | --- | --- |
| Scaling drill re-run after fixes | PASS | `bash scripts/scale-drill.sh` → RESULT: PASS (2 replicas, both ready, per-replica upstreams, one MCP session across 4 requests, restored to 1) |
| **Defect fixed: stale upstream health after an outage restore** (stand-out 8) | PASS | Reproduced live: pod `1/1` while `GET /api/upstreams` still said `reachable:false`; the UI promised "refresh to re-check" but the endpoint returned cached state. Fix: `registry.refresh()` now force-probes (TTL bypass) and `GET /api/upstreams?refresh=1` runs it; the Upstreams page Refresh button passes it. Live proof: outage→restore → plain GET `{inventory: False}` (stale) → `refresh=1` `{inventory: True}`. Regression test: `api.test.ts` "…?refresh=1 re-probes upstreams live; plain GET stays cached" |
| Security sweep refreshed | PASS | `security-demo.sh` **7/7** (ClusterIP, SSRF boot refusal, revoked-key 401, reader 403+audit, burst rate limit, login throttle, log scrubbing); non-root ×7 in renders; assertion suite now 10/10 |
| NetworkPolicy activation does not break the demo | PASS | Applied the real `mcp-gateway-allow-in-namespace` policy **with** `allowIngressNamespaces=[ingress-nginx]` live: dashboard 200, storefront 200, gateway→wordpress (same-ns) 200; policy then deleted (default state restored) |
| Many-tools bonus (4) | NOT IMPLEMENTED — not needed at current scale | 9 tools; grants-filtered listing, qualified names, dashboard search already cover the mechanisms. The PDF's search-then-execute meta-tool is justified at "hundreds of tools" only. Recommended if ever needed: `search_tools`/`run_tool` pair offered above ~25 granted tools |

## 17. Phase One — local LLM fallback (Ollama) — the five distinct claims

| Claim | Status | Evidence |
| --- | --- | --- |
| Provider abstraction implemented | PASS | `config.ts` (`CHAT_FALLBACK_PROVIDER`/`OLLAMA_BASE_URL`/`OLLAMA_MODEL`, fail-fast validation, `fallback_llm` safe-summary), `agent.ts` provider chain (`ChatProvider.label`, bounded fallback, `BothProvidersError`), `app.ts` wiring (local-only mode when no primary), chart env (`gateway.llm.fallback` — empty by default in prod) |
| Fallback logic tested (mocked) | PASS | `test/agent/fallback.test.ts` (12 tests: success, 429→fallback, timeout→fallback, rejected-key-no-retry, both-fail combined error, malformed→fallback, **duplicate-write protection**, partial-state preservation, local-only mode, denial unchanged, tool-error ≠ provider-failure, bounded rounds) + `test/config.test.ts` (7 cases) |
| Local model downloaded | PASS | `qwen2.5:3b` via Ollama 0.40.11 (`brew services start ollama`), **1.9 GB** — smallest size class with reliable tool-calling on this 16 GB host (options weighed: 1.5B too weak at tools; 12B too heavy beside the 6 GB VM) |
| Actual local inference tested | PASS (live) | gateway chat turn answered with `provider: ollama:qwen2.5:3b` while the hosted provider was rate-limited (HTTP 200, 18.5 s) |
| Tool calling through the gateway with the local model | PASS (live) | same turn: `woocommerce_list_products` executed **through the shared pipeline** (real authorization + audit rows `admin-demo / woocommerce / list_products / success`, 45–58 ms); K8s path verified: pods reach the host Ollama at `host.docker.internal:11434` |

Test data created (sanctioned, uniquely named): product `LLM-DEMO-001`
("Local LLM Demo Product", $5.99) and order **#22**.

## 18. Chatbot factual-accuracy fix (screenshot regression, 2026-10-26)

**Root cause (measured):** `list_products` serialized the FULL WooCommerce REST
objects (~80 fields each) with `products` first and `pagination` **last** — a
page of 6 products produced a **17,681-char** tool result that the agent's
6,000-char cap truncated mid-JSON. The model lost the pagination block
entirely and read shredded `"id": 21`/`"id": 20` fragments — hence invented
"ProductId: 20 to 21" ranges and a phantom "page 2". A secondary issue: the
model sometimes repeated an identical `list_products` call (double results to
merge).

| Fix | Where | Evidence |
| --- | --- | --- |
| Compact, accurate projections (id, name, price, status, sku, permalink per product; id/status/total/currency/date_created per order) | `services/woocommerce-mcp/src/tool-handlers.ts`, `woocommerce-types.ts` | tool result **17,681 → 1,738 chars**; live: every field in the chat answer matches the store exactly |
| Explicit, real-only pagination (`page`, `per_page`, `returned`, `total_products`, `total_pages`, `has_more`) serialized **first** | `tool-handlers.ts` (`paginationSummary`, built only from X-WP-Total/X-WP-TotalPages via `numberHeader` — null when missing/malformed, never fabricated) | 9 new unit tests + re-pinned protocol test |
| No-progress guard: an identical call (same tool+args) with no write in between returns the cached result instead of re-executing; a successful write invalidates the cache | `agent.ts` | regression tests (execute-once, write-invalidates) |
| Accuracy rules in the system prompt (no id ranges/merged ids/fabricated totals; say when data is missing/truncated; label which system facts came from) | `agent.ts` | live: "Total products: 6 · More pages: No"; cross-upstream answer labels store vs inventory |
| Honest truncation marker ("data omitted; do not guess") | `agent.ts` | truncation test re-pinned |

**Live validation (Phase 5):** A) listing accurate (ids 21/20/13/12/11/10,
real prices, `total_products: 6`, `has_more: false`) · B) single-product by id
13 correct · C) product created via chat through the gateway (id 23,
`MLLM-VERIFY-001`) · D) orders answered from real timestamps (no false "today";
#22 returned for 2026-10-25) · E) cross-upstream: store + inventory tools both
called, facts labelled per system · F) both providers usable (groq answered
several turns; `ollama:qwen2.5:3b` answered others with correct tool calls).

## Explicitly not claimed

- **Groq free-tier quota is intermittent** (real `429`s on 2026-10-22; a window
  opened 2026-10-26 and the DoD chat turns completed). The local Ollama
  fallback (§17) keeps chat working regardless — quota is a provider
  limitation, not something code "fixes".
- ~~The dashboard's `last_error` for a dead upstream renders a generic
  `TypeError`~~ — **resolved 2026-10-26** (stand-out 8): unreachable upstreams
  now report "connection failed — the server is not reachable from the
  gateway" (live-verified during a pod-kill drill).
- **No paid services, no new live LLM spend:** the one allowed Groq end-to-end call
  belongs to Milestone 9 (`scripts/llm-smoke.sh`, opt-in); it was not re-run this
  milestone. All Phase D work is deterministic/mocked.
- **Unit suites still default to the mock store** (`test/helpers/mock-store.ts`);
  real-store proof lives in the live checks of section 3, not in the default `npm test`.
- **The mock store chart remains** (`mockStore.enabled`) and is clearly labelled
  "Demo mock store" in the dashboard; nothing falls back to it silently.
- **No authentication or cookie security was weakened to make login "work"** —
  `HttpOnly`, `SameSite=Strict`, `Path=/`, the 12-hour TTL, sha256-only server storage,
  key-bound revocation, the uniform 401 body and `/mcp`'s Bearer-only contract are all
  untouched. The single change is *when* the `Secure` attribute is emitted: exactly when
  the request arrived over HTTPS (D33 `auto`), because unconditional `Secure` over plain
  http made login *impossible* in WebKit rather than safer.
- **No cluster/PVC/DB teardown, no force-push, no secrets in output** — persistent
  data (PostgreSQL PVC, WordPress volume) preserved throughout.
