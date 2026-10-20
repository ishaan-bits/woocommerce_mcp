import type { AuditAction, AuditLogEntry, ToolCallOutcome, UpstreamId, UserRole } from "@mcp/shared";
import type { AuditRepository, NewAuditEntry } from "./db/audit-repository.ts";
import type { Logger } from "./logger.ts";

/**
 * The single audit writer (C6 / architecture §5.4).
 *
 * Rules enforced here:
 * - never store plaintext keys, peppers, authorization headers, arguments or
 *   upstream responses: callers pass only structured, already-safe fields;
 * - strip control characters from every string (log/row injection) and cap
 *   lengths so one bad input cannot bloat the table;
 * - `error_code` and `action` are reduced to a conservative charset;
 * - append is awaited inside the request path (write-ahead, C6). If the
 *   database itself fails, the caller logs a loud diagnostic and the response
 *   still goes out: a down audit store degrades forensics (reported), it does
 *   not turn into an information leak or a hanging request.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_FIELD = 200;

export function sanitizeAuditText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const cleaned = value.replace(CONTROL_CHARS, "").slice(0, MAX_FIELD);
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeToken(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

export interface AuditWriter {
  record(entry: NewAuditEntry): Promise<void>;
  recordToolCall(fields: {
    principalKey: string | null;
    userId: string | null;
    role: UserRole | null;
    upstreamId: UpstreamId | null;
    toolName: string | null;
    qualifiedName: string;
    outcome: ToolCallOutcome;
    durationMs: number;
    errorCode: string | null;
  }): Promise<void>;
}

export function createAuditWriter(repo: AuditRepository, logger: Logger): AuditWriter {
  async function record(entry: NewAuditEntry): Promise<void> {
    const sanitized: NewAuditEntry = {
      action: entry.action,
      keyId: entry.keyId !== null && entry.keyId.length <= 64 ? entry.keyId : null,
      userId: entry.userId !== null && entry.userId.length <= 64 ? entry.userId : null,
      role: entry.role,
      upstreamId: entry.upstreamId,
      toolName: sanitizeAuditText(entry.toolName),
      qualifiedName: sanitizeAuditText(entry.qualifiedName),
      outcome: entry.outcome,
      durationMs: Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? Math.floor(entry.durationMs) : 0,
      errorCode: sanitizeToken(entry.errorCode),
    };
    try {
      await repo.append(sanitized);
    } catch (error) {
      logger.error("audit_write_failed", {
        action: sanitized.action,
        outcome: sanitized.outcome,
        error: String(error),
      });
    }
  }

  return {
    record,
    async recordToolCall(fields): Promise<void> {
      await record({
        action: "tool_call",
        keyId: fields.principalKey,
        userId: fields.userId,
        role: fields.role,
        upstreamId: fields.upstreamId,
        toolName: fields.toolName,
        qualifiedName: fields.qualifiedName,
        outcome: fields.outcome,
        durationMs: fields.durationMs,
        errorCode: fields.errorCode,
      });
    },
  };
}

export type { AuditAction, AuditLogEntry };
