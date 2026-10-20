#!/usr/bin/env bash
# Validation for the current milestone. Only runs checks backed by tools already installed.
# Usage: npm run check   (or: bash scripts/check.sh)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Toolchain"
node --version
npm --version
git --version

echo
echo "==> Workspace dependency tree"
npm ls --workspaces --depth 0 >/dev/null
echo "all workspaces resolve OK"

echo
echo "==> Typecheck (workspaces that define a typecheck script)"
npm run typecheck

echo
echo "==> Build (workspaces that define a build script)"
npm run build

echo
echo "==> Tests (workspaces that define a test script)"
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  echo "TEST_DATABASE_URL is set - the gateway PostgreSQL integration suite WILL RUN"
else
  echo "TEST_DATABASE_URL is unset - gateway PostgreSQL integration tests skip with a printed reason"
fi
npm run test

echo
echo "==> Import smoke test for @mcp/shared"
node -e "import('./packages/shared/dist/index.js').then(m => { if (m.WOOCOMMERCE_TOOLS.length !== 5) { throw new Error('unexpected tool list'); } console.log('shared package imports OK:', m.WOOCOMMERCE_TOOLS.join(', ')); })"

echo
echo "==> npm audit (advisory data requires network; failure is reported, not fatal)"
npm audit --audit-level=high || echo "WARN: npm audit reported issues (or network unavailable) - review manually"

echo
echo "All required checks passed."
