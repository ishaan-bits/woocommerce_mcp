# Docker images (Milestone 6) — implemented

Five multi-stage images, built and container-validated locally on the Colima Docker
engine (legacy builder, Docker Engine 29.5.2, linux/arm64). **Nothing is pushed to a
registry** — tags are local. Kubernetes deployment of these images is Milestone 7
(`infra/helm`).

## Build

All builds use the repository root as context so npm workspaces resolve exactly as
they do on the host; the root `.dockerignore` keeps `.git`, `.env*`, `node_modules`,
`dist`, tests, docs and logs out of the context:

```bash
docker build -f infra/docker/gateway/Dockerfile         -t urumi/gateway:0.1.0         .
docker build -f infra/docker/woocommerce-mcp/Dockerfile -t urumi/woocommerce-mcp:0.1.0 .
docker build -f infra/docker/inventory-mcp/Dockerfile   -t urumi/inventory-mcp:0.1.0   .
docker build -f infra/docker/support-mcp/Dockerfile     -t urumi/support-mcp:0.1.0     .
docker build -f infra/docker/dashboard/Dockerfile       -t urumi/dashboard:0.1.0       .
```

| Image | Size (arm64) | Base | Exposes | Runs as |
| --- | --- | --- | --- | --- |
| `urumi/gateway:0.1.0` | 286 MB | `node:26.7-alpine` | 8080 | `node` (uid 1000) |
| `urumi/woocommerce-mcp:0.1.0` | 285 MB | `node:26.7-alpine` | 8081 | `node` (uid 1000) |
| `urumi/inventory-mcp:0.1.0` | 285 MB | `node:26.7-alpine` | 8083 | `node` (uid 1000) |
| `urumi/support-mcp:0.1.0` | 285 MB | `node:26.7-alpine` | 8084 | `node` (uid 1000) |
| `urumi/dashboard:0.1.0` | 91 MB | `nginxinc/nginx-unprivileged:1.30-alpine` | 8080 | `nginx` (uid 101) |

## How the Dockerfiles are shaped (and why)

- **Three stages each**: `deps` (a byte-identical `npm ci` line in all five
  Dockerfiles, so the builder caches one shared layer across all builds),
  `builder` (compiles the workspace against the root `tsconfig.base.json`), and
  `runtime` (a fresh base running `npm ci --omit=dev --workspace=@mcp/<name>` —
  the build fails if the production closure is incomplete, and the final image
  contains only that workspace's runtime packages: ~29 MB of `node_modules`,
  no `typescript`, no `vite`).
- **Repo-root layout inside the image** mirrors the workspace tree, so the
  `node_modules/@mcp/shared` symlink resolves unchanged and the gateway's
  compiled migrations runner (`dist/db/migrate.js`) finds
  `apps/gateway/migrations/*.sql` through its own path arithmetic.
- **Migrations in the image, toolchain out of it**:

  ```bash
  docker run --rm --network <net> -e DATABASE_URL=postgres://… \
    urumi/gateway:0.1.0 node dist/db/migrate.js
  ```

  (`npm run migrate` needs the TypeScript toolchain and `src/`, which stay in the
  builder stage — the applied output was `applied 001_init.sql`,
  `applied 002_dashboard.sql`, `Migrations complete.`)
- **No configuration in layers**: no `.env`, no URLs, no ports-as-config. Every
  variable arrives at `docker run -e …` time (`.env.example` is the reference;
  placeholders only — history and filesystem scans of all five images are clean).
- **Non-root** (`USER node`, inherited `USER nginx`) — verified with `id` inside
  every running container: `uid=1000(node)` / `uid=101(nginx)`.
- **Healthchecks** via busybox `wget` against each server's own `/healthz`, using
  the same env vars the app reads (`${GATEWAY_PORT:-8080}`, `${PORT:-8081|8083|8084}`).
  In Kubernetes the kubelet ignores `HEALTHCHECK`; probes are declared on the
  workload in Milestone 7.
- **Signals**: exec-form `CMD ["node","dist/index.js"]` behind the stock
  entrypoints, so `docker stop` delivers SIGTERM to PID 1 → every server logs
  `shutdown_started`/`shutdown_complete` and exits `0`.

## Runtime configuration

| Image | Required env | Optional |
| --- | --- | --- |
| gateway | `DATABASE_URL`, `API_KEY_PEPPER` (≥16 chars), at least one of `WOOCOMMERCE_MCP_URL` / `INVENTORY_MCP_URL` / `SUPPORT_MCP_URL` | `GATEWAY_HOST=0.0.0.0`, `GATEWAY_PORT`, timeouts, `LOG_LEVEL`, `MIGRATE_DATABASE_URL`, `MCP_APP_DB_PASSWORD` |
| woocommerce-mcp | `WOOCOMMERCE_STORE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET` | `HOST=0.0.0.0`, `PORT`, `WOOCOMMERCE_TIMEOUT_MS`, `LOG_LEVEL`, `MCP_ALLOWED_HOSTS` |
| inventory-mcp | — (seeded demo data) | `HOST=0.0.0.0`, `PORT`, `LOG_LEVEL`, `MCP_ALLOWED_HOSTS` |
| support-mcp | — (seeded demo data) | `HOST=0.0.0.0`, `PORT`, `LOG_LEVEL`, `MCP_ALLOWED_HOSTS` |
| dashboard | — | `GATEWAY_UPSTREAM` (gateway base URL for the `/api` proxy, see below) |

