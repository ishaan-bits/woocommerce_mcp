#!/usr/bin/env bash
# Milestone 8 (threat-model C8 / B1): chart regression assertions.
#
# Renders both value files and fails if any of these security properties
# regress:
#   1. an internal MCP service becomes reachable outside the cluster
#      (type must stay ClusterIP)
#   2. a workload loses its ServiceAccount or re-enables token automount
#   3. the production render contains any chart-supplied Secret
#   4. the production render contains a credential-looking literal
#      (local values intentionally carry `local-dev-only-…` placeholders)
#   5. the gateway loses its SSRF allow-list or its pod-level security context
#   6. the chat-agent key (GROQ_API_KEY) is not optional-secret-sourced, or
#      any render contains a literal Groq-looking key (Milestone 9 / D29/L4)
#   7. the WordPress store (Milestone 10 Phase C): the real-store workloads
#      stay ClusterIP-only, every WORDPRESS_*_PASSWORD arrives via
#      secretKeyRef (never a literal or ConfigMap value), and the gateway's
#      WOOCOMMERCE_STORE_MODE label always agrees with the backing store the
#      woocommerce MCP was actually pointed at (no silent mock/real drift).
#
# Usage: scripts/security/assert-helm-security.sh   (from the repo root)
set -euo pipefail

cd "$(dirname "$0")/../.."

CHART=infra/helm/mcp-gateway
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "ASSERT FAILED: $*" >&2
  exit 1
}

helm template urumi "$CHART" -f "$CHART/values-local.yaml" >"$WORKDIR/local.yaml"
helm template urumi "$CHART" -f "$CHART/values-prod.yaml" >"$WORKDIR/prod.yaml"

