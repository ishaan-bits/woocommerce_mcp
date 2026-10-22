/**
 * Pure builder for the audit query string (test/audit.test.ts). Keeps the
 * client from ever sending free-form or oversized filters, and mirrors the
 * server's whitelists so a bad filter surfaces as a 400 the UI can explain.
 */

export const AUDIT_ACTIONS: readonly string[] = [
  "tool_call",
  "auth_failed",
  "access_denied",
  "key_created",
  "key_revoked",
  "upstream_enabled",
  "upstream_disabled",
  "user_created",
  "user_updated",
  "upstream_created",
  "upstream_updated",
  "upstream_deleted",
];

export const AUDIT_OUTCOMES: readonly string[] = ["success", "error", "timeout", "denied"];

export const UPSTREAM_FILTER_IDS: readonly string[] = ["woocommerce", "inventory", "support"];

export interface AuditFilterState {
  action: string;
  outcome: string;
  upstreamId: string;
  tool: string;
  userId: string;
}

export function emptyAuditFilters(): AuditFilterState {
  return { action: "", outcome: "", upstreamId: "", tool: "", userId: "" };
}

export function auditFiltersActive(filters: AuditFilterState): boolean {
  return (
    filters.action !== "" ||
    filters.outcome !== "" ||
    filters.upstreamId !== "" ||
    filters.tool.trim() !== "" ||
    filters.userId !== ""
  );
}

const TOOL_MAX_LEN = 64;

/**
 * Build the query params for GET /api/audit. Only whitelisted, non-empty
 * values are included; the tool term is trimmed and capped at the server's
 * 64-char bound so we never knowingly send a 400. Returns an object ready to
 * spread into URLSearchParams (limit/before handled by the caller).
 */
export function buildAuditQuery(filters: AuditFilterState): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.action !== "" && AUDIT_ACTIONS.includes(filters.action)) {
    query.action = filters.action;
  }
  if (filters.outcome !== "" && AUDIT_OUTCOMES.includes(filters.outcome)) {
    query.outcome = filters.outcome;
  }
  if (filters.upstreamId !== "" && UPSTREAM_FILTER_IDS.includes(filters.upstreamId)) {
    query.upstreamId = filters.upstreamId;
  }
  const tool = filters.tool.trim();
  if (tool !== "") {
    query.tool = tool.slice(0, TOOL_MAX_LEN);
  }
  if (filters.userId.trim() !== "") {
    query.userId = filters.userId.trim();
  }
  return query;
}

/** Badge tone for an outcome so failures are visually obvious. */
export function outcomeTone(outcome: string): "success" | "warn" | "error" | "neutral" {
  if (outcome === "success") return "success";
  if (outcome === "error") return "error";
  if (outcome === "timeout" || outcome === "denied") return "warn";
  return "neutral";
}

/** Local time string for a timestamp; title attributes carry the ISO/UTC. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
