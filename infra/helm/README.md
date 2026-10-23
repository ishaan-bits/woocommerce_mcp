# Helm chart — `mcp-gateway` (Milestones 7–8 + 10)

One chart deploys the whole stack onto Kubernetes: the gateway, the three MCP
servers, the dashboard, PostgreSQL (with a PersistentVolumeClaim) and — since
Milestone 10 — a **real WordPress + WooCommerce store** (MariaDB + WordPress,
chosen at deploy time via `woocommerceMcp.storeMode`) alongside a clearly-labelled
mock WooCommerce store for offline demos. Two value files
separate the environments: `values-local.yaml` (kind, NodePorts, tiny
resources, chart-created dev Secret) and `values-prod.yaml` (explicit image
tags, gateway/dashboard replicas, persistence, externally supplied Secret,
Ingress + NetworkPolicy integration points). **No real credentials appear in
any committed file.**

## What gets deployed

| Workload | Image (local) | Service | Exposure |
| --- | --- | --- | --- |
| `gateway` | `urumi/gateway:0.1.0` | `gateway:8080` | NodePort 30081 (local) / Ingress (prod) |
| `woocommerce-mcp` | `urumi/woocommerce-mcp:0.1.0` | `woocommerce-mcp:8081` | ClusterIP only (hardcoded) |
| `inventory-mcp` | `urumi/inventory-mcp:0.1.0` | `inventory-mcp:8083` | ClusterIP only (hardcoded) |
| `support-mcp` | `urumi/support-mcp:0.1.0` | `support-mcp:8084` | ClusterIP only (hardcoded) |
| `dashboard` | `urumi/dashboard:0.1.0` | `dashboard:8080` | NodePort 30080 (local) / Ingress (prod) |
| `postgres` | `postgres:17-alpine` | `postgres:5432` | ClusterIP only; PVC `postgres-data` |
| `wordpress-db` (real store) | `mariadb:11.4` | `wordpress-db:3306` | ClusterIP only; PVC `wordpress-db-data` |
| `wordpress` (real store) | `wordpress:7.1.3-apache` (+ `wordpress:cli` init) | `wordpress:80` | ClusterIP only; PVC `wordpress-data`; on when `wordpress.enabled` |
| `woocommerce-store-mock` (mock) | `node:26.7-alpine` + script in ConfigMap | `woocommerce-store-mock:8090` | ClusterIP only; on when `mockStore.enabled` |

Service names are **bare** (`gateway`, `postgres`, …) exactly as
[docs/architecture.md §8](../../docs/architecture.md) maps them, so every URL in
the system is plain Kubernetes service DNS — no hostnames are baked into
values. Deploy **one release per namespace** (names are not release-prefixed;
labels carry the release identity).

### Milestone 8 security posture (threat-model C4/C7/C8/B1)

Every workload runs under its own `ServiceAccount` with
`automountServiceAccountToken: false` (none of these processes talk to the
Kubernetes API). The three internal MCP servers receive `POD_IP` (downward
API) and `MCP_ALLOWED_HOSTS=$(POD_IP),<svc>,<svc>.<ns>.svc.cluster.local`, so
the SDK's host-header validation rejects DNS-rebinding style requests whose
Host header is an attacker domain while port-forwards and service-DNS probes
keep working. The gateway ConfigMap wires the Milestone 8 controls:

| Env | Default | Meaning |
| --- | --- | --- |
| `UPSTREAM_ALLOWED_PRIVATE_HOSTS` | `woocommerce-mcp,inventory-mcp,support-mcp` | C4: only these hosts may resolve to ClusterIPs (empty ⇒ literal private IPs refused at boot) |
| `UPSTREAM_MAX_RESPONSE_BYTES` | `10485760` | C7: upstream response cap (streamed fetch guard) |
| `UPSTREAM_MAX_CONCURRENT_CALLS` | `8` | C7: in-flight tool-call semaphore per upstream |
| `RATE_LIMIT_CALLS_PER_MINUTE` / `RATE_LIMIT_BURST` | `60` / `20` | C7: per-API-key token bucket |
| `JSON_BODY_LIMIT` | `100kb` | C7: express body cap (413 beyond) |
| `LOGIN_MAX_FAILURES_PER_IP` / `LOGIN_FAILURE_WINDOW_MS` | `10` / `300000` | C7/B1: failed-login throttle |
| `TRUST_PROXY` | `1` (prod: `2`) | client-IP extraction for the login throttle (nginx hop; +1 when an Ingress sits in front) |

`scripts/security/assert-helm-security.sh` (wired into `scripts/check.sh`
when `helm` is installed) renders `values-local` and `values-prod` and fails
if any of these regress: an internal service leaves ClusterIP, a workload
loses its non-automount ServiceAccount, the prod render contains a Secret or
credential-looking literal, or the gateway loses its SSRF allow-list.
`scripts/security-demo.sh` demonstrates the same controls live
([docs/threat-model.md §6](../../docs/threat-model.md)).

