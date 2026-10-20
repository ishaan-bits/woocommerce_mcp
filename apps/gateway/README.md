# Urumi MCP Gateway

The gateway is the single doorway in front of several MCP servers. To its **callers** it is
one MCP server (Streamable HTTP at `/mcp`); to the systems behind it it is an **MCP client**.
It discovers each upstream's tools, publishes them as one aggregated list under qualified
names, routes every `tools/call` to the right upstream, enforces timeouts, and keeps working
when an upstream fails.

Read [docs/architecture.md](../../docs/architecture.md) for the full design. Decisions
referenced below (D5, D14, D15, D18, D20) are in [docs/decisions.md](../../docs/decisions.md).

## Quick start

```bash
# terminal 1 — a real upstream (optional for first contact; tests need none)
cd services/woocommerce-mcp
WOOCOMMERCE_STORE_URL=... WOOCOMMERCE_CONSUMER_KEY=... WOOCOMMERCE_CONSUMER_SECRET=... npm run dev

# terminal 2 — the gateway (at least one *_MCP_URL is required)
cd apps/gateway
WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp npm run dev
```

Connect any MCP client to `http://127.0.0.1:8080/mcp`.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP — one session per client (capacity 100, idle sweep, graceful drain; D15 pattern) |
| `/healthz` | liveness: `{"status":"ok"}` once the process is listening |
| `/readyz` | readiness: sessions + per-upstream `reachable`/`last_error`. Reports honestly but **never fails** because an upstream is down — one dead backend must not take the gateway out of rotation |

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_HOST` | `127.0.0.1` | bind address |
| `GATEWAY_PORT` | `8080` | bind port (1–65535) |
| `WOOCOMMERCE_MCP_URL` | — | upstream URL; setting it **enables** that upstream |
| `INVENTORY_MCP_URL`, `SUPPORT_MCP_URL` | unset | optional upstreams (Milestone 5); unset = not published |
| `UPSTREAM_TIMEOUT_MS` | `10000` | per-call budget toward an upstream |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `3000` | budget for the initial MCP handshake |
| `TOOL_CACHE_TTL_MS` | `60000` | how long a discovered tool list stays fresh |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

At least one `*_MCP_URL` is required. Invalid configuration fails fast with one issue per
problem, naming the variable. See [.env.example](../../.env.example).

## Routing and naming

- Every published tool is qualified: `woocommerce_list_products`, `inventory_<name>`, …
- The gateway splits a call name on the **first known upstream prefix**, so local names may
  themselves contain underscores.
- The same local name under two upstreams stays two distinct tools; a duplicate *qualified*
  name is impossible by construction (tested).

## Failure behavior (threat-model C8 / D20)

| Situation | `tools/list` | `tools/call` |
| --- | --- | --- |
| Upstream slow / no answer within `UPSTREAM_TIMEOUT_MS` | unchanged | structured `isError`: `upstream 'woocommerce' did not respond within 10000 ms` |
| Upstream unreachable | last-known tools kept for one TTL window (no list flapping) | structured `isError`: `unreachable` |
| Upstream never answered (e.g. wrong URL at boot) | omitted from the list | clear structured error if called by name |
| Upstream disabled (URL unset) | omitted | clear structured error |

Error messages **never** contain internal URLs; the JSON logger redacts `ck_`/`cs_`/`sk_`,
`Basic` and `Bearer` values. Invalid arguments are rejected with `McpError -32602` **before**
any outbound request (validated with ajv against the schema the upstream itself published —
D18).

## Testing

```bash
npm test -w @mcp/gateway   # 36 tests, part of npm run check
```

- The **official MCP SDK client** speaks real Streamable HTTP over loopback — full
  initialize/tools-list/tools-call handshakes, not mocked objects.
- **Fake upstreams** are in-process MCP servers: one well-behaved, one that answers past the
  timeout, one that never accepts connections, one disabled via config. That is how failure
  isolation (learning-guide Stage 3 checkpoint) is proven without Docker, network or a real
  WooCommerce store.
- Contract drift: discovery warns (`woocommerce_tool_contract_drift`) if any of the five D14
  contract tools disappears upstream (D14 promise, tested both ways).

## Honest limitations

- **No auth, no audit log** — Milestone 3 (keys, roles, Postgres audit) and Milestone 8
  (rate limiting / bounded per-upstream concurrency, threat-model C7).
- **Enable/disable is configuration, not a control** — set/unset `*_MCP_URL` and restart;
  dashboard toggles backed by Postgres come in Milestone 4.
- **Never paired with the real `services/woocommerce-mcp` process** — tests use fake
  upstreams; the live pairing belongs to Milestones 6–7 (Docker/kind). The wiring was smoke-
  tested once against a real gateway process (health probes, initialize handshake, graceful
  `SIGTERM`).
- Per-upstream concurrency is not yet bounded: one upstream under load does not degrade
  others (isolation), but within one upstream there is no queue or rate limit yet.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/config.ts` | env parsing (zod), fail-fast messages naming the variable |
| `src/routing.ts` | qualified names ↔ upstream ids |
| `src/upstream-registry.ts` | discovery, TTL cache, connect/call timeouts, health, contract check |
| `src/validation.ts` | ajv pre-forward argument validation |
| `src/mcp-server.ts` | downstream MCP server: aggregated `tools/list`, routed `tools/call` |
| `src/app.ts` | Express app, sessions, probes, draining |
| `src/logger.ts`, `src/errors.ts`, `src/version.ts` | JSON logs with redaction, error types, version stamp |
| `test/` | 36 tests + fake-upstream/harness helpers |
