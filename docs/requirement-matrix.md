# Requirement matrix — Milestone 10

Maps each requirement of this milestone to the code that implements it and the
check that proves it. Every "verification" cell names a command in this repo;
live checks were run against the kind cluster `urumi-local` (Helm release
`urumi`, namespace `urumi`) and can be repeated with the shown commands.
Nothing here is claimed without a passing check — see "Explicitly not claimed"
at the bottom.

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
executed, not assumed. The original assignment PDF is not present anywhere in
this workspace — requirements are therefore traced from `README.md`, this
matrix and `docs/decisions.md` rather than from the PDF.

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

## Explicitly not claimed

- **No paid services, no new live LLM spend:** the one allowed Groq end-to-end call
  belongs to Milestone 9 (`scripts/llm-smoke.sh`, opt-in); it was not re-run this
  milestone. All Phase D work is deterministic/mocked.
- **Unit suites still default to the mock store** (`test/helpers/mock-store.ts`);
  real-store proof lives in the live checks of section 3, not in the default `npm test`.
- **The mock store chart remains** (`mockStore.enabled`) and is clearly labelled
  "Demo mock store" in the dashboard; nothing falls back to it silently.
- **No cluster/PVC/DB teardown, no force-push, no secrets in output** — persistent
  data (PostgreSQL PVC, WordPress volume) preserved throughout.
