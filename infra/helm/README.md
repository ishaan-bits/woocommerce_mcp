# Helm chart — `mcp-gateway` (Milestones 7–8)

One chart deploys the whole stack onto Kubernetes: the gateway, the three MCP
servers, the dashboard, PostgreSQL (with a PersistentVolumeClaim) and — for
local demos only — a clearly-labelled mock WooCommerce store. Two value files
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
| `woocommerce-store-mock` (mock) | `node:26.7-alpine` + script in ConfigMap | `woocommerce-store-mock:8090` | ClusterIP only; on when `mockStore.enabled` |

Service names are **bare** (`gateway`, `postgres`, …) exactly as
[docs/architecture.md §8](../docs/architecture.md) maps them, so every URL in
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
           urumi/dashboard:0.1.0 postgres:17-alpine node:26.7-alpine; do
  docker save "$img" | docker exec -i urumi-local-control-plane \
    ctr -n k8s.io images import -
done
```

(`node:26.7-alpine` is only the mock store's runtime; skip it if you disable
the mock.) This adds ≈ 1.9 GB inside the cluster node — images are never
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
4. `woocommerce-mcp` talks to the mock store (or the real URL from
   `woocommerceMcp.storeUrl`) using the consumer key/secret from the Secret —
   the mock holds the **same** secret keys, so it accepts exactly what the
   server sends.

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
file outside the repo). `scripts/llm-smoke.sh` is the same live check for a
non-Kubernetes gateway and stays opt-in (`GROQ_API_KEY` unset = clean skip).

## Access

Local development access is **port-forwarding** (the Kind cluster was created
without extra port mappings and must not be recreated, and a Kind node's IP is
not reachable from macOS):

```bash
kubectl -n urumi port-forward svc/dashboard 8088:8080   # http://127.0.0.1:8088
kubectl -n urumi port-forward svc/gateway 8080:8080     # http://127.0.0.1:8080/mcp
```

The local values also create fixed NodePorts (dashboard 30080, gateway 30081);
they are reachable from inside the cluster network / a VM that routes to it,
which is why the demo path is the port-forward. The three MCP servers, the
mock store and PostgreSQL have **no** external service type at all — they are
ClusterIP-only by template, not by value.

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

**Not performed** (honest gaps): TLS and real DNS (no certificate and no
public host exists); Ingress routing (Kind has no ingress controller — the
prod Ingress is rendered and dry-run-validated only); NetworkPolicy
enforcement (Kind's kindnet does not enforce policies — the local values keep
it off); a real WooCommerce store (the milestone explicitly allows the
documented mock); multi-replica gateway behaviour (local values use 1
replica; prod values specify 2 with `sessionAffinity: ClientIP` on the
Service).

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
| Store | in-cluster labelled mock (`mockStore.enabled=true`) | mock off; `woocommerceMcp.storeUrl` = real store + creds from the Secret |
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
