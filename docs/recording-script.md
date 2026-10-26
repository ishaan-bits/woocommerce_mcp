# Demo recording script — 5–7 minute walkthrough (outline only)

A rehearsal outline for the assignment demo video. **No video is recorded or
faked here** — you film it. Every claim below is either locally verified (see
[docs/demo-runbook.md](./demo-runbook.md) evidence statuses) or explicitly
labelled as limitation. If a live step fails while recording, say so on camera
and fall back to the runbook evidence — never improvise a success.

## Before you record (5-minute setup)

```bash
colima start                                   # if the VM is down
kubectl -n urumi get pods                      # expect 9/9 Running
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
echo "127.0.0.1 dashboard.urumi.test shop.urumi.test" | sudo tee -a /etc/hosts
# load demo keys into the shell WITHOUT printing them:
USER_A_KEY=$(python3 -c "import json;print(json.load(open('.tmp/demo-keys.json'))['admin']['key'])")
USER_B_KEY=$(python3 -c "import json;print(json.load(open('.tmp/demo-keys.json'))['reader']['key'])")
```

Pre-open two browser tabs: `http://dashboard.urumi.test:18080` and
`http://shop.urumi.test:18080`. Close any tab showing cookies/devtools headers.

## Pre-recording checklist (5 minutes)

- [ ] `kubectl -n urumi get pods` → 9/9 `1/1`
- [ ] Ingress: `http://dashboard.urumi.test:18080` and `http://shop.urumi.test:18080` open
- [ ] Dashboard loads; sign-in works with the key from `.tmp/demo-keys.json`
- [ ] Storefront `/shop/` shows products
- [ ] Upstreams page: 3 servers healthy (Refresh re-probes live)
- [ ] Persistent data: a couple of orders visible (WooCommerce → Orders)
- [ ] Browser console clean (no errors on load)
- [ ] **Local model check (if you will demo chat):** `ollama serve` running,
      `ollama list` shows `qwen2.5:3b`, and one chat message answers
- [ ] No secrets visible in any open window/terminal
- [ ] `bash scripts/scale-drill.sh` optional pre-run (self-restoring)

## Do-not-show checklist (every frame)

- No API keys (`umk_…`), passwords, WooCommerce `ck_/cs_…`, `Authorization`
  headers, cookies, or `urumi-secrets` values — not in terminal, not in browser
  autofill, not in screenshots.
- Paste keys only via the sign-in box (the field masks nothing — type fast and
  click Sign in; never `cat` a key file on camera).
- Keep `kubectl get secret … -o yaml` **off camera** entirely.

---

## The 7-minute outline

### 0:00–0:40 — What this is (beat 1)
- **Screen:** dashboard `#/overview` (signed in as **admin-demo**).
- **Say:** "One authenticated MCP gateway in front of a real WooCommerce store
  and two more backends. AI clients — this chat, IDEs, MCP Inspector — call
  tools through one endpoint; the gateway enforces identity, permissions and
  auditability."

### 0:40–1:30 — Architecture, Kubernetes, healthy upstreams (beats 1–2)
- **Screen:** `#/upstreams` (3 servers, live Refresh) + terminal
  `kubectl get pods,pvc -n urumi` (9/9, 3 Bound PVCs).
- **Say:** "Nine workloads, one Helm chart, probes and limits everywhere; three
  PVCs hold the data. Local and production differ only by values files."

### 1:30–2:30 — Product listing: accurate IDs and pagination (beat 3)
- **Screen:** Chat → ask *"List the products in the store and show each
  product's actual ID, name, and price, plus the pagination facts."*
- **Do:** point at the answer — one **real id per product** (21, 20, 13, 12,
  11, 10, …), real prices, and the store's own `Total products: N · More
  pages: No` line (7 products as of 2026-10-26) — the tool result carries
  explicit `total_products`/`total_pages`/`has_more` from the store's API
  metadata (no invented ranges or pages).

### 2:30–3:15 — External MCP client + discovery (beat 7)
- **Screen:** MCP Inspector (or the SDK test output) with **user B's** key.
- **Do:** `tools/list` → exactly the 5 tools the member may call (writes are
  hidden and rejected). **Say:** "One URL and a member key — tools from every
  enabled server, permission-filtered at discovery."

### 3:15–4:00 — Cross-upstream workflow (beat 8)
- **Screen:** Chat → *"Report separately: two store products (IDs, prices) and
  two inventory items (SKUs, quantities) — label which system each fact is
  from."*
- **Do:** show the two tool chips (`woocommerce_list_products` +
  `inventory_list_products`) and the labelled, accurate combined answer.

### 4:00–4:45 — Product creation through chat (beats 4–5)
- **Screen:** Chat → *"Create a product named … (unique SKU)"* → chip
  `woocommerce_create_product` → storefront `/shop/` shows it.
- **Say:** "Same tool loop, same authorization and audit — the product is real."

### 4:45–5:30 — Order retrieval + permissions/revocation (beats 6, 9)
- **Screen:** Chat *"Which orders came in on <date>?"* → order number + total +
  timestamp. Then **Team**: issue a **disposable** key, show a member call
  working, **Revoke** it, next call → 401. Also show a write tool **denied**
  for the member (Tools page badge + `-32003`).

### 5:30–6:30 — Audit, failure isolation, cluster (beat 10)
- **Screen:** **Audit** page — filter `tool_call`: every row attributed
  (user/server/tool/time/duration/outcome). Optional 30s: `bash
  scripts/scale-drill.sh` (PASS + auto-restore) or the disable-upstream toggle
  (tools 9→7→9). Terminal: `kubectl get pvc` — data intact.

### 6:30–7:15 — Local LLM status + honest limitations (beat 11)
- **Screen:** a chat reply showing **"Using local model qwen2.5:3b"** (or the
  Settings/`/api/settings` fallback line) + the audit rows behind it.
- **Say:** "Free-tier Groq quota is intermittent — when it 429s, the local
  Ollama model answers through the identical gateway tool loop, and the reply
  names the provider. No API key for local inference; production never needs
  it. Remaining limits: no public VPS (documented only), no OAuth."
- **If short on time:** skip the scale-drill demo (beat 10's optional part)
  and the cross-upstream deep-dive — the mandatory DoD beats are 3–6 and 9–10.

## Truthful limitations (state these if asked, or in the closing slide)

1. **No public deployment exists.** Everything shown runs on a local kind
   cluster; the k3s/VPS story is documented, not deployed.
2. **Chat LLM turns are quota-blocked** (Groq free tier, real HTTP 429s). The
   bounded retry/`Retry-After`/safe-retry behavior is verified with mocks
   (decisions D35); deterministic agent tests exercise the tool loop but are
   **tests, not the chat flow** — never presented as live model answers.
3. Frontend **WooCommerce admin password** and all keys live in cluster Secrets
   / an ignored local file — never recorded.
4. The store intentionally accumulates demo orders; cleanup is documented and
   **never touches PVCs** (runbook §12).
