# Urumi Dashboard

The React UI for the gateway: login, overview, MCP servers, tool catalogue, chat, audit
viewer, team/key administration and connection settings. It is a **client** of the
gateway's REST API — it never speaks MCP itself, never executes tools, and never holds
credentials (including the LLM provider key, which exists only inside the gateway
process).

## Quick start

```bash
# terminal 1 — the gateway (needs DATABASE_URL + at least one *_MCP_URL;
# UPSTREAM_ALLOWED_PRIVATE_HOSTS is the C4 SSRF allow-list — required for loopback)
cd apps/gateway
DATABASE_URL=postgresql://... API_KEY_PEPPER=... WOOCOMMERCE_MCP_URL=http://127.0.0.1:8081/mcp UPSTREAM_ALLOWED_PRIVATE_HOSTS=127.0.0.1 npm run dev

# terminal 2 — the dashboard dev server (proxies /api to the gateway)
cd apps/dashboard
npm run dev            # http://127.0.0.1:5173
```

Paste a `umk_…` API key (issue one from the **Team & API keys** page as admin, or use the
seeded demo keys from migration 001) into the login screen. The key is sent once, in a
JSON body, over the server-side session endpoint — see [Browser auth](#browser-auth).

Production build:

```bash
npm run build -w @mcp/dashboard   # static bundle in apps/dashboard/dist
npm run preview -w @mcp/dashboard # serves dist with the same /api proxy
```

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `VITE_GATEWAY_API_URL` | `vite.config.ts` (Node side) | Dev/preview proxy target for `/api` — defaults to `http://127.0.0.1:8080`. Used only to configure the Vite dev server; it is **not** referenced via `import.meta.env` anywhere in `src/`, so no gateway URL or env value is inlined into the shipped bundle. All runtime requests are relative (`/api/...`) and same-origin. |

No other environment variable exists. There is no `VITE_API_KEY`, no token var, and no
feature flag — credentials never come from build-time configuration.

## Routes & UI structure

The router is a hand-rolled hash router (no dependency): `parseRoute` in
`src/lib/routes.ts` (pure, unit-tested) maps the hash to a route id. Old `#/…` paths keep
working; unknown hashes fall back to Overview.

| Route | Page | Group | Access |
| --- | --- | --- | --- |
| `#/overview` | Overview — real metrics only (upstream counts, tool counts, last 10 audit rows for admins, quick links, gateway-status pill) | Platform | any |
| `#/upstreams` | MCP servers — per-server status (missing / disabled / degraded / healthy), expandable tool lists, woocommerce mock-vs-real badge, admin Enable/Disable behind a confirmation dialog | Platform | any (toggle = admin) |
| `#/tools` | Tool catalogue — search + upstream filter + per-row permission indicator mirroring the gateway's authorization | Platform | any |
| `#/chat` | Chat — conversation kept in a module-level store (survives route changes), Stop via AbortController, Retry for the last user turn, tool-call chips with upstream + outcome | Platform | any |
| `#/audit` | Audit log — keyset pagination + action/outcome/upstream/tool/actor filters, failure-obvious badges, `error_code` column | Governance | admin |
| `#/team` | Team & API keys — members CRUD (POST/PATCH `/api/users`), key issue/revoke; the plaintext key is shown **exactly once** in a non-dismissable modal | Governance | admin |
| `#/settings` | Settings — copyable connection snippets (endpoint, curl, MCP Inspector, JSON client config) built by pure functions; local-only and "example, not confirmed" labelling | Help | any |

The sidebar groups entries under **Platform / Governance / Help**; admin-only entries are
hidden from members (the server still answers 403 — the UI never predicts permissions).
The topbar shows the current page title, the principal's name + role badge ("reader" is
labelled **Member**), a gateway-connection pill derived from real API success timestamps
(`/healthz` is not proxied, so there is no separate probe), a theme toggle (persisted to
`localStorage`, follows `prefers-color-scheme` until overridden) and Sign out. Any 401
outside the login page returns to the login screen with a "session expired" note.

