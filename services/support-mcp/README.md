# support-mcp

An independent MCP server (official TypeScript SDK, **Streamable HTTP at `/mcp`**) that
exposes a small, deterministic **seeded demo support desk** as two MCP tools. Built as
Milestone 5 of this project; see [docs/architecture.md § 10](../../docs/architecture.md).

It exists to prove one claim: **a new upstream registers with the gateway by configuration
alone** — `SUPPORT_MCP_URL` is the only wiring, and `apps/gateway/src` did not change.

## Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `list_tickets` | read | `page` (≥ 1, default 1), `per_page` (1–100, default 10), `status` optional (`open`, `pending`, `resolved`). Returns `source: "seeded-demo"`, the matching tickets and pagination. |
| `create_ticket` | write (**not idempotent**) | `customer` (1–120 chars, trimmed) and `subject` (1–200 chars, trimmed) required; `priority` optional (`low`, `normal` default, `high`). Appends a new **open** ticket with the next id and returns it. |

The store holds **8 seeded tickets, ids 1001–1008** — fixed subjects, customers, statuses
(4 open / 2 pending / 2 resolved) and priorities, with an injectable clock so
`created_at`/`updated_at` are deterministic in tests. New tickets start at id 1009. Every
ticket created here lives only in this process's memory.

If the data source is unavailable, tools answer a fixed sentence (`The support data source
is unavailable…`; for `create_ticket` it adds `No ticket was created.`) that never contains
internals. Invalid arguments are rejected by the zod schemas before any handler runs.

There is **no real helpdesk, CRM or ticketing system** behind this server — the tool
descriptions, server instructions and every payload (`source: "seeded-demo"`) say so.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP (session-based; decision D15) |
| `/healthz` | Liveness: always `{ "status": "ok" }` while the process runs |
| `/readyz` | Readiness: `200` when accepting sessions, `503` when draining or at capacity |

## Running it

```bash
cd services/support-mcp
npm run dev      # watch mode, or:
npm run build && npm start
```

**No environment variables are required** — the seeded store is part of the process.
Optional (defaults in parentheses): `HOST` (`127.0.0.1`), `PORT` (`8084`, matching the
`SUPPORT_MCP_URL` placeholder in the repo root [.env.example](../../.env.example)),
`LOG_LEVEL` (`info`), `MCP_ALLOWED_HOSTS` (empty — Host allowlist when binding to
non-localhost).

To reach it through the gateway, set the URL (this is the entire registration):

```bash
SUPPORT_MCP_URL=http://127.0.0.1:8084/mcp   # gateway: support_list_tickets, support_create_ticket
```

Note for gateway grants: the gateway test harness's static grant set includes
`support_create_ticket` but deliberately not `support_list_tickets` — that is the
`grant_forbidden` case in `apps/gateway/test/authz-e2e.test.ts`. The production seed
(migration 001) grants the demo users WooCommerce tools only; adding `tools:support_*`
grants for real deployments stays ops SQL.

## Testing (no Docker, no network, no real data source)

```bash
npm test        # node --test, runs .ts sources directly (Node ≥ 23.6)
```

The suite (**38 tests**):

- `test/store.test.ts` — the seeded store: deterministic 8 tickets, status filters
  (4/2/2), pagination, creation semantics (next id, injectable clock, always-open
  status), defensive copies.
- `test/mcp-protocol.test.ts` — the real Express app over loopback with the **official SDK
  client**: initialize, `tools/list` (exactly the two tools), reads, creates (id
  progression, default priority), validation error results, bounded pages.
- `test/mcp-failure.test.ts` — the unavailable-data path via an injected failing store
  (fixed sentence per tool, never internals; a failed create appends nothing; list keeps
  working while create fails and vice versa), plus the raw HTTP surface: probes, 400/404
  sessions, JSON-RPC parse error (`-32700`), session capacity (`503`/`-32000`), graceful
  draining after close.
- `test/config.test.ts`, `test/tool-schemas.test.ts`, `test/logger.test.ts` — env
  validation with messages naming the variable, schema defaults/rejections, log redaction
  (bearer/API-key patterns).

`npm run typecheck && npm run build` must also pass (`npm run check` at the repo root runs
everything).

## Known limitations (deliberate, documented)

- **Seeded demo data only** — not a real support desk. No ticket ever leaves this process.
- **State lives in memory** — created tickets disappear on restart; the seed comes back
  exactly as written. A real integration would back the store interface with a database.
- **No ticket transitions** — there is no tool to reply, assign, resolve or close; the
  assignment fixes this server's surface at `list_tickets` + `create_ticket`.
- **Single process** — in-memory sessions and state; revisit with replicas (Milestone 7).

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Process entry: load config, listen, graceful shutdown |
| `src/app.ts` | Express app: `/mcp` session handling, `/healthz`, `/readyz`, draining |
| `src/mcp-server.ts` | Registers `list_tickets` + `create_ticket` on `McpServer` |
| `src/tool-schemas.ts` | zod input schemas (published as JSON Schema to clients) |
| `src/tool-handlers.ts` | Tool callbacks; formats data-source failures as `isError` results |
| `src/support-store.ts` | Deterministic 8-ticket seed + `SupportDataSource` seam (injectable clock) |
| `src/config.ts` / `src/logger.ts` / `src/errors.ts` | Env validation, redacting logger, error types |
| `test/` | Unit + protocol + failure-path tests (see above) |