The gateway discovers the MCP servers at startup; if the servers are not up
yet, the next `tools/list` after `toolCacheTtlMs` (default 60 s) re-fetches —
the gateway never blocks on upstreams and reports `reachable` per upstream on
`/readyz`. Dashboard `GATEWAY_UPSTREAM=http://gateway:8080` (local values)
makes the pod's nginx proxy `/api` to the gateway by service DNS, so a single
port-forward serves the whole UI + API; in production the Ingress owns `/api`
and `gatewayUpstream` is `""` (the image's documented 503 fallback).

## Layout

```
infra/helm/
├── README.md                     ← this file
└── mcp-gateway/
    ├── Chart.yaml                # chart metadata (version 0.1.0, appVersion 0.1.0)
    ├── values.yaml               # shared defaults (no secrets)
    ├── values-local.yaml         # kind/k3d development values
    ├── values-prod.yaml          # production template (operator fills in)
    ├── values.schema.json        # values validation (incl. tag ≠ "latest")
    └── templates/
        ├── _helpers.tpl          # labels, secret name, security contexts
        ├── secrets.yaml          # rendered only when secrets.create=true
        ├── gateway.yaml          # ConfigMap + Service + Deployment (+ migrate init)
        ├── woocommerce-mcp.yaml  # ConfigMap + ClusterIP + Deployment
        ├── inventory-mcp.yaml
        ├── support-mcp.yaml
        ├── dashboard.yaml        # ConfigMap + Service + Deployment
        ├── postgres.yaml         # PVC + ClusterIP + Deployment (Recreate)
        ├── mock-woo-store.yaml   # ConfigMap(script) + ClusterIP + Deployment
        ├── ingress.yaml          # /mcp + /api → gateway, / → dashboard
        ├── networkpolicy.yaml    # allow ingress from same namespace only
        └── NOTES.txt             # post-install next steps
```

## Prerequisites

- The five `urumi/*:0.1.0` images **built** — see
  [infra/docker/README.md](../docker/README.md) (Milestone 6).
- A running cluster (`kind create cluster --name urumi-local` if you do not
  have one) and `kubectl` pointed at it.
- Helm ≥ 3 (validated with 4.3.1).
- A default StorageClass providing `ReadWriteOnce` volumes. kind ships
  `standard` (`rancher.io/local-path`); the chart uses the default and does
  not create a StorageClass.

## Load images into the cluster

Local clusters have no registry, so images are imported directly. Kind's
`kind load docker-image` can fail on the official multi-platform images with
`content digest … not found` (it tries to import every platform of the image
index, which docker only stores one of). Import through `ctr` instead — same
mechanism, single platform, idempotent:

```bash
for img in urumi/gateway:0.1.0 urumi/woocommerce-mcp:0.1.0 \
           urumi/inventory-mcp:0.1.0 urumi/support-mcp:0.1.0 \
           urumi/dashboard:0.1.0 postgres:17-alpine node:26.7-alpine \
           mariadb:11.4 wordpress:7.1.3-apache wordpress:cli; do
  docker save "$img" | docker exec -i urumi-local-control-plane \
    ctr -n k8s.io images import -
done
```

(`node:26.7-alpine` is only the mock store's runtime; skip it if you disable
the mock; the three store images are only needed with `wordpress.enabled`.)
This adds ≈ 1.9 GB inside the cluster node — images are never
pulled from a network.

## Install (local)

```bash
helm lint infra/helm/mcp-gateway -f infra/helm/mcp-gateway/values-local.yaml
helm template urumi infra/helm/mcp-gateway \
  -f infra/helm/mcp-gateway/values-local.yaml > /tmp/render.yaml   # review it
helm upgrade --install urumi infra/helm/mcp-gateway -n urumi --create-namespace \
  -f infra/helm/mcp-gateway/values-local.yaml
kubectl -n urumi get pods,pvc -w
```

What happens on install, in order (no `depends_on` — Kubernetes expresses
ordering explicitly):

1. `postgres` starts; the PVC (`postgres-data`, 1 Gi by default) is bound by
   the default StorageClass.
2. The gateway's **init container** runs `node dist/db/migrate.js` with
   bounded retries until PostgreSQL accepts connections. Migrations are
   tracked in `schema_migrations`, so re-runs print `skip … (already
   applied)`; the same pass creates the least-privilege `mcp_gateway_app`
   runtime role (the gateway container connects as that role via
   `DATABASE_URL`, while `MIGRATE_DATABASE_URL` — the admin URL — exists only
   in the init container).
3. The gateway starts on `0.0.0.0:8080` and refreshes its tool registry. If
   the MCP servers are still starting, `/readyz` stays ready and reports them
   unreachable; the next `tools/list` after `toolCacheTtlMs` discovers them.
4. `woocommerce-mcp` talks to whichever store the deploy-time mode selected —
   `woocommerceMcp.storeMode: real` → the in-cluster `wordpress` service (the
   local default since Milestone 10), `mock` → `woocommerce-store-mock` —
   using the consumer key/secret from the Secret. The mock holds the
   **same** secret keys, so it accepts exactly what the server sends, and
   renders where the two settings disagree fail instead of falling back.

## Secrets and API-key bootstrap

The chart reads one Secret (name: `<release>-secrets`, or
`secrets.existingSecret`). Required keys: `POSTGRES_PASSWORD`,
`MCP_APP_DB_PASSWORD`, `MIGRATE_DATABASE_URL`, `DATABASE_URL`,
`API_KEY_PEPPER`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`.
Optional key: `GROQ_API_KEY` (the Milestone 9 chat agent; the gateway mounts it
with `optional: true`, so a Secret without this key boots the identical gateway
with the agent disabled). Local values create it with obvious
`local-dev-only-…` placeholders. In
production the chart does **not** render a Secret — the operator creates one:

```bash
kubectl -n urumi create secret generic urumi-gateway-secrets \
  --from-literal=POSTGRES_PASSWORD='…' \
  --from-literal=MCP_APP_DB_PASSWORD='…' \
  --from-literal=MIGRATE_DATABASE_URL='postgresql://postgres:…@postgres:5432/mcp_gateway' \
  --from-literal=DATABASE_URL='postgresql://mcp_gateway_app:…@postgres:5432/mcp_gateway' \
  --from-literal=API_KEY_PEPPER='…(≥16 chars)…' \
  --from-literal=WOOCOMMERCE_CONSUMER_KEY='ck_live_…' \
  --from-literal=WOOCOMMERCE_CONSUMER_SECRET='cs_live_…'
```

`DATABASE_URL` must contain the same `MCP_APP_DB_PASSWORD` (it is the app
role's URL); passwords with URL-reserved characters must be percent-encoded.

No user can call anything until an API key exists. Generate one **inside the
gateway pod** (the pepper never leaves the cluster) and insert it with the
admin connection:

```bash
# 1) generate — returns {"key":"umk_…","keyPrefix":"umk_…","keyHash":"…"}
kubectl -n urumi exec deploy/gateway -c gateway -- node -e \
  "import('./dist/auth/keys.js').then(m => console.log(JSON.stringify(m.generateApiKey(process.env.API_KEY_PEPPER))))"

# 2) attach it to a seeded user (example: admin-demo; reader-demo also exists)
kubectl -n urumi exec -i deploy/postgres -- psql -U postgres -d mcp_gateway <<SQL
INSERT INTO api_keys (user_id, key_prefix, key_hash)
SELECT id, '<keyPrefix>', '<keyHash>' FROM users WHERE display_name = 'admin-demo';
SQL
```

The seeded users' grants are the C5 contract: `admin-demo` (role `admin`) may
call the WooCommerce tools; `reader-demo` (role `reader`) may only call the
three read tools on the WooCommerce upstream. Role ceilings, upstream grants
and tool grants all apply — there is no admin bypass.

## Enabling the chat agent (optional Groq key)

The chat agent (Milestone 9, D29) is off until a provider key exists. The key
is **never** a chart value and never typed into chat, files in this repo, or
command output: it is added to the same Secret as an optional `GROQ_API_KEY`
key, and the gateway reads it via an `optional: true` `secretKeyRef`. Without
it the gateway boots normally and `POST /api/chat` answers
`503 agent_not_configured`.

Local kind cluster (release `urumi`, namespace `urumi`, Secret
`urumi-secrets`):

```bash
# 1) Put the key in an environment variable yourself (never commit it, never
#    paste it into a chat). read -s keeps it off screen and out of shell history:
read -rsp "Groq API key: " GROQ_KEY && echo

# 2) Merge it into the existing Secret without touching the other keys. The
#    value travels through a process substitution, so it never appears in the
#    kubectl argv (no `ps` exposure) and no file on disk holds it:
kubectl -n urumi patch secret urumi-secrets --type merge \
  --patch-file <(jq -n --arg v "$GROQ_KEY" '{stringData: {GROQ_API_KEY: $v}}')
unset GROQ_KEY   # drop it from this shell

# 3) Restart the gateway so the new env var is picked up (Secret values are
#    resolved at pod start, not hot-reloaded):
kubectl -n urumi rollout restart deploy/gateway
kubectl -n urumi rollout status deploy/gateway

# 4) Verify the wiring WITHOUT printing the key — presence only:
kubectl -n urumi exec deploy/gateway -c gateway -- \
  node -e "console.log('GROQ_API_KEY present:', !!process.env.GROQ_API_KEY)"
# -> GROQ_API_KEY present: true

# 5) Same style of non-printing sanity check on the value's SHAPE. A pasted
#    placeholder or a quoted/wrapped paste fails here (and only here) instead
#    of as a provider 401 later:
kubectl -n urumi exec deploy/gateway -c gateway -- \
  node -e 'const k=process.env.GROQ_API_KEY||""; console.log("gsk_ prefix:", k.startsWith("gsk_"), "| single token:", !/\s/.test(k))'
# -> gsk_ prefix: true | single token: true
```

Then exercise a real call (this hits Groq's free tier; rate limits apply):

```bash
kubectl -n urumi port-forward svc/gateway 18080:8080 &
# log in with a seeded key (see the bootstrap section above), then:
curl -sS -c /tmp/urumi.cookies -X POST http://127.0.0.1:18080/api/auth/login \
  -H 'content-type: application/json' -d '{"key":"<your umk_… key>"}'
curl -sS -b /tmp/urumi.cookies -X POST http://127.0.0.1:18080/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Reply with exactly: smoke-ok","history":[]}'
```

To remove the key again (agent returns to disabled):

```bash
kubectl -n urumi patch secret urumi-secrets --type json \
  -p '[{"op": "remove", "path": "/stringData/GROQ_API_KEY"}]'
kubectl -n urumi rollout restart deploy/gateway
```

Production behaves identically: add `GROQ_API_KEY` to the operator-created
`secrets.existingSecret` (e.g. `urumi-gateway-secrets`) with your secret
manager of choice (external-secrets, SOPS, `kubectl create secret` from a
file outside the repo). `scripts/llm-smoke.sh` is the same live check — run
it against a reachable gateway as
`GATEWAY_URL=… GATEWAY_API_KEY=… bash scripts/llm-smoke.sh`; it is opt-in
and never part of `scripts/check.sh` (unset URL or gateway key = clean skip).
The Groq key itself is never an input to that script: the gateway holds it.

## Access

The chart's Ingress (`ingress.enabled: true` in `values-local.yaml`) gives the
local demo two stable hostnames: `dashboard.urumi.test` (routes `/` to the
dashboard and `/mcp` + `/api` straight to the gateway) and `shop.urumi.test`
(routes `/` to WordPress). The kind cluster runs the community
`ingress-nginx` controller (Helm chart 4.15.1 / app 1.15.1, namespace
`ingress-nginx` — `kubectl -n ingress-nginx get pods` must show it Running).
Since the kind node publishes no host ports (and binding port 80 would need
root), reach the controller through one port-forward and add the demo hosts
to `/etc/hosts` (scripts skip DNS with `curl --resolve`, browsers need the
hosts entries):

```bash
echo "127.0.0.1 dashboard.urumi.test shop.urumi.test" | sudo tee -a /etc/hosts
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
# dashboard: http://dashboard.urumi.test:18080   store: http://shop.urumi.test:18080
```

Port-forwarding straight to the workloads remains the fallback (and the path
for curl/health checks) — the Kind cluster was created without extra port
mappings and must not be recreated, and a Kind node's IP is not reachable
from macOS:

```bash
kubectl -n urumi port-forward svc/dashboard 8088:8080   # http://127.0.0.1:8088
kubectl -n urumi port-forward svc/gateway 8080:8080     # http://127.0.0.1:8080/mcp
```

The local values also create fixed NodePorts (dashboard 30080, gateway 30081);
they are reachable from inside the cluster network / a VM that routes to it,
which is why the demo path is the ingress port-forward. The three MCP servers,
the mock store and PostgreSQL have **no** external service type at all — they
are ClusterIP-only by template, not by value.

WordPress is configured with a canonical site URL
(`wordpress.siteUrl: http://shop.urumi.test:18080`): `init.sh` rewrites
`home`/`siteurl` and product GUIDs on every boot (idempotent, PVC preserved),
and the `urumi-canonical` mu-plugin forces every canonical redirect onto that
URL — so a visit on any other host/port 301s to the storefront instead of
leaking a stale address. WooCommerce REST authentication intentionally stays
in-cluster (`http://wordpress/wp-json/wc/v3/...`): the chart's wp-config only
marks HTTPS for the internal `wordpress*` hosts, so Basic auth (which
WordPress gates behind `is_ssl()`) works for the woocommerce-mcp upstream and
fails closed over plain external http.

## Verification (commands and actual results, 2026-10-21)

Performed on kind `urumi-local` with `values-local.yaml`:

| Check | Command | Result |
| --- | --- | --- |
| Chart lints | `helm lint … -f values-local.yaml` (and prod, and bare) | 0 failures (schema validated) |
| Server-side schema | `kubectl apply --dry-run=server -f render.yaml` | both value files accepted |
| Pods ready | `kubectl -n urumi get pods` | 7/7 Running 1/1 (incl. mock) |
| PVC bound | `kubectl -n urumi get pvc postgres-data` | Bound, 1Gi, storageclass `standard` |
| Migrations | `kubectl -n urumi logs deploy/gateway -c migrate` | `applied 001_init.sql`, `applied 002_dashboard.sql`, `runtime role mcp_gateway_app ready` |
| Migrations idempotent | same, after pod restart | `skip 001_init.sql (already applied)` |
| Tool discovery | SDK probe → `tools/list` via port-forward | 9 qualified tools |
| Permitted call | `reader-demo` key → `woocommerce_list_products` | products from the in-cluster mock ("Mock Woo Lamp", "Mock Woo Desk") |
| Forbidden call | `reader-demo` key → `inventory_list_products` | `MCP error -32003: upstream 'inventory' is not granted to this principal`; audit row `outcome=denied, errorCode=grant_forbidden` |
| Dashboard | curl via port-forward | `/` 200 HTML; login with `umk_…` key sets session cookie; `/api/me` and `/api/audit` answer through the nginx → gateway chain |
| Upstream self-heal | `/readyz` after startup race | all three upstreams `reachable: true` |
| Gateway restart | `kubectl delete pod -l app.kubernetes.io/name=gateway` | rolls out; migrations skip; audit/users intact; dashboard proxy follows the Service to the new pod |
| PostgreSQL restart | `kubectl delete pod -l app.kubernetes.io/name=postgres` | PVC rebinds to the same volume; audit count, users and keys unchanged |
| Upgrade idempotent | `helm upgrade` same values | revision 3, zero pod disruption |
| Internal exposure | `kubectl -n urumi get svc` | only `gateway`/`dashboard` are NodePort; the rest ClusterIP |
| Log hygiene | `kubectl logs` all containers scanned for the live secret values and key material | no matches in 374 lines |
| Disk impact | `df` before/after image import | host free 62 Gi → 60 Gi; kind node 4.6 G used / 42 G free |

### Chat-agent verification (Milestone 9 live, 2026-10-22)

Performed on the same cluster after the `GROQ_API_KEY` wiring (commit `0f263d5`):

| Check | Command | Result |
| --- | --- | --- |
| Key presence (boolean) | `node -e "console.log(!!process.env.GROQ_API_KEY)"` in the gateway container | `true`; model `llama-3.3-70b-versatile`, base `https://api.groq.com`, timeout `45000` |
| Non-sensitive config | `kubectl get configmap gateway-config` | `GROQ_MODEL` / `LLM_REQUEST_TIMEOUT_MS` present; **no** `GROQ_API_KEY` key |
| Agent disabled state (pre-key, prior session) | unauthenticated + authenticated `POST /api/chat` with no key | `401` without auth; `503 agent_not_configured` with auth — C6 `auth_failed` rows written |
| Auth intact (post-key) | unauthenticated `POST /api/chat` | `401 unauthorized`; audit `auth_failed, errorCode=missing_credentials` |
| Provider rejection mapping | `scripts/llm-smoke.sh` → `POST /api/chat` | **live call FAILED**: gateway `502 provider_error`, server log `chat_provider_failed kind=rejected status=401` — Groq rejected the credential |
| Root cause (shape check, no value printed) | in-pod boolean/shape probe | stored value is 44 chars with **7 internal spaces, 2 quotes, no `gsk_` prefix** → not a Groq key (malformed/placeholder material in the Secret) |
| MCP tool call via chat | — | **not performed**: depends on a successful model response; the path is covered by mocked tests (`test/agent/agent.test.ts`, `test/chat-api.test.ts`) |
| Dashboard chat UI | `http://127.0.0.1:8088` via port-forward | serves; unauthenticated API calls correctly rejected |

**Operator action (completed 2026-10-22):** the Secret was re-patched with a
valid Groq key by the operator using the `read -rsp` + `jq --patch-file`
command in "Enabling the chat agent" above (shape probed as booleans only —
prefix/single-token/length), followed by a rollout restart and the smoke rerun.
The key never entered this repository, chat, or logs.

### Chat-agent verification — end-to-end PASS (2026-10-22, follow-up)

The FAILED row above was resolved in three steps on the same cluster; every
check stayed sanitized (booleans, HTTP codes, log `kind`/`status`, audit safe
fields — no key material anywhere):

1. **Credential** — operator re-patched the Secret; the shape probe showed a
   valid `gsk_` single token (booleans only) and `kind=rejected status=401`
   disappeared.
2. **Model** — Groq retired `llama-3.3-70b-versatile` on 2026-08-16 (free/dev
   tiers) → HTTP **404** (`kind=unavailable status=404`). Chart default,
   config defaults, docs and the security assertion moved to
   `openai/gpt-oss-120b` (Helm revision 7; `GROQ_MODEL` verified live in
   `gateway-config`).
3. **Second-round wire shape** — after a successful tool call, Groq rejected
   round 2 with HTTP **400**: the agent re-sent the *internal* parsed
   tool-call shape. `OpenAiCompatProvider` now serializes the OpenAI message
   shape (`{id, type:"function", function:{name, arguments:"<json string>"}}`
   with the provider's id/name/arguments preserved), covered by outbound-body
   regression tests in `apps/gateway/test/agent/agent.test.ts`.

| Check | Command | Result |
| --- | --- | --- |
| Live smoke (opt-in, ₹0) | `GATEWAY_URL=… GATEWAY_API_KEY=… bash scripts/llm-smoke.sh` | **HTTP 200** `{"reply":"smoke-ok","tool_calls":[],"rounds":1}` → `LIVE SMOKE OK` |
| End-to-end chat with tool | authenticated `POST /api/chat` (list store products) | **HTTP 200**, `rounds: 2`, `tool_calls:[{name: woocommerce_list_products, outcome: success}]`, reply grounded in the mock store's real product names |
| Follow-up provider round | `chat_provider_failed` in gateway logs since deploy | **none** — Groq accepted the wire-shaped second request |
| Audit record | `GET /api/audit?limit=3` (safe fields only) | `action=tool_call, toolName=list_products, outcome=success, durationMs=39` under the admin principal |
| Full checks after fix | `TEST_DATABASE_URL=… bash scripts/check.sh` + `helm lint` (both values) | 397 pass / 0 fail / 0 skipped; helm security assertions 6/6; `npm audit` 0 vulnerabilities; lint OK |

**Remaining limitations:** one provider (Groq free tier) with no automatic
fallback — provider failures still surface as `502 provider_error` (`504` on
timeout); tool rounds are capped at 4 per chat request; the dashboard chat UI
was not manually re-verified in this pass (route and agent are covered by
tests); free-tier rate limits apply — `scripts/llm-smoke.sh` stays opt-in and
is never part of `check.sh`.

**Not performed** (honest gaps): TLS and real DNS (no certificate and no
public host exists); Ingress routing was still a gap at this point — the
chart's Ingress was rendered and dry-run-validated only (since closed in
Milestone 11 Phase 3: `ingress-nginx` installed on kind, storefront route
added, both hosts verified — see "Access" above); NetworkPolicy
enforcement (Kind's kindnet does not enforce policies — the local values keep
it off); multi-replica gateway behaviour (local values use 1
replica; prod values specify 2 with `sessionAffinity: ClientIP` on the
Service).

### Milestone 10 live verification (real store, 2026-10-22)

Performed on the same cluster with `values-local.yaml` (`woocommerceMcp.storeMode: real`,
`wordpress.enabled: true`):

| Check | Command | Result |
| --- | --- | --- |
| Pods ready | `kubectl -n urumi get pods` | **9/9 Running 1/1** (incl. `wordpress` + `wordpress-db` + mock) |
| Chart + security gates | `helm lint` (local and prod), `bash scripts/security/assert-helm-security.sh` | lint 0 failures; `ASSERT OK` (7 checks) |
| Negative renders | `helm template … --set woocommerceMcp.storeMode=mock --set mockStore.enabled=false` (and 2 more) | all 3 fail with the intended messages (no silent fallback) |
| Init idempotent | `kubectl -n urumi logs deploy/wordpress -c wp-init` | `wordpress-init: store ready` + `.htaccess written`; re-run on a fresh pod: `0 new product(s), api key present` |
| Probes | numeric `port: 80`, `path: /wp-login.php` | `wordpress 1/1 Running`, `RESTARTS 0` across the liveness window |
| REST products | authenticated `GET http://wordpress/wp-json/wc/v3/products` (exec from the `woocommerce-mcp` pod; key read from env, never printed) | `HTTP/1.1 200` — 4 products: `URUMI-TEA-001`, `URUMI-CHAI-001`, `URUMI-COF-001`, `URUMI-MUG-001` |
| REST orders | same, `/wp-json/wc/v3/orders` | 2 completed orders (#14, #15) |
| Store-mode label | `GET /api/upstreams` via port-forward | `woocommerce  mode: real` |
| MCP end-to-end | JSON-RPC `tools/call woocommerce_list_products` on `/mcp` | 4 real products, no `isError` |
| Grant parity (regression) | same session, `tools/call inventory_list_products` with a key that lacks that grant | JSON-RPC `-32003: tool … is not granted to this principal` (server and dashboard indicator agree) |
| External SDK client | `GATEWAY_URL=… GATEWAY_API_KEY=… node --test apps/gateway/test/external-client.test.ts` | 2/2 pass; explicit printed skip when the env vars are unset |

Full commands and per-requirement evidence: [docs/requirement-matrix.md](../../docs/requirement-matrix.md).

### Milestone 11 Phase 3 — local Ingress verification (2026-10-22)

Same cluster (no recreation, no data loss): `ingress-nginx` chart 4.15.1
installed into namespace `ingress-nginx`, then the app chart upgraded with
`ingress.enabled: true`, `ingress.host: dashboard.urumi.test`,
`ingress.storefrontHost: shop.urumi.test`, `gateway.publicUrl:
http://dashboard.urumi.test:18080`, `wordpress.siteUrl:
http://shop.urumi.test:18080`:

| Check | Command | Result |
| --- | --- | --- |
| Controller | `kubectl -n ingress-nginx get pods` | `ingress-nginx-controller` **Running 1/1** (LB EXTERNAL-IP `<pending>` — normal on kind) |
| Ingress object | `kubectl -n urumi get ingress mcp-gateway` | HOSTS `dashboard.urumi.test,shop.urumi.test`; `/` + `/mcp` + `/api` on the dashboard host, `/` → `wordpress:80` on the storefront host |
| Dashboard host | `curl --resolve dashboard.urumi.test:18080:127.0.0.1 …/` | 200 HTML (SPA), `/api/me` anon → 401, `/mcp` anon → 401, `/api/settings` (reader key) → `mcp_endpoint: http://dashboard.urumi.test:18080/mcp` |
| Storefront host | `curl --resolve shop.urumi.test:18080:127.0.0.1 …/` | 200 (no redirect); every asset/link on `shop.urumi.test:18080`, zero `8082`/`127.0.0.1` leftovers; `/wp-login.php` 200 |
| Canonical URLs | in-cluster `GET /wp-json/wc/v3/products` + DB `wp_posts.guid` | REST `permalink` and product GUIDs all `shop.urumi.test:18080/...` (`fix-guids.php` init step, idempotent) |
| Redirect hygiene | bare `port-forward svc/wordpress 8082:80` → `GET /` | 301 → `http://shop.urumi.test:18080/` (`urumi-canonical` mu-plugin: canonical redirects always land on `siteUrl`); `/wp-login.php` still 200 on the bare port-forward for emergency admin |
| External WC REST auth | Basic auth via the public host | 401 — intentional (WordPress only accepts REST Basic auth on HTTPS/internal hosts); the supported path is in-cluster, used by `woocommerce-mcp` |
| Browser (Playwright) | both hosts via `--host-resolver-rules` | dashboard 200 + sign-in renders; storefront 200 (title `URUMI demo store`), no broken images/stale links; WP login form 200 |
| Full checks | `TEST_DATABASE_URL=… bash scripts/check.sh` | exit 0 (gateway 304, dashboard 97, postgres integration 14, all servers, security assertions 7/7, `npm audit` 0) |

## Persistence and recovery

- **PostgreSQL data lives in the PVC** (`postgres-data`), never in the image
  or the pod filesystem. Pod restarts, node-container restarts and upgrades
  keep it; only deleting the PVC (or the whole Kind node/container) destroys
  it, because `rancher.io/local-path` stores data inside the node.
- The Deployment uses `strategy: Recreate` so the single `ReadWriteOnce` PVC
  is never attached to two servers at once.
- Everything else (gateway, MCP servers, dashboard, mock) is stateless —
  sessions and configuration live in PostgreSQL.

## Local vs production values

| Concern | `values-local.yaml` | `values-prod.yaml` |
| --- | --- | --- |
| Images | local tags `urumi/*:0.1.0` via `kind`/`ctr` import | operator registry, immutable `0.1.0` tags (schema rejects `latest`) |
| Replicas | 1 everywhere | gateway 2, dashboard 2, MCP servers 1, postgres 1 |
| Resources | tiny (fits a 4-CPU / 6-GiB Mac) | larger requests/limits |
| Secrets | chart-created, `local-dev-only-…` placeholders | `secrets.create=false`; operator creates `existingSecret` (add optional `GROQ_API_KEY` to enable the chat agent) |
| Store | `storeMode: "real"` → in-cluster WordPress + WooCommerce (`wordpress.enabled: true`); the labelled mock is also deployed (`mockStore.enabled`) for offline comparison | `storeMode: "real"` with in-cluster WordPress (`wordpress.enabled: true`, PVC 10 Gi) — or set `wordpress.enabled: false` + `woocommerceMcp.storeUrl` for an externally hosted store; creds always from the Secret |
| Dashboard `/api` | pod nginx proxies to `http://gateway:8080` | `gatewayUpstream: ""` — Ingress owns `/api` |
| Access | NodePorts + port-forward | Ingress (`/mcp` + `/api` → gateway, `/` → dashboard), TLS left **off** until a real certificate is supplied |
| Persistence | 1 Gi | 10 Gi (StorageClass name optional) |
| NetworkPolicy | off (kindnet does not enforce) | on (requires an enforcing CNI) |

## Production checklist (operator-supplied — this repo cannot provide these)

1. Push the five images to a registry you control; update the repositories.
2. Create the Secret (command above) with real, generated values.
3. Point `ingress.host` at a real DNS name; enable `ingress.tls` only after a
   real certificate Secret exists (e.g. cert-manager — the annotation slot is
   in `values-prod.yaml`).
4. Confirm the default StorageClass (or set `postgres.persistence.storageClass`)
   provides `ReadWriteOnce` volumes with a backup story.
5. Enable `networkPolicy` only on a CNI that enforces it, and verify probes
   still pass.
6. Bootstrap at least one admin API key (same procedure as local).
7. `MCP_ALLOWED_HOSTS` is deliberately unset: kubelet probes arrive with the
   pod IP as `Host`, which a static allowlist cannot know. The boundary is
   the ClusterIP-only Services + gateway authentication; if your CNI can
   enforce pod-to-node rules, tightening this is a good follow-up.

## Deploying to a future VPS (outline — prepared, not executed here)

This repo provisions nothing and spends nothing; the walkthrough below assumes
you already have a Linux VPS with a Kubernetes cluster (k3s, kubeadm, or a
managed cluster) and `kubectl`/`helm` pointed at it. It has **not** been run
from start to finish in this environment — treat it as a checklist to execute
when a VPS exists:

```bash
# 1. Push the five images (tag 0.1.0) to a registry the cluster can pull from,
#    then point values-prod.yaml repositories at them.

# 2. Pre-create the Secret the chart will reference (secrets.create=false):
kubectl create namespace urumi
kubectl -n urumi create secret generic urumi-gateway-secrets \
  --from-literal=DATABASE_URL='postgres://…' \
  --from-literal=API_KEY_PEPPER='…' \
  --from-literal=SESSION_SECRET='…' \
  --from-literal=WOOCOMMERCE_URL='https://…' \
  --from-literal=WOOCOMMERCE_CONSUMER_KEY='…' \
  --from-literal=WOOCOMMERCE_CONSUMER_SECRET='…' \
  --from-literal=GROQ_API_KEY='…'   # optional — chat stays disabled without it

# 3. Review ingress.host, persistence sizes and networkPolicy (checklist above),
#    then install:
helm upgrade --install urumi infra/helm/mcp-gateway \
  -n urumi -f infra/helm/mcp-gateway/values-prod.yaml

# 4. Wait for readiness, then bootstrap the first admin key through the
#    gateway's documented key-bootstrap flow (same procedure as local).

# 5. Verify before trusting it: pods Ready, /readyz all reachable, one
#    tools/list round-trip with the bootstrap key, and a login on the
#    dashboard — exactly the commands in the local verification section.
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Pods fail with `runAsNonRoot and image has non-numeric user` | The kubelet cannot verify named `USER` accounts. The chart pins `runAsUser`/`runAsGroup` (1000 for the node images, 101 for nginx). Custom images must either set numeric UIDs or the values must be adjusted. |
| Dashboard pod crash-loops with `host not found in upstream "gateway"` | nginx resolves `GATEWAY_UPSTREAM` at startup. The `gateway` Service is created with the release; a restart clears it. |
| Gateway `/readyz` shows `reachable: false` right after install | Startup raced the MCP servers. Harmless: the next `tools/list` after `toolCacheTtlMs` re-fetches. |
| `kind load docker-image … content digest not found` | Multi-platform index issue — use the `ctr` import loop above. |
| Config change has no effect | ConfigMaps are read at pod start: `kubectl -n urumi rollout restart deploy/<name>` after edits. |
| Gateway exits with `Invalid configuration: …` | The Secret is missing keys (or the wrong Secret name): check `secrets.existingSecret` and the seven required keys. |
| `NetworkPolicy` breaks probes after enabling | Some CNIs treat kubelet probe traffic as external. Verify on your CNI; the local values keep the policy off for exactly this reason. |

## Cleanup (preserves data by default)

```bash
# stop access only — everything keeps running
kill the port-forward processes

# scale everything to zero, data intact
kubectl -n urumi scale deploy --all --replicas=0

# full uninstall, KEEPING the database volume
kubectl -n urumi label pvc postgres-data helm.sh/resource-policy=keep --overwrite
helm uninstall urumi -n urumi

# (destructive, only on purpose) remove the database volume too
kubectl -n urumi delete pvc postgres-data

# (destructive) Kind data lives inside the node: deleting the cluster
# destroys local-path volumes as well
kind delete cluster --name urumi-local
```

## Request flow (dashboard → gateway → upstream → audit)

1. The browser loads the SPA from the dashboard Service (port-forward or
   Ingress). Every `/api/…` call goes to the dashboard pod's nginx.
2. Local: nginx proxies `/api` to `http://gateway:8080` (in-cluster DNS).
   Production: the Ingress routes `/api` (and `/mcp`) straight to the gateway.
3. `POST /api/auth/login` exchanges a `umk_…` API key for a server-side
   session row (`web_sessions`, hashed at rest); the cookie authorises
   subsequent REST calls. The same key can also call `/mcp` directly with
   `Authorization: Bearer`.
4. A `tools/call` on `/mcp` is authorised in C5 order — role ceiling →
   upstream grant → tool grant — then routed by qualified name
   (`<upstream>_<local>`) to the matching MCP server over service DNS.
5. Every decision (allow and deny) appends to `audit_log`, visible in the
   dashboard's audit page and via `GET /api/audit` (admin role).
