import type { AuditLogEntry } from "@mcp/shared";
import type { AuditFilters, AuditRepository, NewAuditEntry, UpstreamToolStats } from "./audit-repository.ts";
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

interface ToolStatsRow {
  upstream_id: string;
  calls: number;
  errors: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  last_called_at: Date | null;
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

    async recent(limit: number, beforeId?: string, filters?: AuditFilters): Promise<AuditLogEntry[]> {
      // Dynamic WHERE built ONLY from parameterized fragments: values arrive
      // as $n placeholders (no interpolation), so a filter can never change
      // the query structure. Keyset pagination stays first in the predicate.
      const params: Array<string | number | null> = [];
      const predicates: string[] = ["($1::bigint IS NULL OR id < $1::bigint)"];
      params.push(beforeId ?? null);

      const push = (sql: (index: number) => string, value: string): void => {
        params.push(value);
        predicates.push(sql(params.length));
      };

      if (filters?.action !== undefined) {
        push((i) => `action = $${i}`, filters.action);
      }
      if (filters?.outcome !== undefined) {
        push((i) => `outcome = $${i}`, filters.outcome);
      }
      if (filters?.userId !== undefined) {
        push((i) => `user_id = $${i}`, filters.userId);
      }
      if (filters?.upstreamId !== undefined) {
        push((i) => `upstream_id = $${i}`, filters.upstreamId);
      }
      if (filters?.tool !== undefined) {
        // Bounded substring: escape LIKE metacharacters, then anchor nothing —
        // the route already capped the term length.
        const term = `%${filters.tool.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        push((i) => `qualified_name ILIKE $${i} ESCAPE '\\'`, term);
      }

      params.push(limit);
      const result = await pool.query<AuditRow>(
        `SELECT id, occurred_at, action, key_id, user_id, role, upstream_id,
                tool_name, qualified_name, outcome, duration_ms, error_code
           FROM audit_log
          WHERE ${predicates.join(" AND ")}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toAuditEntry);
    },

    async toolStats(): Promise<UpstreamToolStats[]> {
      // Pure aggregation over the append-only audit log (C6 keeps it that
      // way): one GROUP BY, parameterless, no user input reaches the SQL.
      const result = await pool.query<ToolStatsRow>(
        `SELECT upstream_id,
                count(*)::int AS calls,
                count(*) FILTER (WHERE outcome = 'error')::int AS errors,
                coalesce(round(avg(duration_ms)), 0)::int AS avg_duration_ms,
                coalesce(max(duration_ms), 0)::int AS max_duration_ms,
                max(occurred_at) AS last_called_at
           FROM audit_log
          WHERE action = 'tool_call' AND upstream_id IS NOT NULL
          GROUP BY upstream_id`,
      );
      return result.rows.map((row) => ({
        upstreamId: row.upstream_id,
        calls: row.calls,
        errors: row.errors,
        avgDurationMs: row.avg_duration_ms,
        maxDurationMs: row.max_duration_ms,
        lastCalledAt: row.last_called_at === null ? null : row.last_called_at.toISOString(),
      }));
    },
  };
}
