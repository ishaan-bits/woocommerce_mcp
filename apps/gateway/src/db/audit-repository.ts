import type { AuditAction, AuditLogEntry, ToolCallOutcome, UserRole } from "@mcp/shared";

/** Sanitized write-side input; sanitization happens in the audit writer. */
export interface NewAuditEntry {
  readonly action: AuditAction;
  readonly keyId: string | null;
  readonly userId: string | null;
  readonly role: UserRole | null;
  readonly upstreamId: string | null;
  readonly toolName: string | null;
  readonly qualifiedName: string | null;
  readonly outcome: ToolCallOutcome;
  readonly durationMs: number;
  readonly errorCode: string | null;
}

/**
 * Optional read filters for the dashboard audit view. Values are validated
 * against fixed whitelists (actions/outcomes) and the registry's live
 * upstream ids in the route BEFORE they reach SQL; the tool term is a
 * bounded substring match on the qualified name (parameterized — never
 * string-concatenated into the query).
 */
export interface AuditFilters {
  readonly action?: AuditAction;
  readonly outcome?: ToolCallOutcome;
  readonly userId?: string;
  readonly upstreamId?: string;
  /** Substring of qualified_name (e.g. "woocommerce_list_products"). */
  readonly tool?: string;
}

/** Append-only in production (C6): INSERT + SELECT, never UPDATE/DELETE. */
export interface AuditRepository {
  append(entry: NewAuditEntry): Promise<void>;
  /** Newest first; `beforeId` is a keyset cursor on the BIGSERIAL id. */
  recent(limit: number, beforeId?: string, filters?: AuditFilters): Promise<AuditLogEntry[]>;
  /**
   * Per-server tool-call aggregate for observability (stand-out 8): calls,
   * errors, latency and last-call time, grouped by upstream. Read-only
   * aggregation over the audit log — no new state, no secrets involved.
   */
  toolStats(): Promise<UpstreamToolStats[]>;
}

/** Aggregate metrics for one upstream, computed from audited tool calls. */
export interface UpstreamToolStats {
  readonly upstreamId: string;
  readonly calls: number;
  readonly errors: number;
  readonly avgDurationMs: number;
  readonly maxDurationMs: number;
  /** ISO timestamp of the most recent tool call, or null when never called. */
  readonly lastCalledAt: string | null;
}
