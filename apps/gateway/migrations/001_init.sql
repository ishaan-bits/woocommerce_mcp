-- Milestone 3 schema (D7, D8, C1, C2, C5, C6).
-- Applied by `npm run migrate -w @mcp/gateway`; tracked in schema_migrations.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
  allowed_upstreams TEXT[] NOT NULL DEFAULT '{}',
  allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the sha256(key || pepper) hex digest and a non-secret display prefix
-- are stored. The plaintext key exists exactly once, in the creation response.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (key_prefix);

-- Append-only audit (C6). key_id/user_id are denormalized TEXT (not FKs) so
-- failed authentication attempts — where no key/user is known — still fit.
-- Arguments, responses, headers and credentials are never stored.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL CHECK (action IN ('tool_call', 'auth_failed', 'access_denied', 'key_created', 'key_revoked')),
  key_id TEXT,
  user_id TEXT,
  role TEXT CHECK (role IS NULL OR role IN ('admin', 'reader')),
  upstream_id TEXT,
  tool_name TEXT,
  qualified_name TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'timeout', 'denied')),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  error_code TEXT
);

-- Retention/read pattern: newest-first keyset pagination (the "10M rows"
-- interview question: index on occurred_at DESC + keyset, never OFFSET).
CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log (occurred_at DESC);

-- C2: exactly two demo users with explicit C5 grants. Grants list qualified
-- names, so unknown tools fail closed until a grant is added on purpose.
INSERT INTO users (id, display_name, role, allowed_upstreams, allowed_tools) VALUES
  ('11111111-1111-4111-8111-111111111111', 'admin-demo', 'admin',
   ARRAY['woocommerce', 'inventory', 'support'],
   ARRAY['tools:woocommerce_list_products',
         'tools:woocommerce_create_product',
         'tools:woocommerce_list_orders',
         'tools:woocommerce_get_order',
         'tools:woocommerce_update_order_status']),
  ('22222222-2222-4222-8222-222222222222', 'reader-demo', 'reader',
   ARRAY['woocommerce'],
   ARRAY['tools:woocommerce_list_products',
         'tools:woocommerce_list_orders',
         'tools:woocommerce_get_order'])
ON CONFLICT (display_name) DO NOTHING;