## Design tokens & styling

Hand-written CSS, zero styling dependencies. `src/styles.css` aggregates four layers:

| File | Contents |
| --- | --- |
| `src/styles/tokens.css` | Full token set: color (dark default + `[data-theme="light"]` overrides), type scale (12/13/14/16/20/24/30), spacing scale (4…48), radii, borders, elevation shadows, focus ring, motion durations/easings, z-index layers, sidebar/topbar metrics |
| `src/styles/base.css` | Reset, typography, visible `:focus-visible` rings, `prefers-reduced-motion` handling, `.sr-only`, skip link, spinner |
| `src/styles/components.css` | Buttons (primary/secondary/ghost/danger, sizes, disabled), inputs/selects/labels/fieldsets, cards, tables (sticky header, horizontal scroll on ~375px), badges/status pills, banners, modal, toasts, skeletons (shimmer), empty states, code blocks, chat, one-time key reveal |
| `src/styles/layout.css` | Shell, topbar, persistent sidebar ≥ 900px, overlay-drawer navigation ≤ 900px, small-phone tweaks |

Theme boot: a tiny inline script in `index.html` applies the stored/system theme before
first paint (no flash); the App toggle writes `localStorage["urumi-theme"]` (try/catch —
storage may be disabled) and updates `<meta name="theme-color">`.

## Source layout

```
src/
  api/client.ts        single fetch wrapper: relative /api, same-origin credentials,
                       typed methods (auth, me, settings, tools, upstreams, audit+filters,
                       users CRUD, keys issue/revoke, chat with AbortSignal), error classes
  state.ts             LoadState machine, audit projection (redaction), toast + theme helpers
  lib/routes.ts        pure hash-route parsing / nav model
  lib/permissions.ts   pure mirror of the gateway's tool authorization (role ceiling on
                       write verbs + upstream grant + exact tools: grant) + label helpers
  lib/audit.ts         pure audit filter query builder (whitelists, 64-char tool cap)
  lib/chat.ts          pure chat helpers: history slice, retry target, id generation,
                       tool-chip labels, upstream parsing, abort detection
  lib/chatStore.ts     module-level conversation store (survives route changes)
  lib/connection.ts    API-outcome tracking for the status pill + 401 → session-expired
  lib/selectors.ts     pure upstream-health labels, error sanitisation (no internal URLs),
                       tool grouping/filtering
  lib/settings.ts      pure snippet builders (endpoint/curl/inspector/JSON client);
                       null endpoint ⇒ clearly-labelled EXAMPLES, never invented URLs
  components/          ui atoms, Modal, ConfirmDialog, Toasts, CopyButton, MemberForm
  pages/               one file per route
  styles/              design-system layers (imported via styles.css)
```

All non-trivial logic lives in `src/lib/**` as pure functions so it can be unit-tested
without a DOM. Components stay declarative: loading / empty / error / disabled states are
explicit everywhere; fetches carry sequence counters or AbortControllers so stale
responses cannot overwrite newer actions; timers and listeners are cleaned up on unmount.

## Features