**`HOST=0.0.0.0` matters**: the servers default to binding `127.0.0.1` (right on a
laptop, useless in a container), so published ports would refuse connections. Pass
`-e HOST=0.0.0.0` (`-e GATEWAY_HOST=0.0.0.0` for the gateway) whenever the container
must be reached from outside itself. Also note Docker DNS resolves **container names
or the `--network-alias` you gave them** — on a user-defined network, either match
the URL to the name (`http://m6-gateway:8080`) or run with
`--network-alias inventory-mcp` etc. so the documented service names resolve.

**Fail-fast without configuration** — each server refuses to start half-configured
instead of limping:

```text
$ docker run --rm urumi/gateway:0.1.0
Invalid configuration: API_KEY_PEPPER is required and must be at least 16 characters;
DATABASE_URL is required (postgres:// or postgresql:// URL); at least one upstream URL
is required: set WOOCOMMERCE_MCP_URL, INVENTORY_MCP_URL, SUPPORT_MCP_URL   (exit 1)

$ docker run --rm urumi/woocommerce-mcp:0.1.0
Invalid configuration: WOOCOMMERCE_STORE_URL is required; … CONSUMER_KEY is required;
CONSUMER_SECRET is required   (exit 1)
```

With unreachable-but-valid config the gateway also fails closed before serving:
`Gateway failed to start: cannot reach PostgreSQL (DATABASE_URL): getaddrinfo ENOTFOUND …`.

## The dashboard's `/api`

The SPA always calls same-origin relative `/api/…` paths. Two supported modes:

1. **Kubernetes (Milestone 7):** the Ingress routes `/api` (and `/mcp`) to the
   gateway before traffic reaches nginx — leave `GATEWAY_UPSTREAM` unset. The
   entrypoint (`40-api-proxy.sh`) then writes a scripted `503` location, so an
   accidental direct hit is an obvious configuration error, not a mystery 404.
2. **Plain `docker run`:** set `GATEWAY_UPSTREAM=http://<gateway-host>:8080` and
   the entrypoint writes an nginx `location /api/` proxy. nginx resolves the
   proxy hostname **at startup**: with an unresolvable name the container exits
   `1` printing `host not found in upstream "…"` (fail fast, message included),
   so start the gateway first.

## Validation performed (Milestone 6, this machine)

For each image: clean-context build, `docker image inspect` (user, ports, env,
healthcheck), `docker history` + filesystem scans (no `.env`, no pepper, no key
material), non-root `id`, `/healthz` → `healthy`, SIGTERM → `shutdown_complete` +
exit 0. Beyond that, on one user-defined Docker network:

- **gateway + PostgreSQL 17 + the three MCP servers**: migrations applied from
  inside the gateway image; `tools/list` via the **official `@modelcontextprotocol/sdk`
  client** returned exactly the 9 qualified names; provenance-checked calls:
  `woocommerce_list_products` returned the host mock store's *Mock Woo Lamp*
  (gateway → woocommerce-mcp container → mock REST via `host.docker.internal`,
  Basic auth accepted), `inventory_list_products` returned *Canvas Tote* from the
  inventory container, `support_list_tickets`/`support_create_ticket` read and
  wrote the support container (the write needed the `admin` role — the `reader`
  ceiling correctly refused it with `-32003 role_forbidden`). Missing key → 401 +
  `auth_failed` audit row; successes and denials all land in `audit_log` with
  qualified names. Service DNS (`postgres`, `inventory-mcp`, …) — not
  `localhost` — carries every container-to-container hop.
- **dashboard**: index + hashed assets + SPA fallback served; with
  `GATEWAY_UPSTREAM` set, `/api/me` returns the gateway's 401 JSON through the
  proxy; without it, `/api/me` returns the scripted 503 while static serving
  keeps working. Bundle scan: no gateway URL, no env values, no secrets (the
  literals `umk_…` and `VITE_GATEWAY_API_URL` in the bundle are UI copy).
- **unconfigured runs** fail with the messages above (gateway, woocommerce);
  inventory/support start with zero configuration as designed.

## Known limitations (deliberate, documented rather than hidden)

- Tags are local (`urumi/<name>:0.1.0`); no registry push, no compose file —
  composition across machines is the Helm chart's job in Milestone 7.
- Docker `HEALTHCHECK` is a local convenience; Kubernetes probes live in the chart.
- Mode 2's startup-time DNS resolution couples the dashboard's start to a
  resolvable `GATEWAY_UPSTREAM`; mode 1 (Ingress owns `/api`) avoids the
  dependency entirely.
- The build used the legacy builder (Docker 29 prints a deprecation warning for
  it); the Dockerfiles avoid BuildKit-only syntax, so `docker buildx` works
  unchanged whenever the plugin is installed.
