# inventory-mcp

An independent MCP server (official TypeScript SDK, **Streamable HTTP at `/mcp`**) that
exposes a small, deterministic **seeded demo inventory** as two MCP tools. Built as
Milestone 5 of this project; see [docs/architecture.md § 10](../../docs/architecture.md).

It exists to prove one claim: **a new upstream registers with the gateway by configuration
alone** — `INVENTORY_MCP_URL` is the only wiring, and `apps/gateway/src` did not change.

## Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `list_products` | read | `page` (≥ 1, default 1), `per_page` (1–100, default 10), `warehouse` (seeded demo uses `north` and `south`). Returns `source: "seeded-demo"`, the filtered products and pagination. |
| `adjust_stock` | write (**not idempotent**) | `sku` (1–64 chars, matched case-insensitively after trimming) and `delta` (non-zero integer, −1000…1000). Applies the change in memory and returns `previous_quantity`, `delta` and the new `quantity`. |

The store holds **12 seeded SKUs, 6 per warehouse** (e.g. `TEE-BLK-M` at 120,
`TOTE-NAT-01` at 27) — deterministic, no randomness. Unknown SKUs and changes that would
drop stock below zero are rejected with a friendly `isError` result. If the data source is
unavailable, tools answer a fixed sentence (`The inventory data source is unavailable. No
stock was changed…`) that never contains internals. Invalid arguments are rejected by the
zod schemas before any handler runs.

There is **no real warehouse, WMS or stock system** behind this server — the tool
descriptions, server instructions and every payload (`source: "seeded-demo"`) say so.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP (session-based; decision D15) |
| `/healthz` | Liveness: always `{ "status": "ok" }` while the process runs |
| `/readyz` | Readiness: `200` when accepting sessions, `503` when draining or at capacity |

## Running it

```bash
cd services/inventory-mcp
npm run dev      # watch mode, or:
npm run build && npm start
```

**No environment variables are required** — the seeded store is part of the process.
Optional (defaults in parentheses): `HOST` (`127.0.0.1`), `PORT` (`8083`, matching the
`INVENTORY_MCP_URL` placeholder in the repo root [.env.example](../../.env.example)),
`LOG_LEVEL` (`info`), `MCP_ALLOWED_HOSTS` (empty — Host allowlist when binding to
non-localhost).

To reach it through the gateway, set the URL (this is the entire registration):

```bash
INVENTORY_MCP_URL=http://127.0.0.1:8083/mcp   # gateway: inventory_list_products, inventory_adjust_stock
```

Container (Milestone 6):

```bash
docker build -f infra/docker/inventory-mcp/Dockerfile -t urumi/inventory-mcp:0.1.0 .  # from the repo root
docker run --rm -p 8083:8083 -e HOST=0.0.0.0 urumi/inventory-mcp:0.1.0    # HOST=0.0.0.0 is required in containers
```

No other configuration; the image contract and validation log live in
[infra/docker/README.md](../../infra/docker/README.md).

## Testing (no Docker, no network, no real data source)

```bash
npm test        # node --test, runs .ts sources directly (Node ≥ 23.6)
```

The suite (**39 tests**):

- `test/store.test.ts` — the seeded store: deterministic 12 SKUs, 6 per warehouse,
  pagination, adjust semantics (previous quantity, case-insensitive SKU, unknown SKU and
  below-zero rejections), defensive copies.
- `test/mcp-protocol.test.ts` — the real Express app over loopback with the **official SDK
  client**: initialize, `tools/list` (exactly the two tools), reads, writes, validation
  error results, bounded pages.
- `test/mcp-failure.test.ts` — the unavailable-data path via an injected failing store (the
  fixed sentence, never internals; one tool failing does not break the other), plus the raw
  HTTP surface: probes, 400/404 sessions, JSON-RPC parse error (`-32700`), session
  capacity (`503`/`-32000`), graceful draining after close.
- `test/config.test.ts`, `test/tool-schemas.test.ts`, `test/logger.test.ts` — env
  validation with messages naming the variable, schema defaults/rejections, log redaction
  (bearer/API-key patterns).

`npm run typecheck && npm run build` must also pass (`npm run check` at the repo root runs
everything).

## Known limitations (deliberate, documented)

- **Seeded demo data only** — not a real inventory system. Nothing outside this process is
  read or written.
- **State lives in memory** — adjustments persist until the process restarts, then the seed
  comes back. A real integration would back the store interface with a database.
- **Single process** — in-memory sessions and state; revisit with replicas (Milestone 7).
- `warehouse` is a free-form filter string that happens to match the seed (`north`,
  `south`) — an unknown value yields an empty page, not an error.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Process entry: load config, listen, graceful shutdown |
| `src/app.ts` | Express app: `/mcp` session handling, `/healthz`, `/readyz`, draining |
| `src/mcp-server.ts` | Registers `list_products` + `adjust_stock` on `McpServer` |
| `src/tool-schemas.ts` | zod input schemas (published as JSON Schema to clients) |
| `src/tool-handlers.ts` | Tool callbacks; formats data-source failures as `isError` results |
| `src/inventory-store.ts` | Deterministic seed + `InventoryDataSource` seam (tests inject failures) |
| `src/config.ts` / `src/logger.ts` / `src/errors.ts` | Env validation, redacting logger, error types |
| `test/` | Unit + protocol + failure-path tests (see above) |
