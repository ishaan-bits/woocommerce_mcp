import type { AuditAction, AuditLogEntry, ToolCallOutcome, UpstreamId, UserRole } from "@mcp/shared";

/** Sanitized write-side input; sanitization happens in the audit writer. */
export interface NewAuditEntry {
  readonly action: AuditAction;
  readonly keyId: string | null;
  readonly userId: string | null;
  readonly role: UserRole | null;
  readonly upstreamId: UpstreamId | null;
  readonly toolName: string | null;
  readonly qualifiedName: string | null;
  readonly outcome: ToolCallOutcome;
  readonly durationMs: number;
  readonly errorCode: string | null;
}

/** Append-only in production (C6): INSERT + SELECT, never UPDATE/DELETE. */
export interface AuditRepository {
  append(entry: NewAuditEntry): Promise<void>;
  /** Newest first; `beforeId` is a keyset cursor on the BIGSERIAL id. */
  recent(limit: number, beforeId?: string): Promise<AuditLogEntry[]>;
}