| Page | What it does | Server-side backing |
| --- | --- | --- |
| **Login** | paste key → `POST /api/auth/login` → httpOnly session cookie → `/api/me` | `web_sessions` row stores only `sha256(token)` |
| **Overview** | configured/enabled/reachable/unreachable upstream counts, total + per-upstream tool counts, last 10 audit rows (admin), gateway-status pill + last-refreshed, quick links | `/api/me`, `/api/upstreams`, `/api/tools`, `/api/audit?limit=10` |
| **MCP servers** | distinct missing/disabled/degraded/healthy status, expandable tool lists, `mock` vs `real` WooCommerce badge ("Demo mock store" vs "Real store"), sanitised last error, client-side last-checked time; admin enable/disable behind a confirmation dialog explaining discovery + rejection impact | `GET /api/upstreams`, `GET /api/tools`, `POST /api/upstreams/<id>:enable|disable` |
| **Tool catalogue** | search (name/qualified/description), upstream filter, count summary, per-row permission indicator derived from `/api/me`, degraded-upstream banners | `GET /api/tools` (mirror of the registry behind `tools/list`) |
| **Chat** | conversation persists across routes; clickable example prompts; Stop (AbortController); Retry for the last user turn; tool chips (tool + upstream + gateway-computed outcome); rounds shown subtly; plain text only; 4000-char cap | `POST /api/chat` → server-side agent; 503 `agent_not_configured` when no provider is set |
| **Audit log** | keyset pagination (10/25/50/100), filters (action, outcome, upstream, tool text, actor select from `/api/users`), clear-filters, distinct empty vs filtered-empty, outcome badges, `title=UTC ISO` timestamps, `error_code` column | `GET /api/audit?limit=…&before=…&action=…&outcome=…&upstreamId=…&tool=…&userId=…` (admin only) |
| **Team & API keys** | members table + create/edit (role, upstream checkboxes, advanced tool-grant multi-select); 409 ⇒ "name already in use"; keys table (metadata only); issue ⇒ one-time modal (Copy with fallback, "shown once" warning, explicit "I stored it" close); revoke behind a danger confirm, `already_revoked` reflected, revoked rows visually distinct | `GET/POST/PATCH /api/users`, `GET/POST /api/keys`, `POST /api/keys/:id/revoke` |
| **Settings** | copyable endpoint / curl / MCP Inspector / JSON-client snippets from pure builders; Bearer-auth + single-endpoint + qualified-name explanation; "local only" badge for loopback endpoints; `chat_enabled` indicator | `GET /api/settings` |

The registry is deploy-time config: the dashboard intentionally offers **no** add/edit/
remove of servers — one honest line on the MCP servers page says so.

### Chat

The browser sends `{message, history}` to `POST /api/chat` with the session cookie. The
LLM runs **inside the gateway**; every tool call it makes is authorized against *your*
principal and audited exactly once (the same pipeline as `/mcp`). Tool chips under each
answer are **gateway-computed** outcomes — model prose cannot relabel a failed call as a
success. No provider key ever reaches the bundle: if the gateway is unconfigured, the page
shows a setup banner instead of generating anything.

### What is deliberately NOT here

