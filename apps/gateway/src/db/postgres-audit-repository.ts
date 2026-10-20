import type { AuditLogEntry } from "@mcp/shared";
import type { AuditRepository, NewAuditEntry } from "./audit-repository.ts";
import type { Pool } from "./pool.ts";

interface AuditRow {
  id: string;
  occurred_at: Date;
  action: string;
  key_id: string | null;
  user_id: string | null;
  role: string | null;
  upstream_id: string | null;
  tool_name: string | null;
  qualified_name: string | null;
  outcome: string;
  duration_ms: number;
  error_code: string | null;
}

function toAuditEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    action: row.action as AuditLogEntry["action"],
    keyId: row.key_id,
    userId: row.user_id,
    role: row.role === "admin" || row.role === "reader" ? row.role : null,
    upstreamId: row.upstream_id as AuditLogEntry["upstreamId"],
    toolName: row.tool_name,
    qualifiedName: row.qualified_name,
    outcome: row.outcome as AuditLogEntry["outcome"],
    durationMs: row.duration_ms,
    errorCode: row.error_code,
  };
}

export function createPostgresAuditRepository(pool: Pool): AuditRepository {
  return {
    async append(entry: NewAuditEntry): Promise<void> {
      await pool.query(
        `INSERT INTO audit_log
           (action, key_id, user_id, role, upstream_id, tool_name, qualified_name,
            outcome, duration_ms, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.action,
          entry.keyId,
          entry.userId,
          entry.role,
          entry.upstreamId,
          entry.toolName,
          entry.qualifiedName,
          entry.outcome,
          entry.durationMs,
          entry.errorCode,
        ],
      );
    },

    async recent(limit: number, beforeId?: string): Promise<AuditLogEntry[]> {
      const result = await pool.query<AuditRow>(
        `SELECT id, occurred_at, action, key_id, user_id, role, upstream_id,
                tool_name, qualified_name, outcome, duration_ms, error_code
           FROM audit_log
          WHERE ($1::bigint IS NULL OR id < $1::bigint)
          ORDER BY id DESC
          LIMIT $2`,
        [beforeId ?? null, limit],
      );
      return result.rows.map(toAuditEntry);
    },
  };
}
