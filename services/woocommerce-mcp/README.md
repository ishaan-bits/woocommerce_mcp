# woocommerce-mcp

A genuine MCP server (official TypeScript SDK, **Streamable HTTP at `/mcp`**) that exposes a
small, safe subset of a WooCommerce store's REST API as five MCP tools. Built as Milestone 1
of this project; see [docs/architecture.md § 10](../../docs/architecture.md).

## Tools

| Tool | WooCommerce call | Notes |
| --- | --- | --- |
| `list_products` | `GET /wp-json/wc/v3/products` | `page`, `per_page` (≤ 100), `search`, `status`. Read-only. |
| `create_product` | `POST /wp-json/wc/v3/products` | Requires `name` + `regular_price` (decimal string, e.g. `"19.99"`). **Not idempotent** — every call creates a product. |
| `list_orders` | `GET /wp-json/wc/v3/orders` | `page`, `per_page`, `search`, single `status`, `after`/`before` ISO-8601 instants with explicit offset, `dates_are_gmt` (default `true`). Read-only. |
| `get_order` | `GET /wp-json/wc/v3/orders/{id}` | By numeric `order_id`. Read-only. |
| `update_order_status` | `PUT /wp-json/wc/v3/orders/{id}` | Sets one of `pending, processing, completed, on-hold, cancelled, refunded, failed`. Idempotent per status. |

Store failures (timeout, connection, 401/403/404/5xx, non-JSON bodies) come back as tool
results with `isError: true` and a message that never contains credentials. Invalid arguments
are rejected by the zod schemas before any store call is made.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP (session-based; see decision D15) |
| `/healthz` | Liveness: always `{ "status": "ok" }` while the process runs |
| `/readyz` | Readiness: `200` when accepting sessions, `503` when draining or at capacity |

## Running it

```bash
cd services/woocommerce-mcp
export WOOCOMMERCE_STORE_URL="https://your-store.example"   # no trailing path/query
export WOOCOMMERCE_CONSUMER_KEY="ck_..."
export WOOCOMMERCE_CONSUMER_SECRET="cs_..."                 # read_write permission
npm run dev      # watch mode, or:
npm run build && npm start
```

Optional env vars (defaults in parentheses): `HOST` (`127.0.0.1`), `PORT` (`8081`),
`WOOCOMMERCE_TIMEOUT_MS` (`10000`), `LOG_LEVEL` (`info`), `MCP_ALLOWED_HOSTS` (empty — Host
allowlist when binding to non-localhost). All are documented in the repo root
[.env.example](../../.env.example).

Point any Streamable HTTP MCP client at `http://HOST:PORT/mcp`. A minimal handshake looks
like:

```bash
curl -sS http://127.0.0.1:8081/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The response carries an `mcp-session-id` header; send it on subsequent `POST`s.

Container (Milestone 6):

```bash
docker build -f infra/docker/woocommerce-mcp/Dockerfile -t urumi/woocommerce-mcp:0.1.0 .  # from the repo root
docker run --rm -p 8081:8081 -e HOST=0.0.0.0 \        # HOST=0.0.0.0 is required in containers
  -e WOOCOMMERCE_STORE_URL=… -e WOOCOMMERCE_CONSUMER_KEY=… -e WOOCOMMERCE_CONSUMER_SECRET=… \
  urumi/woocommerce-mcp:0.1.0
```

Unconfigured containers exit 1 listing the three missing `WOOCOMMERCE_*` variables;
the image contract and validation log live in [infra/docker/README.md](../../infra/docker/README.md).

## Testing (no store, no Docker, no network)

```bash
npm test        # node --test, runs .ts sources directly (Node ≥ 23.6)
```

The suite (70 tests) is deliberately honest about what it proves:

- `test/helpers/mock-store.ts` is an **in-process fake WooCommerce REST API** (products,
  orders, pagination headers, failure injection). It is a test double, not a production
  implementation, and it never talks to the network.
- `test/mcp-protocol.test.ts` / `test/mcp-failure.test.ts` drive the real Express app over
  loopback with the **official SDK client** — real initialize, tools/list, tools/call,
  session lifecycle, validation failures and upstream error mapping.
- Unit tests cover env validation, log redaction, tool schemas, and the WooCommerce client's
  URL/auth/error behavior with an injected `fetch`.

`npm run typecheck && npm run build` must also pass (`npm run check` at the repo root runs
everything).

## Known limitations (deliberate, documented)

- **Unit tests use the mock; the real store is proven live.** All suites here run against
  the in-process mock so `npm test` needs no store. Since Milestone 10 a real
  WordPress/WooCommerce runs inside the same Kubernetes cluster and the MCP server was
  live-verified against it end to end (products and orders over authenticated REST, then
  `tools/call` through the gateway) — commands and observed results in
  [docs/requirement-matrix.md](../../docs/requirement-matrix.md) §3.
- **HTTPS required for Basic auth.** WooCommerce only accepts consumer key/secret via Basic
  auth when the request is SSL (verified in WooCommerce core `WC_REST_Authentication`).
  The in-cluster store works around this with a hostname-scoped `$_SERVER['HTTPS'] = 'on'`
  marker set by the WordPress init container (decision D31) — a *different* plain-HTTP store
  would still need TLS or OAuth 1.0a signing, which is **not implemented** (decision D17).
  The server warns at startup if `WOOCOMMERCE_STORE_URL` is `http://`.
- **One status per `list_orders` call** — the WooCommerce orders endpoint accepts a single
  status, not a list.
- **No rate-limit handling yet** (429 from the store surfaces as a generic HTTP error).
- **In-process sessions only** — fine for one replica; revisit with the gateway (Milestone 2).

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Process entry: load config, warn on `http://`, listen, graceful shutdown |
| `src/app.ts` | Express app: `/mcp` session handling, `/healthz`, `/readyz`, draining |
| `src/mcp-server.ts` | Registers the five tools on `McpServer` |
| `src/tool-schemas.ts` | zod input schemas (published as JSON Schema to clients) |
| `src/tool-handlers.ts` | Tool callbacks; formats store failures as `isError` results |
| `src/woocommerce-client.ts` | REST client: Basic auth, timeout, error mapping |
| `src/woocommerce-types.ts` | Loose response guards (products/orders) |
| `src/config.ts` / `src/logger.ts` / `src/errors.ts` | Env validation, redacting logger, error taxonomy |
| `test/` | Unit + integration tests and the mock store (see above) |
