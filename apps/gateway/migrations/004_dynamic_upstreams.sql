-- Milestone 11 schema (admin-registered dynamic MCP upstreams, D34).
-- Applied by `npm run migrate -w @mcp/gateway` (or the gateway pod's init
-- container); tracked in schema_migrations like every other file here.
--
-- One row per admin-added upstream server: identity + endpoint + enablement
-- and an OPTIONAL static credential stored ONLY as AES-256-GCM ciphertext
-- (iv || auth tag || ciphertext in credential_cipher; the header name and
-- mode are plaintext metadata). The plaintext never reaches this table, a
-- log or an API response — see apps/gateway/src/upstream-credentials.ts.
-- The id is a slug derived from the name at creation time and never changes
-- afterwards (grants and qualified tool names are keyed on it).

CREATE TABLE IF NOT EXISTS dynamic_upstreams (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 48),
  url TEXT NOT NULL UNIQUE CHECK (char_length(url) <= 2048),
  enabled BOOLEAN NOT NULL DEFAULT true,
  credential_cipher BYTEA,
  credential_mode TEXT,
  credential_header_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Ciphertext, mode and header name live or die together.
  CONSTRAINT dynamic_upstreams_credential_shape CHECK (
    (credential_cipher IS NULL AND credential_mode IS NULL AND credential_header_name IS NULL)
    OR (credential_cipher IS NOT NULL AND credential_mode IN ('bearer', 'header'))
  ),
  -- Header-mode credentials must name the header they travel in.
  CONSTRAINT dynamic_upstreams_header_name CHECK (
    credential_mode IS DISTINCT FROM 'header' OR credential_header_name IS NOT NULL
  )
);

-- The action CHECK grows by the three upstream-CRUD actions (D34). Same
-- pattern as 002 and 003: the database stays the enforcement point, not just
-- the TypeScript union. Users are NOT touched; existing grants and keys are
-- untouched too.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
  action IN ('tool_call', 'auth_failed', 'access_denied', 'key_created', 'key_revoked',
             'upstream_enabled', 'upstream_disabled', 'user_created', 'user_updated',
             'upstream_created', 'upstream_updated', 'upstream_deleted')
);
