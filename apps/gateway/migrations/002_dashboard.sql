-- Milestone 4 schema (dashboard sessions, upstream toggles, new audit actions
-- per D22/D23/D24). Applied by `npm run migrate -w @mcp/gateway`; tracked in
-- schema_migrations.

-- Browser sessions for the dashboard (D23). Only sha256(token) is stored, and
-- every request re-checks the bound API key, so revoking the key kills the
-- session on its next request. The plaintext token exists exactly once: in the
-- Set-Cookie response header.
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx ON web_sessions (expires_at);

-- Dashboard upstream toggles (D24): one row per upstream id (validated against
-- UPSTREAM_IDS by the gateway before any insert — the row can never introduce
-- an arbitrary URL). Absence of a row means "use the environment config".
-- Rows are config state, not audit data: updated in place, never deleted by
-- the runtime role.
CREATE TABLE IF NOT EXISTS upstream_overrides (
  upstream_id TEXT PRIMARY KEY CHECK (upstream_id IN ('woocommerce', 'inventory', 'support')),
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- The action CHECK from 001 grows by the two dashboard administrative
-- actions (D22). The constraint is re-created, not skipped: the database
-- stays the enforcement point, not just the TypeScript union.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
  action IN ('tool_call', 'auth_failed', 'access_denied', 'key_created', 'key_revoked',
             'upstream_enabled', 'upstream_disabled')
);
