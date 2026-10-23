# Demo runbook — definition of done, two users, end to end

This runbook is the reproducible script for the assignment's **definition of
done** ("Your demo must show this flow working end to end, with two different
users") against the kind cluster `urumi-local` (Helm release `urumi`, namespace
`urumi`). Every step names its **evidence status** so nothing unperformed is
ever claimed as verified:

| Legend | Meaning |
| --- | --- |
| ✅ **LIVE** | Executed on the cluster on **2026-10-22** (Phase 4 pass); result recorded in the step |
| 🧪 **TEST** | Pinned by the named deterministic test (mocks/doubles only — no network, no LLM quota) |
| 👤 **MANUAL** | Needs human/browser interaction at demo time — treat as manual even where a script once verified it |
| ⛔ **BLOCKED** | Cannot be performed in this environment right now; reason stated (never marked verified) |

Browser steps (T1–T4) are **dual-status**: their scripted check passed live, but
for a demo you perform them **by hand in a browser** — count them as MANUAL
steps when rehearsing. Groq-dependent steps (T3–T4 chat half) are ⛔ BLOCKED by
the provider's free-tier quota (see "Chat reliability" at the end). Everything
in this runbook is the **local** kind demo — the public VPS/k3s deployment is
documented (`infra/helm/README.md` "Deploying to a future VPS") but **not
executed or verified**; no public deployment exists.

Two users (seeded by `apps/gateway/migrations/`) — **the two demo identities**:

| Role in the PDF | Principal | Credential |
| --- | --- | --- |
| **User A — admin** (`admin-demo`) | `11111111-1111-4111-8111-111111111111` | `umk_…` bootstrapped per `infra/helm/README.md` "Secrets and API-key bootstrap" |
| **User B — team member** (`reader-demo`) | `22222222-2222-4222-8222-222222222222` | `umk_…` issued by user A via the dashboard/API — **read tools only** (writes denied by the reader ceiling) |

