-- Member administration (dashboard "Team" area): the action CHECK grows by the
-- two user-management actions. Same pattern as 002 — the database stays the
-- enforcement point, not just the TypeScript union. Users themselves are NOT
-- created here: demo users keep coming from 001's seeds; runtime-created
-- members arrive through the admin-only POST /api/users endpoint.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
  action IN ('tool_call', 'auth_failed', 'access_denied', 'key_created', 'key_revoked',
             'upstream_enabled', 'upstream_disabled', 'user_created', 'user_updated')
);