echo "==> 1. internal MCP services stay ClusterIP (both renders)"
for name in woocommerce-mcp inventory-mcp support-mcp wordpress wordpress-db; do
  for render in local prod; do
    type=$(awk -v n="$name" '
      /^kind: / { kind=$2; name=""; type="" }
      kind == "Service" && $1 == "name:" { name=$2 }
      kind == "Service" && $1 == "type:" { type=$2 }
      kind == "Service" && name == n && type != "" { print type; exit }
    ' "$WORKDIR/$render.yaml")
    [ "$type" = "ClusterIP" ] || fail "$render render: service $name has type '$type'"
  done
done

echo "==> 2. every rendered workload has a ServiceAccount with automountServiceAccountToken: false"
for render in local prod; do
  # Every ServiceAccount in the render must disable token automount, and every
  # one must be referenced by a workload. (bash 3.2-compatible: no mapfile.)
  count=0
  while IFS= read -r entry; do
    count=$((count + 1))
    sa="${entry%%:*}"
    auto="${entry##*:}"
    [ "$auto" = "false" ] || fail "$render render: ServiceAccount $sa has automountServiceAccountToken=$auto"
    grep -q "serviceAccountName: $sa$" "$WORKDIR/$render.yaml" \
      || fail "$render render: no workload references serviceAccountName: $sa"
  done < <(awk '
    $0 == "kind: ServiceAccount" { inblock=1; name=""; auto="" }
    inblock && $1 == "name:" { name=$2 }
    inblock && $1 == "automountServiceAccountToken:" { auto=$2 }
    inblock && $0 == "---" { if (name != "") print name ":" auto; inblock=0 }
    END { if (inblock && name != "") print name ":" auto }
  ' "$WORKDIR/$render.yaml")
  [ "$count" -ge 5 ] || fail "$render render: expected at least 5 ServiceAccounts, found $count"
done

echo "==> 3. production render ships no Secret resource"
if grep -q "^kind: Secret$" "$WORKDIR/prod.yaml"; then
  fail "prod render contains a Secret (must come from secrets.existingSecret)"
fi

echo "==> 4. production render contains no credential-looking literals"
if grep -nE "local-dev-only-|umk_[A-Za-z0-9_-]{10,}|ck_[A-Za-z0-9]{10,}|cs_[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}" "$WORKDIR/prod.yaml"; then
  fail "prod render contains credential-looking material"
fi

echo "==> 5. gateway keeps its SSRF allow-list and pod security context"
for render in local prod; do
  grep -q 'UPSTREAM_ALLOWED_PRIVATE_HOSTS: "woocommerce-mcp,inventory-mcp,support-mcp"' \
    "$WORKDIR/$render.yaml" || fail "$render render: gateway SSRF allow-list missing or unexpected"
  grep -q 'runAsNonRoot: true' "$WORKDIR/$render.yaml" || fail "$render render: runAsNonRoot missing"
done

echo "==> 6. chat-agent key wiring stays optional and secret-sourced (M9 / D29 / L4)"
# local render: the chart-created Secret is <release>-secrets; prod points at
# the operator-supplied existingSecret. Either way the key must arrive as an
# OPTIONAL secretKeyRef — never a literal, never a ConfigMap value.
for render in local prod; do
  grep -qE 'gsk_[A-Za-z0-9]{10,}' "$WORKDIR/$render.yaml" \
    && fail "$render render contains a credential-looking GROQ key literal"
  ref=$(grep -A6 'name: GROQ_API_KEY' "$WORKDIR/$render.yaml" || true)
  [ -n "$ref" ] || fail "$render render: gateway lost its GROQ_API_KEY env entry"
  echo "$ref" | grep -q 'optional: true' \
    || fail "$render render: GROQ_API_KEY secretKeyRef must be optional: true"
  echo "$ref" | grep -q 'secretKeyRef:' \
    || fail "$render render: GROQ_API_KEY must come from a secretKeyRef"
  echo "$ref" | grep -q 'key: GROQ_API_KEY' \
    || fail "$render render: GROQ_API_KEY must read the GROQ_API_KEY secret key"
  grep -q 'GROQ_MODEL: "openai/gpt-oss-120b"' "$WORKDIR/$render.yaml" \
    || fail "$render render: GROQ_MODEL missing from gateway ConfigMap"
  grep -q 'LLM_REQUEST_TIMEOUT_MS: "45000"' "$WORKDIR/$render.yaml" \
    || fail "$render render: LLM_REQUEST_TIMEOUT_MS missing from gateway ConfigMap"
  if echo "$ref" | grep -q 'GROQ_API_KEY' && grep -q '^kind: ConfigMap' "$WORKDIR/$render.yaml"; then
    # The ConfigMap must never carry the key itself.
    awk '/^kind: ConfigMap$/,/^---$/' "$WORKDIR/$render.yaml" | grep -q 'GROQ_API_KEY:' \
      && fail "$render render: GROQ_API_KEY leaked into the gateway ConfigMap"
  fi
done

echo "==> 7. WordPress store: secret-sourced passwords + store-mode agreement (M10 / Phase C)"
for render in local prod; do
  for key in WORDPRESS_DB_PASSWORD WORDPRESS_DB_ROOT_PASSWORD WORDPRESS_ADMIN_PASSWORD; do
    # Every workload env entry for the key must be a secretKeyRef (the line
    # after "- name: KEY" carries valueFrom, never a plain value).
    awk -v k="$key" '
      $1 == "-" && $2 == "name:" && $3 == k { getline; if ($1 != "valueFrom:") { print "literal:" $0; exit 1 } }
    ' "$WORKDIR/$render.yaml" || fail "$render render: $key set as a literal env value"
    # The key must never appear as a ConfigMap value (credentials in a
    # ConfigMap are world-readable inside the namespace).
    awk '/^kind: ConfigMap$/{inmap=1} /^---$/{inmap=0} inmap && $0 ~ /^[ \t]*'"$key"':[ \t]/ {found=1} END{exit !found}' "$WORKDIR/$render.yaml" \
      && fail "$render render: $key leaked into a ConfigMap"
    # At least one legitimate secretKeyRef must remain for the key.
    grep -q "key: $key$" "$WORKDIR/$render.yaml" || fail "$render render: $key lost its secretKeyRef"
  done
  # Store-mode label must agree with the URL the woocommerce MCP actually
  # fetches: a mock URL with a "real" label (or vice versa) is a lie to the
  # dashboard and a regression of the "label at deploy time" contract.
  mode=$(grep 'WOOCOMMERCE_STORE_MODE:' "$WORKDIR/$render.yaml" | head -1 | sed 's/.*: *"\(.*\)"/\1/')
  url=$(grep 'WOOCOMMERCE_STORE_URL:' "$WORKDIR/$render.yaml" | head -1 | sed 's/.*: *"\(.*\)"/\1/')
  [ -n "$mode" ] || fail "$render render: gateway lost WOOCOMMERCE_STORE_MODE"
  [ -n "$url" ] || fail "$render render: woocommerce MCP lost WOOCOMMERCE_STORE_URL"
  case "$url" in
    *woocommerce-store-mock*) want="mock" ;;
    *) want="real" ;;
  esac
  [ "$mode" = "$want" ] || fail "$render render: store mode '$mode' disagrees with store URL '$url' (expected '$want')"
done

echo "ASSERT OK: helm security assertions passed (local + prod renders)"
