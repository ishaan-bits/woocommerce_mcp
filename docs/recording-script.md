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

### 0:00–0:40 — What this is
- **Screen:** dashboard `#/overview` (signed in as **admin-demo**).
- **Say:** "One authenticated MCP gateway in front of a real WooCommerce store
  and two more backends. AI clients — this chat, IDEs, MCP Inspector — call
  tools through one endpoint; the gateway enforces identity, permissions and
  auditability."
- **Do:** point at the topbar connection pill (green = gateway connectivity).

### 0:40–1:30 — Architecture & Kubernetes
- **Screen:** dashboard `#/upstreams` (3 upstreams with status) + one terminal
  `kubectl get pods,pvc -n urumi`.
- **Say:** "Nine workloads on one kind cluster via a single Helm chart —
  gateway, dashboard, three MCP servers, PostgreSQL and WordPress/WooCommerce,
  each with probes and resource limits; three PVCs hold the data. Local and
  production differ only by values files."
- **Do:** show `values-local.yaml` vs `values-prod.yaml` names only (no secret
  contents).

### 1:30–2:30 — MCP internals (discovery, routing, collisions)
- **Screen:** `#/tools` catalogue, then the **chat** or MCP Inspector.
- **Do (live):** ask: *"compare my products with inventory stock"* — one
  question, tools from **two upstreams** (`woocommerce_list_products` +
  `inventory_list_products`), chips under the answer.
- **Say:** "Tools are aggregated under qualified names `<upstream>_<tool>` —
  two servers can expose `list_products` without colliding. Calls route to the
  right server; a slow or dead upstream fails alone with a structured error."

### 2:30–3:30 — Security posture (member vs admin)
- **Screen:** new browser profile → sign in as **reader-demo** (`$USER_B_KEY`).
- **Do (live):** on `#/tools`, open a write tool — the indicator says
  **denied**. Try the same call via MCP Inspector/curl → `-32003 role 'reader'
  may not call write tool`. Then show reader's Settings → "Your API keys"
  (their own keys only) and that **Team** is hidden.
- **Say:** "Roles are enforced server-side with no admin bypass; keys are
  stored hashed; upstream credentials never reach the browser. Tool calls are
  signed as *you* — one audit row each."

### 3:30–4:30 — Definition of done: buy something
- **Screen:** storefront tab (👤 **MANUAL** browser steps — runbook T1/T2).
- **Do:** shop → product → Add to cart → Checkout → Cash on delivery → Place
  order (order number on screen). Then `shop.urumi.test:18080/wp-login.php` →
  WooCommerce → Orders shows the order (**keep the password field off camera**).
- **Say:** "The store is real WordPress/WooCommerce in the same cluster — the
  order lands in admin immediately, and `woocommerce_list_orders` through the
  gateway returns it too."
- **Fallback:** if the browser hiccups, show the pre-verified result in
  `docs/demo-runbook.md` T1/T2 and say the step is script-verified
  (`scripts/demo/storefront-checkout.cjs`).

### 4:30–5:45 — Control plane: keys, upstreams, failure isolation, audit
- **Screen:** dashboard as **admin-demo**.
- **Do (live, in order):**
  1. Team → issue a key for reader-demo, then **Revoke** it (show the audit row
     appear — don't reuse it afterwards).
  2. Upstreams → **disable** `inventory` → `#/tools` loses `inventory_*`
     (9→7 tools) → re-enable (back to 9).
  3. Terminal: `kubectl -n urumi scale deploy/inventory-mcp --replicas=0` →
     call `inventory_list_products` (structured "unreachable") while
     `woocommerce_list_products` still works; show `/api/upstreams` degraded
     badge → `--replicas=1` restore.
  4. Audit page: every action attributed to the right user.
- **Say:** "Revoke takes effect on the next call. Disabling or killing an
  upstream isolates it — siblings keep serving — and the dashboard shows why."

### 5:45–6:45 — Chat agent with the tool loop (verified working)
- **Screen:** Chat as admin.
- **Do (live):** ask *"List my products."* — watch the tool chip
  (`woocommerce_list_products`) and the grounded answer. The reply shows which
  model answered ("via groq:…" or **"Using local model qwen2.5:3b"** when the
  free-tier quota is exhausted — the local Ollama fallback runs the exact same
  gateway tool loop).
- **Do (optional):** *"Create a product named …"* → the chip shows
  `woocommerce_create_product` → open the storefront to see it.
- **Say:** "One tool loop for every model — hosted or local, tool calls go
  through the same gateway authorization and audit as everything else. If the
  free tier 429s, the local model answers instead; the response says which
  provider produced it."
- **Never:** fake an LLM response; if both providers fail, show the honest
  banner (names both, keeps the turn's tool chips, safe Retry).

### 6:30–7:00 — Production story + wrap
- **Screen:** `infra/helm/README.md` "Deploying to a future VPS" heading.
- **Do (optional, 30s):** terminal `bash scripts/scale-drill.sh` — it prints
  PASS lines (2 replicas, per-replica upstreams, one MCP session across
  requests) and restores the original replica count automatically.
- **Say:** "Local and VPS differ only through Helm values — real DNS, TLS at
  the ingress, operator-managed Secrets, storage class, 2 gateway replicas
  (this drill proves sessions and upstreams survive multi-replica). The VPS
  path is documented but not executed — nothing public is claimed.
  Everything is free-tier tooling; total cost zero."
- **Do:** end on the dashboard overview.

---

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
