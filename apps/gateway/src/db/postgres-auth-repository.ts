import type { Pool } from "./pool.ts";
import type {
  AuthRepository,
  CreateKeyResult,
  KeyMetadata,
  StoredApiKey,
  StoredUser,
} from "./auth-repository.ts";

interface KeyRow {
  id: string;
  key_prefix: string;
  key_hash: string;
  revoked_at: Date | null;
  user_id: string;
  display_name: string;
  role: string;
  allowed_upstreams: string[] | null;
  allowed_tools: string[] | null;
}

interface UserRow {
  id: string;
  display_name: string;
  role: string;
  allowed_upstreams: string[] | null;
  allowed_tools: string[] | null;
}

function toStoredUser(row: {
  user_id?: string;
  display_name: string;
  role: string;
  allowed_upstreams: string[] | null;
  allowed_tools: string[] | null;
  id?: string;
}): StoredUser {
  const id = row.user_id ?? row.id ?? "";
  return {
    id,
    displayName: row.display_name,
    role: row.role === "admin" ? "admin" : "reader",
    allowedUpstreams: (row.allowed_upstreams ?? []) as StoredUser["allowedUpstreams"],
    allowedTools: row.allowed_tools ?? [],
  };
}

function toStoredApiKey(row: KeyRow): StoredApiKey {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    user: toStoredUser({ ...row, id: row.user_id }),
  };
}

const KEY_COLUMNS = `
  k.id, k.key_prefix, k.key_hash, k.revoked_at,
  k.user_id, u.display_name, u.role, u.allowed_upstreams, u.allowed_tools
`;

export function createPostgresAuthRepository(pool: Pool): AuthRepository {
  return {
    async findByPrefix(keyPrefix: string): Promise<StoredApiKey[]> {
      const result = await pool.query<KeyRow>(
        `SELECT ${KEY_COLUMNS}
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
          WHERE k.key_prefix = $1
          LIMIT 10`,
        [keyPrefix],
      );
      return result.rows.map(toStoredApiKey);
    },

    async findKeyById(keyId: string): Promise<StoredApiKey | null> {
      const result = await pool.query<KeyRow>(
        `SELECT ${KEY_COLUMNS}
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
          WHERE k.id = $1`,
        [keyId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toStoredApiKey(row);
    },

    async createKey(userId: string, keyPrefix: string, keyHash: string): Promise<CreateKeyResult> {
      const result = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO api_keys (user_id, key_prefix, key_hash)
         VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [userId, keyPrefix, keyHash],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("insert returned no row");
      }
      return { id: row.id, createdAt: row.created_at.toISOString() };
    },

    async revokeKey(keyId: string): Promise<{ found: boolean; revokedNow: boolean; revokedAt: string | null }> {
      const updated = await pool.query<{ revoked_at: Date }>(
        `UPDATE api_keys SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING revoked_at`,
        [keyId],
      );
      const first = updated.rows[0];
      if (first !== undefined) {
        return { found: true, revokedNow: true, revokedAt: first.revoked_at.toISOString() };
      }
      const existing = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_keys WHERE id = $1`,
        [keyId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        return { found: false, revokedNow: false, revokedAt: null };
      }
      return { found: true, revokedNow: false, revokedAt: row.revoked_at?.toISOString() ?? null };
    },

    async listKeys(): Promise<KeyMetadata[]> {
      const result = await pool.query<{
        id: string;
        key_prefix: string;
        created_at: Date;
        revoked_at: Date | null;
        user_id: string;
        display_name: string;
        role: string;
      }>(
        `SELECT k.id, k.key_prefix, k.created_at, k.revoked_at,
                u.id AS user_id, u.display_name, u.role
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
          ORDER BY k.created_at DESC`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        keyPrefix: row.key_prefix,
        userId: row.user_id,
        displayName: row.display_name,
        role: row.role === "admin" ? "admin" : "reader",
        createdAt: row.created_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      }));
    },

    async userExists(userId: string): Promise<boolean> {
      const result = await pool.query<Pick<UserRow, "id">>(`SELECT id FROM users WHERE id = $1`, [userId]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
