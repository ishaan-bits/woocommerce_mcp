/**
 * Persisted upstream enable/disable overrides (D24): dashboard toggles are
 * applied live *and* written here so they survive a gateway restart. Rows are
 * keyed by the fixed UPSTREAM_IDS values (enforced by the table CHECK and by
 * the gateway before any write) — a row can never introduce an arbitrary
 * URL or connection target.
 */
export interface UpstreamStateRepository {
  /** All stored overrides: upstreamId → enabled. */
  getOverrides(): Promise<Record<string, boolean>>;
  setOverride(upstreamId: string, enabled: boolean, updatedBy: string | null): Promise<void>;
}
