#!/usr/bin/env bash
# ============================================================================
# scripts/scale-drill.sh — stand-out 7 (Scaling) reproducible verification.
#
# Runs the documented multi-replica gateway drill safely:
#   1. preconditions (tools, cluster, release, session-affinity setting)
#   2. scale the gateway to 2 replicas (existing kubectl mechanism)
#   3. both replicas ready
#   4. EACH replica independently reaches every configured upstream
#   5. a real MCP session (initialize -> tools/list -> tools/call ->
#      tools/list) works through the Service while 2 replicas run
#   6. restore the original replica count — even if a check fails (trap)
#
# Honesty notes (read the output carefully):
#   - Check 2 is "per-replica upstream reachability", NOT a session test.
#   - Check 3 proves SESSION CONTINUITY under multi-replica operation with
#     the chart's `sessionAffinity: ClientIP` (an MCP session is pinned to
#     its own pod BY DESIGN — MCP transports are in-memory per pod, D37).
#     It is NOT a cross-replica session-migration test; in-memory sessions
#     cannot migrate and that is the documented architecture.
#
# Safety: restores replica count via trap; never touches PVCs, databases,
# Secrets, or data; never prints API keys/credentials (a key is read from
# $GATEWAY_API_KEY or the git-ignored .tmp/demo-keys.json into memory only).
#
# Usage:   bash scripts/scale-drill.sh
# Labels:  PASS / FAIL / BLOCKED
# ============================================================================
set -u

NS="${NS:-urumi}"
RELEASE="${RELEASE:-urumi}"
DEPLOY="deploy/gateway"
SVC="svc/gateway"
MCP_PORT="${MCP_PORT:-}"        # empty = pick a free local port at runtime
TARGET_REPLICAS=2
PF_PID=""
FAILED=0
BLOCKED=0
RESTORE_DONE=0

