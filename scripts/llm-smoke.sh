#!/usr/bin/env bash
# Milestone 9 — OPT-IN live LLM smoke test (D29). Never part of check.sh.
#
# Skips cleanly (exit 0) when GROQ_API_KEY is unset — the automated suite
# never needs a provider. When run for real it sends ONE chat request through
# a deployed gateway and checks the HTTP shape only. Free-tier rate limits
# apply; see README "Free-tier limitations".
#
# Usage:
#   GROQ_API_KEY=gsk_... GATEWAY_URL=http://127.0.0.1:8080 \
#   GATEWAY_API_KEY=umk_... bash scripts/llm-smoke.sh
set -euo pipefail

if [ -z "${GROQ_API_KEY:-}" ]; then
  echo "SKIPPED: GROQ_API_KEY is not set - no live provider call performed."
  exit 0
fi
if [ -z "${GATEWAY_URL:-}" ]; then
  echo "SKIPPED: GATEWAY_URL is not set (e.g. http://127.0.0.1:8080 via port-forward)." >&2
  exit 0
fi
if [ -z "${GATEWAY_API_KEY:-}" ]; then
  echo "SKIPPED: GATEWAY_API_KEY is not set (an API key for the deployed gateway)." >&2
  exit 0
fi

echo "==> live chat via ${GATEWAY_URL}/api/chat (one request, real provider)"
body=$(curl -sS -X POST "${GATEWAY_URL}/api/chat" \
  -H "authorization: Bearer ${GATEWAY_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"message":"Reply with exactly: smoke-ok","history":[]}' \
  -w '\n%{http_code}')

code=$(printf '%s' "$body" | tail -n1)
json=$(printf '%s' "$body" | sed '$d')

echo "HTTP ${code}"
echo "$json" | head -c 400; echo

if [ "$code" != "200" ]; then
  echo "FAIL: expected HTTP 200 from a configured gateway+provider (got ${code})." >&2
  exit 1
fi
echo "$json" | grep -q '"reply"' || { echo "FAIL: response has no reply field." >&2; exit 1; }
echo "LIVE SMOKE OK: a real provider round-trip completed. (Key never printed.)"
