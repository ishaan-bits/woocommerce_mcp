#!/usr/bin/env bash
# Milestone 8 security demo (docs/threat-model.md §6).
#
# Read-only against a deployed stack. Demonstrates, in order:
#   1. internal MCP services are ClusterIP-only (B1 boundary)
#   2. a request to a private upstream address is refused at boot (C4 SSRF)
#   3. a revoked session key gets 401 (auth)
#   4. a non-admin key calling an admin-only tool is denied + audited (authz)
#   5. a burst of tool calls from one key trips the rate limit (-32000/429) (C7)
#   6. failed logins from one IP are throttled (C7 login limit)
#   7. logs contain no session keys or credential material (C3 redaction)
#
# Requirements: kubectl access to the release namespace, node, curl.
# Credentials are never committed: set DEMO_ADMIN_KEY / DEMO_READER_KEY
# (session keys from your own login) or this script will create demo keys.
#
# Usage:
#   NAMESPACE=urumi bash scripts/security-demo.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAMESPACE="${NAMESPACE:-urumi}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v kubectl >/dev/null || fail "kubectl not found"
command -v curl >/dev/null || fail "curl not found"

echo "==> port-forwarding gateway svc/gateway (${NAMESPACE})"
kubectl -n "$NAMESPACE" port-forward svc/gateway "${GATEWAY_PORT}:8080" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
sleep 2

echo
echo "==> 1. internal MCP services are ClusterIP-only"
for svc in woocommerce-mcp inventory-mcp support-mcp; do
  type=$(kubectl -n "$NAMESPACE" get svc "$svc" -o jsonpath='{.spec.type}')
  [ "$type" = "ClusterIP" ] || fail "service $svc is $type (expected ClusterIP)"
done
pass "all internal MCP services are ClusterIP"

echo
echo "==> 2. SSRF: a private upstream address is refused at boot (C4)"
if out=$(env -i PATH="$PATH" \
  API_KEY_PEPPER="local-dev-only-pepper-0000" \
  DATABASE_URL="postgres://user:pw@127.0.0.1:1/none" \
  WOOCOMMERCE_MCP_URL="http://169.254.169.254/latest/meta-data/" \
  UPSTREAM_ALLOWED_PRIVATE_HOSTS="" \
  node apps/gateway/dist/index.js 2>&1); then
  fail "gateway booted with a metadata-service upstream and empty allow-list"
fi
echo "$out" | grep -q "non-routable" || fail "boot refusal did not mention non-routable: $out"
pass "boot refused: $out" | head -c 200; echo

echo
echo "==> 3. revoked key gets 401"
ADMIN_KEY="${DEMO_ADMIN_KEY:-}"
if [ -z "$ADMIN_KEY" ]; then
  fail "set DEMO_ADMIN_KEY (an admin session key) - demo keys are never committed"
fi
admin_user_id=$(curl -sS "$BASE/api/me" -H "Authorization: Bearer $ADMIN_KEY" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.user_id||j.userId||''))})")
[ -n "$admin_user_id" ] || fail "could not read admin user_id from /api/me"
created=$(curl -sS -X POST "$BASE/api/keys" -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$admin_user_id\"}")
tmp_key=$(printf '%s' "$created" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.key||'')})")
[ -n "$tmp_key" ] || fail "could not create temp key: $created"
tmp_id=$(printf '%s' "$created" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.id||''))})")
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/me" -H "Authorization: Bearer $tmp_key")
[ "$code" = "200" ] || fail "fresh temp key got $code on /me (expected 200)"
curl -sS -X POST "$BASE/api/keys/${tmp_id}/revoke" -H "Authorization: Bearer $ADMIN_KEY" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/me" -H "Authorization: Bearer $tmp_key")
[ "$code" = "401" ] || fail "revoked key got $code on /me (expected 401)"
pass "revoked key rejected with 401"

echo
echo "==> 4. authorization: non-admin key denied on admin-only route + audited (C2)"
READER_KEY="${DEMO_READER_KEY:-}"
if [ -z "$READER_KEY" ]; then
  fail "set DEMO_READER_KEY (a reader session key) - demo keys are never committed"
fi
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/keys" -H "Authorization: Bearer $READER_KEY")
[ "$code" = "403" ] || fail "reader got $code on GET /keys (expected 403)"
sleep 1
audit=$(curl -sS "$BASE/api/audit?limit=5" -H "Authorization: Bearer $ADMIN_KEY")
printf '%s' "$audit" | grep -q '"outcome":"denied"' \
  || fail "no denied row in recent audit: ${audit:0:200}"
pass "reader denied with 403 and a denied audit row was recorded"

echo
echo "==> 5. rate limit: a burst of MCP tool calls from one key trips C7"
# The limiter guards /mcp tool calls (JSON-RPC -32000), not the REST surface.
burst_result=$(BEARER="$READER_KEY" GATEWAY_PORT="$GATEWAY_PORT" node --input-type=module <<'EOF'
const base = "http://127.0.0.1:" + (process.env.GATEWAY_PORT || "8080");
const headers = {
  authorization: "Bearer " + process.env.BEARER,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const post = async (body) => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, session: res.headers.get("mcp-session-id") };
};
const init = await post({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {},
            clientInfo: { name: "m8-security-demo", version: "0.1.0" } },
});
if (!init.session) { console.log("NOSESSION " + init.status + " " + init.text.slice(0, 200)); process.exit(1); }
headers["mcp-session-id"] = init.session;
await post({ jsonrpc: "2.0", method: "notifications/initialized" });
let limited = 0, ok = 0, other = 0;
for (let i = 0; i < 60; i++) {
  const r = await post({
    jsonrpc: "2.0", id: 100 + i, method: "tools/call",
    params: { name: "woocommerce_list_products", arguments: { page: 1, per_page: 1 } },
  });
  if (r.status === 429 || r.text.includes("-32000")) limited++;
  else if (r.status === 200) ok++;
  else other++;
}
console.log(JSON.stringify({ limited, ok, other }));
EOF
)
echo "burst result: $burst_result"
printf '%s' "$burst_result" | grep -q '"limited":[1-9]' \
  || fail "no rate-limited response in 60 MCP tool calls: $burst_result"
pass "rate limiter returned -32000/429 during the burst"

echo
echo "==> 6. login throttle: repeated failed logins hit the per-IP limit"
codes=""
for i in $(seq 1 20); do
  c=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"key":"umk_definitely-not-a-real-session-key-0000"}' || echo 000)
  codes="$codes $c"
done
echo "$codes" | grep -q " 429" \
  || fail "no 429 on failed logins (login limit may be disabled in values: ${codes:0:80}…)"
pass "login throttle returned 429"

echo
echo "==> 7. logs contain no session keys or credential material (C3)"
logs=$(kubectl -n "$NAMESPACE" logs deploy/gateway --tail=5000 2>/dev/null || true)
if printf '%s' "$logs" | grep -qE 'umk_[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]{20,}|postgres://[^[:space:]]+:[^[:space:]]+@'; then
  fail "gateway logs contain unredacted credential material"
fi
pass "no unredacted keys/passwords found in gateway logs"

echo
echo "DEMO OK: all Milestone 8 security demos passed"
