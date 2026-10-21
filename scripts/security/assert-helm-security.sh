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
for name in woocommerce-mcp inventory-mcp support-mcp; do
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
if grep -nE "local-dev-only-|umk_[A-Za-z0-9_-]{10,}|ck_[A-Za-z0-9]{10,}|cs_[A-Za-z0-9]{10,}" "$WORKDIR/prod.yaml"; then
  fail "prod render contains credential-looking material"
fi

echo "==> 5. gateway keeps its SSRF allow-list and pod security context"
for render in local prod; do
  grep -q 'UPSTREAM_ALLOWED_PRIVATE_HOSTS: "woocommerce-mcp,inventory-mcp,support-mcp"' \
    "$WORKDIR/$render.yaml" || fail "$render render: gateway SSRF allow-list missing or unexpected"
  grep -q 'runAsNonRoot: true' "$WORKDIR/$render.yaml" || fail "$render render: runAsNonRoot missing"
done

echo "ASSERT OK: helm security assertions passed (local + prod renders)"
