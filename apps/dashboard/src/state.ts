/**
 * Pure dashboard state helpers — no DOM, no fetch, so the loading / empty /
 * error transitions, the audit pagination bounds and the sensitive-field
 * redaction are all unit-testable under `node --test` (test/*.test.ts).
 */

export type LoadState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly data: T }
  | { readonly status: "empty" }
  | { readonly status: "error"; readonly code: string; readonly message: string };

export function idle<T>(): LoadState<T> {
  return { status: "idle" };
}

export function loading<T>(): LoadState<T> {
  return { status: "loading" };
}

export function loaded<T>(data: T, isEmpty = false): LoadState<T> {
  return isEmpty ? { status: "empty" } : { status: "loaded", data };
}

export function failed<T>(code: string, message: string): LoadState<T> {
  return { status: "error", code, message };
}

/** Map any thrown value (ApiError, TypeError, …) into a display-safe failure. */
export function toFailure(error: unknown): { code: string; message: string } {
  if (error !== null && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    const message = error instanceof Error && error.message.length > 0 ? error.message : code;
    return { code, message };
  }
  if (error instanceof Error) {
    return { code: "error", message: error.message };
  }
  return { code: "error", message: String(error) };
}

export const AUDIT_LIMIT_MIN = 1;
export const AUDIT_LIMIT_MAX = 100;
export const AUDIT_LIMIT_DEFAULT = 50;

/** The server rejects anything outside 1–100; clamp before sending (D22 bounds). */
export function clampAuditLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return AUDIT_LIMIT_DEFAULT;
  }
  return Math.min(AUDIT_LIMIT_MAX, Math.max(AUDIT_LIMIT_MIN, Math.floor(value)));
}

/**
 * Whitelisted projection of an audit row for display (C1/C6): only the fields
 * the viewer needs ever reach the render layer — key material, hashes,
 * headers, cookies or anything unexpected is dropped here even if a future
 * server change were to add it.
 */
export interface AuditRowView {
  id: string;
  occurred_at: string;
  action: string;
  outcome: string;
  actor: string;
  upstream: string | null;
  tool: string | null;
  error_code: string | null;
  duration_ms: number;
}

export function projectAuditRow(entry: object): AuditRowView {
  // `object` (not Record<string, unknown>) so typed API interfaces also fit;
  // reads still go through a narrowed view of the input.
  const src = entry as Record<string, unknown>;
  const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const role = str(src.role);
  const userId = str(src.userId);
  return {
    id: String(src.id ?? ""),
    occurred_at: String(src.occurredAt ?? ""),
    action: String(src.action ?? "unknown"),
    outcome: String(src.outcome ?? "unknown"),
    actor: userId !== null ? (role !== null ? `${userId} (${role})` : userId) : (role ?? "system"),
    upstream: str(src.upstreamId),
    tool: str(src.qualifiedName) ?? str(src.toolName),
    error_code: str(src.errorCode),
    duration_ms: typeof src.durationMs === "number" && src.durationMs >= 0 ? src.durationMs : 0,
  };
}

export function projectAuditRows(entries: ReadonlyArray<object>): AuditRowView[] {
  return entries.map(projectAuditRow);
}

/**
 * Keyset cursor for "load older": the id of the oldest row on screen. Keyset
 * (not offset) keeps pagination bounded on a 10M-row table (D22).
 */
export function auditCursor(rows: ReadonlyArray<{ id: string }>): string | undefined {
  const last = rows[rows.length - 1];
  return last === undefined ? undefined : last.id;
}

/** Next limit choice for the selector (bounded cycle, never unbounded). */
export function nextAuditLimit(current: number): number {
  const steps = [10, 25, 50, 100];
  const index = steps.indexOf(clampAuditLimit(current));
  return steps[(index + 1) % steps.length] ?? AUDIT_LIMIT_DEFAULT;
}