say()  { printf '%s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILED=1; }
blocked() { printf 'BLOCKED: %s\n' "$*"; BLOCKED=1; }

# Cleanup: restore the original replica count and kill the port-forward,
# even when a check fails or the script is interrupted.
restore() {
  [ "$RESTORE_DONE" = "1" ] && return
  RESTORE_DONE=1
  if [ -n "$PF_PID" ] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null
  fi
  if [ -n "${ORIGINAL_REPLICAS:-}" ]; then
    say ""
    say "== restore: gateway replicas -> ${ORIGINAL_REPLICAS} =="
    kubectl -n "$NS" scale "$DEPLOY" --replicas="$ORIGINAL_REPLICAS" >/dev/null 2>&1
    if kubectl -n "$NS" rollout status "$DEPLOY" --timeout=120s >/dev/null 2>&1; then
      pass "restored ${DEPLOY} to ${ORIGINAL_REPLICAS} replica(s)"
    else
      fail "could not confirm restore to ${ORIGINAL_REPLICAS} replica(s) — check: kubectl -n $NS get pods"
    fi
  fi
}
trap restore EXIT INT TERM

# ---------------------------------------------------------------------------
say "== 0. preconditions =="
for tool in kubectl python3; do
  command -v "$tool" >/dev/null 2>&1 || { fail "required tool missing: $tool"; exit 1; }
done
pass "required tools present (kubectl, python3)"

kubectl get --raw=/readyz >/dev/null 2>&1 || { fail "cluster API not reachable"; exit 1; }
pass "cluster API reachable (context: $(kubectl config current-context 2>/dev/null))"

kubectl -n "$NS" get "$DEPLOY" >/dev/null 2>&1 || { fail "deployment $DEPLOY not found in namespace $NS"; exit 1; }
if helm status "$RELEASE" -n "$NS" >/dev/null 2>&1; then
  pass "Helm release '$RELEASE' present in namespace '$NS'"
else
  fail "Helm release '$RELEASE' not found in namespace '$NS'"
fi

AFFINITY=$(kubectl -n "$NS" get "$SVC" -o jsonpath='{.spec.sessionAffinity}' 2>/dev/null)
if [ "$AFFINITY" = "ClientIP" ]; then
  pass "Service sessionAffinity=$AFFINITY (MCP sessions are per-pod in-memory; sticky routing is required for replicas > 1)"
else
  fail "Service sessionAffinity is '$AFFINITY' (expected ClientIP) — multi-replica MCP sessions would break"
fi

ORIGINAL_REPLICAS=$(kubectl -n "$NS" get "$DEPLOY" -o jsonpath='{.spec.replicas}')
say "original gateway replicas: ${ORIGINAL_REPLICAS} (restored at the end)"

# MCP credential: env first, then the git-ignored demo keys file. Never printed.
KEY_SOURCE=""
if [ -n "${GATEWAY_API_KEY:-}" ]; then
  KEY_SOURCE="GATEWAY_API_KEY environment variable"
elif [ -f ".tmp/demo-keys.json" ]; then
  GATEWAY_API_KEY=$(python3 -c "import json;print(json.load(open('.tmp/demo-keys.json'))['admin']['key'])") || GATEWAY_API_KEY=""
  [ -n "$GATEWAY_API_KEY" ] && KEY_SOURCE=".tmp/demo-keys.json (admin entry, git-ignored)"
fi
if [ -n "${GATEWAY_API_KEY:-}" ]; then
  export GATEWAY_API_KEY
  pass "MCP credential available in memory only ($KEY_SOURCE)"
else
  blocked "no MCP credential (set GATEWAY_API_KEY or provide .tmp/demo-keys.json) — MCP session checks will be skipped"
fi

# ---------------------------------------------------------------------------
say ""
say "== 1. scale gateway to ${TARGET_REPLICAS} replicas =="
kubectl -n "$NS" scale "$DEPLOY" --replicas="$TARGET_REPLICAS" >/dev/null 2>&1 || { fail "scale command failed"; exit 1; }
if kubectl -n "$NS" rollout status "$DEPLOY" --timeout=180s >/dev/null 2>&1; then
  READY=$(kubectl -n "$NS" get "$DEPLOY" -o jsonpath='{.status.readyReplicas}')
  if [ "$READY" = "$TARGET_REPLICAS" ]; then
    pass "${READY}/${TARGET_REPLICAS} replicas ready"
  else
    fail "readyReplicas=${READY:-0}, expected ${TARGET_REPLICAS}"
  fi
else
  fail "rollout did not complete within 180s"
fi

# ---------------------------------------------------------------------------
say ""
say "== 2. per-replica upstream reachability (each gateway pod queries its own /readyz) =="
say "   (upstream connectivity per replica — this is NOT a session test)"
PODS=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=gateway \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep -v '^$')
for pod in $PODS; do
  RESULT=$(kubectl -n "$NS" exec "$pod" -c gateway -- node -e \
    "fetch('http://127.0.0.1:8080/readyz').then(r=>r.json()).then(d=>console.log(JSON.stringify({s:d.status,u:(d.upstreams||[]).map(x=>x.id+':'+x.reachable)}))).catch(()=>console.log('ERR'))" 2>/dev/null)
  if printf '%s' "$RESULT" | grep -q '"s":"ready"' && ! printf '%s' "$RESULT" | grep -q ':false'; then
    pass "pod $pod: ready, all upstreams reachable -> $RESULT"
  else
    fail "pod $pod: upstream reachability problem -> ${RESULT:-no output}"
  fi
done

# ---------------------------------------------------------------------------
say ""
say "== 3. MCP session continuity with ${TARGET_REPLICAS} replicas (real endpoint through the Service) =="
if [ -z "${GATEWAY_API_KEY:-}" ]; then
  blocked "skipped — no MCP credential available"