- **No tool execution.** Tool calls happen exclusively inside the gateway (`/mcp` or the
  agent's shared pipeline); this UI mirrors the list and reports chat outcomes.
- **No direct upstream URLs.** Toggles target fixed registry ids only; configuring an
  upstream's URL remains an environment concern (`*_MCP_URL`). Last-error text is
  sanitised so internal URLs never render.
- **No invented metrics or endpoints.** Every number on Overview is counted from a real
  API response; Settings never presents an example URL as confirmed (the `mcp_endpoint`
  comes from `GATEWAY_PUBLIC_URL` or is explicitly labelled EXAMPLE).
- **No fake streaming** in chat — replies appear when the gateway responds.

## Browser auth (D23)

1. The API key is pasted once and posted to `/api/auth/login` **in the JSON body** (never a
   URL, query parameter or header that lands in logs/history).
2. The server verifies it against `sha256(key‖pepper)`, then creates a `web_sessions` row
   containing only `sha256(session_token)`, bound to the key's user, 12-hour expiry.
3. The browser receives `Set-Cookie: urumi_session=…; HttpOnly; SameSite=Strict; Secure`.
   The token itself never enters application storage — nothing is kept in
   `localStorage`/`sessionStorage`/URLs, and `HttpOnly` keeps it out of JS reach.
4. Subsequent `/api` requests carry the cookie automatically. The middleware honors it
   **only** under `/api/*`, and only when no `Authorization` header is present (a malformed
   Bearer never silently falls back to the cookie). `/mcp` remains Bearer-only.
5. Authorization is always server-side: members simply get 403s (with an `access_denied`
   audit row) — hiding buttons in the UI is cosmetic only. The catalogue's permission
   indicator mirrors `apps/gateway/src/auth/authorization.ts` exactly (role ceiling on
   write verbs → upstream grant → exact `tools:` grant) but is advisory.
6. A 401 from any tracked call flips the app to the login screen with a "session expired"
   note — stale pages are never left on screen.

## Testing

```bash
npm run typecheck -w @mcp/dashboard   # strict tsc over src + test + vite.config
npm run build -w @mcp/dashboard       # production bundle must compile
npm test -w @mcp/dashboard            # node:test (Node type-stripping), no extra framework
```

Strategy (documented honestly): the components' DOM behavior is verified by `tsc` +
`vite build`; everything with logic lives in pure modules that are unit-tested under
`node --test`:

- `test/client.test.ts` — relative `/api` paths only, key in JSON body (never URL),
  401→`UnauthorizedError`, 403→`ForbiddenError`, 5xx/network→structured errors (with safe
  `message`), bounded audit queries (`limit`+`before`+whitelisted filters, never `offset`),
  admin surface paths (users/keys/settings), one-time key passthrough, AbortSignal
  passthrough for chat.
- `test/state.test.ts` — loading/loaded/empty/error transitions, limit clamping (1–100),
  keyset cursor, the **audit redaction projection** (no key material, hashes, headers,
  pepper or passwords ever reach the render layer), bounded toasts, theme resolution.
- `test/routes.test.ts` — every route round-trips; legacy `#/…` hashes keep working;
  unknown hashes fall back; admin-only nav filtering per role.
- `test/permissions.test.ts` — the tool-permission predicate mirrors the gateway
  (write-verb role ceiling, upstream grant, exact `tools:` grant, fail-closed unknown
  tools), label helpers, local-endpoint detection.
- `test/audit.test.ts` — filter query builder: whitelists, trimming, 64-char tool cap,
  blank-value omission, outcome tones.
- `test/chat.test.ts` — history slice bounds, retry-target selection (last user turn +
  preceding history only), monotonic id generation, chip labels, upstream parsing, abort
  detection, example prompts.
- `test/settings.test.ts` — snippet builders: confirmed endpoint vs labelled examples,
  Bearer placeholder (never a real key), curl/Accept headers, inspector CLI shape, valid
  JSON client config.
- `test/selectors.test.ts` — upstream health labels/tones, error sanitisation (internal
  URLs stripped), tool grouping/filtering, count summaries.
- `test/connection.test.ts` — the status pill derivation from real API success/failure
  timestamps (unknown / connected / unreachable).

No test framework was added (₹0 budget). Component behavior that would need a DOM
harness is kept out of the pages by pushing logic into `src/lib/**` and
`src/api/client.ts`.

## Known limitations

- The production bundle is plain static files; `urumi/dashboard` (Milestone 6) serves
  them with nginx and proxies `/api` only when `GATEWAY_UPSTREAM` is set at runtime —
  in Kubernetes the Ingress owns `/api` instead (Milestone 7). `npm run preview`
  exercises the same proxy config during development.
- No route guards beyond server responses — the UI shows the 403 the server returned
  rather than predicting permissions (the permission column on the catalogue is a
  labelled mirror of the server rules, for guidance only).
- Polling is deliberately avoided: status pages refresh via explicit buttons (plus a
  low-frequency re-render for the pill's clock), so the dashboard does not hammer the
  gateway (threat-model C7).
- Chat depends on the gateway's optional LLM configuration: without a provider the page
  shows a setup banner; see [docs/architecture.md §9.3](../../docs/architecture.md) and
  decisions D29/D30.
- The clipboard Copy button uses `navigator.clipboard` with a `execCommand` fallback;
  in rare non-secure contexts without either, it reports "Copy failed" rather than
  pretending.