> **Secrets discipline for the whole runbook.** Both demo keys live **only** in
> the Git-ignored local file `.tmp/demo-keys.json` (permissions `0600`; verified
> ignored via `.gitignore`'s `.tmp/` rule). Load them into your shell **without
> printing them** and keep using the `$USER_A_KEY` / `$USER_B_KEY` placeholders
> below. Store credentials (`$WC_KEY`/`$WC_SECRET`, WordPress admin password)
> are read from the `urumi-secrets` Secret the same way. Never print, paste or
> commit a key, cookie, or password — not in the terminal, README, screenshots,
> or commits.

```bash
# load both demo keys as shell variables (prints nothing)
USER_A_KEY=$(python3 -c "import json;print(json.load(open('.tmp/demo-keys.json'))['admin']['key'])")
USER_B_KEY=$(python3 -c "import json;print(json.load(open('.tmp/demo-keys.json'))['reader']['key'])")
```

**Where the credentials come from (fresh machine):** if `.tmp/demo-keys.json`
does not exist, regenerate the two keys with the documented flows — bootstrap
one admin key (`infra/helm/README.md` "Secrets and API-key bootstrap"), then
have the admin issue the reader key (`POST /api/keys` or Team → Create key in
the dashboard). Each key's plaintext is shown **exactly once** — paste it
straight into `.tmp/demo-keys.json` and `chmod 600` the file.

---

## 0. Prerequisites (once per machine)

```bash
# cluster + release up (9 deployments, 3 PVCs Bound)
kubectl -n urumi get pods && kubectl -n urumi get pvc

# one ingress port-forward (demo URLs) + fallbacks for curl/SDK
echo "127.0.0.1 dashboard.urumi.test shop.urumi.test" | sudo tee -a /etc/hosts
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
kubectl -n urumi port-forward svc/gateway 8080:8080 &        # SDK/curl target

# demo URLs
#   dashboard:  http://dashboard.urumi.test:18080   (login with $USER_A_KEY / $USER_B_KEY)
#   storefront: http://shop.urumi.test:18080
#   MCP:        http://dashboard.urumi.test:18080/mcp  (or http://127.0.0.1:8080/mcp)
```

Store checkout uses **Cash on delivery** (the PDF's "test-friendly method").
It is enabled once via the WooCommerce REST API (store config, no code).
The same call pattern also **launches** the store: WooCommerce installs in
"coming soon" mode by default (`woocommerce_coming_soon = yes`), which shows
guests a placeholder instead of the catalog — set it to `no` (the plugin's own
"launch store" switch) or every storefront step below fails with an empty shop:

```bash
# from the gateway pod; $WC_KEY/$WC_SECRET read from urumi-secrets, never printed
kubectl -n urumi exec deploy/gateway -c gateway -- node -e "
const auth = 'Basic ' + Buffer.from(process.env.CK + ':' + process.env.CS).toString('base64');
fetch('http://wordpress/wp-json/wc/v3/payment_gateways/cod', { method: 'PUT',
  headers: { authorization: auth, 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true }) }).then(r => console.log('cod:', r.status));"
```

```bash
# launch the store — WooCommerce ships in "coming soon" mode (guests would see
# a placeholder instead of the catalog). One option flip, then the shop renders:
kubectl -n urumi exec -i deploy/wordpress-db -c mariadb -- sh -c \
  'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' <<'SQL'
UPDATE wp_options SET option_value='no' WHERE option_name='woocommerce_coming_soon';
SQL
```

✅ **LIVE** (2026-10-22): `cod enabled: true`.

---

## 1. Store — open the storefront, buy something (PDF DoD "Store")

**T1. Add a product to the cart and check out with COD.** ✅ LIVE (scripted)
· **👤 MANUAL at demo time** — browser flow
(`shop.urumi.test:18080`), executed live via Playwright (Chromium,
`--host-resolver-rules=MAP shop.urumi.test 127.0.0.1`):

1. `http://shop.urumi.test:18080/shop/` → open *Araku Valley Coffee 250g* → **Add to cart**.
2. `http://shop.urumi.test:18080/checkout/` → fill contact + billing (block checkout;
   a US-shaped address keeps the postcode validator happy), select **Cash on delivery**
   → **Place order**.

✅ **LIVE**: order-received page `…/checkout/order-received/17/?key=…` —
*“Thank you. Your order has been received. Order #: 17 … Payment: Cash on
delivery … Total: $12.00”*. Screenshot: `.tmp/dod/order-received.png`
(gitignored; the flow is re-runnable with
`PW_PATH=… node scripts/demo/storefront-checkout.cjs`).

**T2. Confirm the order is visible in WooCommerce admin.** ✅ LIVE (scripted)
· **👤 MANUAL at demo time**:
Playwright logs into `shop.urumi.test:18080/wp-login.php` as the WordPress
admin (password from `urumi-secrets` → `WP_ADMIN_PW` env, never printed) and opens
**WooCommerce → Orders** (`wp-admin/admin.php?page=wc-orders`) — re-runnable with
`WP_ADMIN_PW=… PW_PATH=… node scripts/demo/wp-admin-orders-check.cjs`:

> `Preview #17 Ada Lovelace … Processing $12.00` (alongside seeded #14, #15)

Cross-check from the platform side (same data through our own MCP server):

```bash
# user B's external client answers "what orders came in today"
# tools/call woocommerce_list_orders → ids [14, 15, 17], #17 processing, $12.00
```

✅ **LIVE**. 🧪 **TEST**: `services/woocommerce-mcp` suite (list/get/update
order tools, 70 tests) + `apps/gateway/test/external-client.test.ts`.

---

## 2. Chat agent, as user A (PDF DoD "Chat agent, as user A")

Login at `http://dashboard.urumi.test:18080` with `$USER_A_KEY`, open **Chat**.

**T3. Ask the agent to create a product (name + price); the product appears on
the storefront.** 👤 **MANUAL** at demo time.
⛔ **BLOCKED right now**: the configured free-tier LLM provider (Groq) is
rate-limiting the demo account (`chat_provider_failed {kind: rate_limited,
status: 429}` observed 2026-10-22; the gateway answers `429
provider_rate_limited` with `retry_after_seconds` and the UI offers "Retry last
message"). **This is a provider quota limitation, not fixed by code** — the
chat stack is ready and is pinned by tests; a fresh live LLM turn is simply not
available this pass. Historical evidence: the full agent loop (incl. model-led
`create_product`) ran live on Groq in Milestone 9 (see
`docs/requirement-matrix.md` §4 and README "Current status").
🧪 **TEST**: `apps/gateway/test/agent/agent.test.ts` (grounded tool loop,
injection containment, exactly-one audit row per call),
`apps/gateway/test/chat-api.test.ts`, `apps/gateway/test/dod-flow.test.ts` D8
(chat offered tools follow upstream enable/disable).

**T4. Place an order by hand on the storefront, then ask "what orders came in
today" — it returns that order.** 👤 **MANUAL** (chat half ⛔ same quota
blocker as T3). The storefront half is exactly T1 (✅ LIVE, order #17), and
the same question is answered by the external client as user B in T5 (✅ LIVE)
— only the chat UI answer needs the provider quota.

---

## 3. External MCP client, as user B (PDF DoD "External MCP client, as user B")

Any Streamable-HTTP MCP client works: MCP Inspector, Claude Code, Cursor — or
the official SDK test in this repo. **Only the gateway URL + user B's key** are
configured; no upstream is configured in the client.

**T5. See the tools of every enabled server, and ask the orders question.**
✅ **LIVE** (2026-10-22), official MCP TypeScript SDK against the deployed
gateway via `kubectl port-forward svc/gateway 8080:8080`:

```bash
GATEWAY_URL=http://127.0.0.1:8080 GATEWAY_API_KEY=$USER_B_KEY \
  node --test apps/gateway/test/external-client.test.ts
```

> `initialize handshake and tools/list` ✔ (9 qualified tools from 3 servers),
> `tools/call` ✔ — and `woocommerce_list_orders` (the orders question) returns
> order **#17** (`processing`, `$12.00`, dated today) ✅ **LIVE**.

**T6. One prompt that needs tools from two different upstreams.** ✅ **LIVE**:
same session, `woocommerce_list_products` **and** `inventory_list_products`
both succeed for user B (reader grants cover both reads — migration 005).

🧪 **TEST**: `apps/gateway/test/external-client.test.ts` "DoD D6" (runs the
two-upstream session whenever `GATEWAY_URL`/`GATEWAY_API_KEY` are set; explicit
skip otherwise) and `apps/gateway/test/dod-flow.test.ts` "D6" (deterministic
in-harness twin).

MCP Inspector equivalent (manual): `npx @modelcontextprotocol/inspector` →
HTTP → `http://127.0.0.1:8080/mcp` → `Authorization: Bearer $USER_B_KEY`.

---

## 4. Member permissions (PDF user stories, "Team and access")

👤 **MANUAL at demo time** (takes 30 seconds) — the exact behavior is
🧪 **TEST**-pinned on both sides (`authorization.test.ts` "grants bind admins
too", dashboard `permissions.test.ts` parity matrix; ✅ **LIVE** in the M10
security demo):

- User B signs in at `http://dashboard.urumi.test:18080` with their key →
  **Team** area is hidden (admin-only); **Settings → Your API keys** is present.
- User B calls a write tool (`inventory_adjust_stock`, `woocommerce_create_product`)
  over MCP → JSON-RPC `-32003 … not granted to this principal` (the reader role
  is a hard ceiling over grants). The Tools page indicator shows **denied** for
  the same tool — server and UI agree.
- User B never sees an upstream credential: no API returns them; WooCommerce
  consumer key/secret exist only inside the `woocommerce-mcp` pod env.

---

## 5. API-key issuance and revocation (PDF DoD "Team and control")

**T7. Revoke user B's key. Their next call is rejected.** ✅ **LIVE**
(2026-10-22), scripted end-to-end (Phase 4 session):

1. User B self-serves a fresh key: `POST /api/me/keys` (Bearer `$USER_B_KEY`) →
   `201` + plaintext **once** (`key_created` audited). *(M1 story — member
   generates their own key.)*
2. The fresh key calls `inventory_list_products` over MCP → success.
3. User A (admin) revokes it in the dashboard (Team → keys → Revoke), i.e.
   `POST /api/keys/<id>/revoke` → `200 {"already_revoked": false}`.
4. The very next MCP call with that key → **401**, and `GET /api/me` → **401**.

🧪 **TEST**: `apps/gateway/test/dod-flow.test.ts` "D7"/"D10",
`test/api.test.ts` (revocation idempotent + audited + immediate),
`test/auth-middleware.test.ts` ("revoking the key kills the live session on its
next request"), `test/integration/postgres.test.ts` (same through real SQL).

---

## 6. Upstream disable/enable (PDF DoD "Team and control")

**T8. Disable one upstream server. Its tools disappear from both the chat
agent and the external client.** ✅ **LIVE** (2026-10-22), as user A in the
dashboard (Upstreams → inventory → Disable), or `POST
/api/upstreams/inventory:disable`:

| Probe | Before | Disabled | Re-enabled |
| --- | --- | --- | --- |
| external client `tools/list` (user B) | 9 tools | **7** (no `inventory_*`, `woocommerce_*` intact) | 9 |
| chat agent / Tools page mirror `GET /api/tools` | 9 tools | **7** (inventory group gone) | 9 |

🧪 **TEST**: `apps/gateway/test/dod-flow.test.ts` "D8" (both the client's
`tools/list` **and** the agent's offered tool list lose the disabled
upstream's tools, siblings unaffected, re-enable restores),
`test/mcp-protocol.test.ts` ("a disabled upstream publishes no tools").
Audit rows `upstream_disabled` / `upstream_enabled` ✅ **LIVE** (attributed to
user A).

---

## 7. Failure isolation (PDF DoD "Team and control")

**T9. Kill the pod of one upstream server. The other servers keep working, and
the dashboard shows the dead one as unreachable.** ✅ **LIVE** (2026-10-22).
For an *observable* outage window the demo scales the stateless
`inventory-mcp` deployment to 0 (the literal `kubectl delete pod …` variant is
in the comments — on a fast cluster the replacement pod arrives too quickly to
demo):

```bash
kubectl -n urumi scale deploy/inventory-mcp --replicas=0
# … probes here …
kubectl -n urumi scale deploy/inventory-mcp --replicas=1   # restore
```

Observed during the outage (user B's session):

- `inventory_list_products` → tool error *"upstream 'inventory' is unreachable
  (the connection failed)"* — structural failure, no internals leaked.
- `woocommerce_list_products` → **success** (sibling keeps working).
- Dashboard (user A): `GET /api/upstreams` → `inventory: reachable=false` with
  a `last_error` present → the Upstreams page shows it as degraded/unreachable.
- After restore: the same call succeeds again.

🧪 **TEST**: `apps/gateway/test/dod-flow.test.ts` "D9" (kill in-harness
upstream: fails alone, sibling fine, `/api/upstreams` unreachable with
`last_error`), `test/mcp-failure.test.ts` (timeouts, dead and hanging
upstreams, no breakage of siblings), `test/real-upstreams.test.ts`
("SIGKILLing one server fails only its own tools, leaking no internals").

> Known cosmetic gap: the dashboard's `last_error` for a connection-refused
> upstream currently shows a generic `TypeError` rather than a friendlier
> "connection refused" sentence. The DoD requirement (shown as unreachable) is
> met; nicer wording is open work.

---

## 8. Audit logs (PDF DoD "Team and control")

**T10. Every call above appears in the audit log, attributed to the right
user.** ✅ **LIVE** (2026-10-22), user A opens **Audit**
(`GET /api/audit?limit=100`) after the session. Recorded in this pass:

| Action | Actor | Detail |
| --- | --- | --- |
| `tool_call` ×14 | user B (`2222…`) | `woocommerce/list_products`, `woocommerce/list_orders`, `inventory/list_products` — each `success`/`error` with duration |
| `key_created` | user B | self-served key (T7) |
| `key_revoked` | user A (`1111…`) | names the revoked key id (T7) |
| `upstream_disabled` / `upstream_enabled` | user A | `inventory` (T8) |
| `auth_failed` | — | the revoked key's rejected attempts (4 rows) |

🧪 **TEST**: `apps/gateway/test/dod-flow.test.ts` "D10" (member's calls
attributed to member, `key_revoked` attributed to the acting admin with the
revoked key id), `test/integration/postgres.test.ts` (exactly-one audit row
per MCP call through real SQL), `test/audit.test.ts` (sanitization + pagination).

---

## 9. Persistence after pod restarts

**T11.** ✅ **LIVE** (2026-10-22): `kubectl -n urumi rollout restart
deploy/gateway deploy/wordpress` (PVCs untouched; `helm.sh/resource-policy=keep`)
— afterwards: orders `[14, 15, 17]` (the browser-placed #17 **survives**), the
same 4 products, user B's key still authenticates (Postgres PVC), audit history
intact, storefront and dashboard healthy again.
🧪 **TEST**: `test/integration/postgres.test.ts` (migrations idempotent; data
models through real SQL), matrix §9 ("Pods restart without losing data" —
postgres+wordpress restart drill with audit-id continuity).

---

## 10. DoD mapping (PDF → evidence — nothing unperformed is marked verified)

| PDF definition-of-done line | Runbook step | Evidence status |
| --- | --- | --- |
| Open the storefront, add a product to the cart, check out with a test-friendly method (COD) | T1 | ✅ LIVE (Playwright, order #17) + 🧪 `woocommerce-mcp` suite |
| Confirm the order is visible in WooCommerce admin | T2 | ✅ LIVE (wp-admin browser, Orders table) |
| Chat as user A: agent creates a product, product appears on the storefront | T3 | ⛔ BLOCKED (free-tier LLM quota) — 👤 MANUAL at demo time; 🧪 agent/chat suites; historical M9 live evidence |
| Chat as user A: place an order by hand, ask "orders today", it returns that order | T4 | storefront half ✅ LIVE (T1/T5); chat half ⛔ BLOCKED (same quota) — 👤 MANUAL |
| External client as user B: gateway URL + own key → tools of every enabled server + orders question | T5 | ✅ LIVE (official SDK 3/3 incl. #17) + 🧪 `external-client.test.ts` |
| One prompt needing tools from two different upstreams | T6 | ✅ LIVE (one session: woocommerce + inventory) + 🧪 `dod-flow.test.ts` D6 |
| Revoke user B's key → next call rejected | T7 | ✅ LIVE (mint → call → revoke → 401×2) + 🧪 `dod-flow.test.ts` D7/D10 |
| Disable one upstream → its tools gone from chat agent **and** external client | T8 | ✅ LIVE (9→7→9; both surfaces) + 🧪 `dod-flow.test.ts` D8 |
| Kill one upstream's pod → others keep working; dashboard shows it unreachable | T9 | ✅ LIVE (scale-0 drill; literal `delete pod` in comments) + 🧪 `dod-flow.test.ts` D9, `mcp-failure.test.ts` |
| Every call appears in the audit log attributed to the right user | T10 | ✅ LIVE (table above) + 🧪 `dod-flow.test.ts` D10 |
| Two different users throughout | all | ✅ LIVE (user A admin-demo / user B reader-demo in every step) |
| Persistence of store + platform state across pod restarts | T11 | ✅ LIVE + 🧪 postgres integration suite |

User-story extras covered by the same steps: member generates their own key
(T7.1 ✅), one gateway URL + own key sees every server (T5 ✅), chat acts as the
logged-in user (T3/T4 🧪 `agent.test.ts` audit-attribution assertions, C2),
member never needs upstream credentials (§4 ✅/🧪 threat-model C3).

---

## 11. Chat reliability (Groq free tier — quota limitation and verified retry behavior)

**The limitation, stated honestly:** the chat agent's live LLM provider is the
**Groq free tier**, and the demo account is currently **exhausted/limited** —
real `HTTP 429` responses were observed (`chat_provider_failed
{"kind":"rate_limited","status":429,"retry_after_ms":12000}` in the gateway
log, 2026-10-22). This is an **external quota limitation, not fixed by code**,
and this runbook does not re-test it by hammering the provider.

**What is verified (deterministic, mocked — no quota spent):**

- The gateway captures the provider's `Retry-After`/reset metadata and, when
  the window is short (≤ 3 s), retries in-request with bounded attempts
  (max 3) and jittered backoff — recovering a transient 429 without the user
  ever seeing an error (`test/chat-api.test.ts` "recovery", `test/agent/agent.test.ts`
  retry suite).
- Retries fire **only** for certainly-unprocessed failures (429s and
  connection-level blips) — timeouts/5xx are never retried, so tokens are
  never double-spent and tool calls are never duplicated.
- A longer provider window is **respected, not stormed**: no retry inside the
  request; the user gets `429 provider_rate_limited` with `retry_after_seconds`
  (and a `Retry-After` header), the chat banner says "You can retry in about
  N s", and "Retry last message" re-sends exactly the failed turn.
- Provider availability is **not** gateway health: the topbar stays
  "Connected" during provider rate limits (the pill flips only on real
  connectivity trouble).

Full rationale: `docs/decisions.md` **D35**. The deterministic agent/tool-loop
tests (`test/agent/agent.test.ts`) exercise the *tool loop* with a scripted
model — they are **tests, not the chat flow**, and no mock is ever presented
as a real LLM answer.

## 12. Cleanup (nothing destructive is required)

The demo leaves real orders in the store (that is the point). If a pristine
demo is wanted later, delete orders **in wp-admin** (or via the store REST
API) — never by touching the PVCs. Port-forwards die with their pods:

```bash
pkill -f "port-forward"    # stops the three kubectl forwards
```

**Never required for a demo:** deleting PVCs, dropping databases, revoking
demo keys, or `helm uninstall`. Data-destroying operations (PVC deletion,
`helm uninstall --purge` of the database volume, cluster deletion) are **out of
scope for a demo** and are documented with warnings in
`infra/helm/README.md` "Cleanup (preserves data by default)".