else
  # Pick a free local port (never assume one is available) and verify that
  # BOTH the bind succeeded AND the endpoint is really the gateway — a stale
  # port-forward on the chosen port would otherwise answer with a false result.
  if [ -z "${MCP_PORT:-}" ]; then
    MCP_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
  fi
  PF_LOG=$(mktemp)
  kubectl -n "$NS" port-forward "$SVC" "${MCP_PORT}:8080" >"$PF_LOG" 2>&1 &
  PF_PID=$!
  PF_READY=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if grep -q "Forwarding from" "$PF_LOG" 2>/dev/null; then
      PF_READY=1
      break
    fi
    if ! kill -0 "$PF_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  rm -f "$PF_LOG"
  # Identity check: the forwarded endpoint must BE the gateway.
  if [ "$PF_READY" = "1" ]; then
    HEALTH=$(python3 -c "
import urllib.request
try:
    print(urllib.request.urlopen('http://127.0.0.1:${MCP_PORT}/healthz', timeout=5).read().decode().strip())
except Exception as e:
    print('ERR', type(e).__name__)" 2>/dev/null)
    case "$HEALTH" in
      *'"status":"ok"'*) ;;
      *) PF_READY=0; fail "port ${MCP_PORT} answered but is NOT the gateway (/healthz -> ${HEALTH:-nothing}) — refusing to report session results from the wrong endpoint" ;;
    esac
  fi
  if [ "$PF_READY" != "1" ]; then
    [ "${FAILED:-0}" = "0" ] && fail "port-forward to ${SVC} on :${MCP_PORT} never became ready (port busy or forward died)"
  elif python3 - "$MCP_PORT" <<'PYEOF'
import json, os, sys, http.client

port = int(sys.argv[1])
key = os.environ.get("GATEWAY_API_KEY", "")
base = {"content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "authorization": "Bearer " + key}

def rpc(payload, sid=None):
    headers = dict(base)
    if sid:
        headers["mcp-session-id"] = sid
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request("POST", "/mcp", body=json.dumps(payload), headers=headers)
    r = conn.getresponse()
    sid2 = r.getheader("mcp-session-id") or sid
    raw = r.read().decode()
    status = r.status
    body = None
    for line in raw.splitlines():
        if line.startswith("data: "):
            body = json.loads(line[6:])
            break
    if body is None and raw.strip():
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
    conn.close()
    if body is None:
        if status == 202:
            # Notifications (e.g. notifications/initialized) legitimately
            # return 202 Accepted with an empty body — that is spec behaviour.
            return sid2, {"_accepted": True}
        preview = raw.strip()[:60].replace("\n", " ")
        raise RuntimeError(f"empty/unparseable MCP response (HTTP {status}, body starts: {preview!r})")
    return sid2, body

steps = []
sid, init = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                 "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                            "clientInfo": {"name": "scale-drill", "version": "1.0"}}})
steps.append(("initialize", "result" in init and bool(sid)))
rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
_, tools = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
n1 = len(tools.get("result", {}).get("tools", []))
steps.append((f"tools/list -> {n1} tools", n1 > 0))
_, call = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
               "params": {"name": "inventory_list_products", "arguments": {}}}, sid)
ok = "result" in call and call["result"].get("isError") is not True
steps.append(("tools/call inventory_list_products", ok))
_, tools2 = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}}, sid)
n2 = len(tools2.get("result", {}).get("tools", []))
steps.append((f"second tools/list on SAME session -> {n2} tools", n2 == n1 and n2 > 0))

all_ok = all(flag for _, flag in steps)
for label, flag in steps:
    print(("ok   " if flag else "FAIL ") + label)
sys.exit(0 if all_ok else 1)
PYEOF
  then
    pass "MCP session continuity: initialize -> tools/list -> tools/call -> tools/list all succeeded on ONE session while ${TARGET_REPLICAS} replicas ran"
    say "   (sessions are pinned to their pod by ClientIP affinity — the documented design (D37);"
    say "    this is NOT a cross-replica session-migration test)"
  else
    fail "MCP session continuity test failed (see step output above)"
  fi
fi

# ---------------------------------------------------------------------------
say ""
say "== summary =="
if [ "$FAILED" = "0" ] && [ "$BLOCKED" = "0" ]; then
  say "RESULT: PASS — multi-replica gateway verified (per-replica upstreams + MCP session continuity)"
elif [ "$FAILED" = "0" ]; then
  say "RESULT: PASS WITH BLOCKED CHECKS — see BLOCKED lines above"
else
  say "RESULT: FAIL — see FAIL lines above"
fi
exit "$FAILED"
