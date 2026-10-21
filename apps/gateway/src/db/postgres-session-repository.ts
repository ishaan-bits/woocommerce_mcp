import type { Pool } from "./pool.ts";
import type { SessionRepository, StoredSession } from "./session-repository.ts";

interface SessionRow {
  token_hash: string;
  user_id: string;
  key_id: string;
  expires_at: Date;
}

function toStored(row: SessionRow): StoredSession {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    keyId: row.key_id,
    expiresAt: row.expires_at.toISOString(),
  };
}

export function createPostgresSessionRepository(pool: Pool): SessionRepository {
  return {
    async create(session: StoredSession): Promise<void> {
      await pool.query(
        `INSERT INTO web_sessions (token_hash, user_id, key_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [session.tokenHash, session.userId, session.keyId, session.expiresAt],
      );
    },

    async find(tokenHash: string): Promise<StoredSession | null> {
      const result = await pool.query<SessionRow>(
        `SELECT token_hash, user_id, key_id, expires_at
           FROM web_sessions
          WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row === undefined ? null : toStored(row);
    },

    async delete(tokenHash: string): Promise<boolean> {
      const result = await pool.query(`DELETE FROM web_sessions WHERE token_hash = $1`, [tokenHash]);
      return (result.rowCount ?? 0) > 0;
    },

    async deleteExpired(nowIso: string): Promise<number> {
      const result = await pool.query(`DELETE FROM web_sessions WHERE expires_at <= $1`, [nowIso]);
      return result.rowCount ?? 0;
    },
  };
}
