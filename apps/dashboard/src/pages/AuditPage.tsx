import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, MeResponse, UserRecord } from "../api/client.ts";
import {
  auditCursor,
  AUDIT_LIMIT_DEFAULT,
  clampAuditLimit,
  failed,
  loaded,
  loading,
  projectAuditRows,
  toFailure,
  type AuditRowView,
  type LoadState,
} from "../state.ts";
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  UPSTREAM_FILTER_IDS,
  auditFiltersActive,
  buildAuditQuery,
  emptyAuditFilters,
  formatLocalTime,
  outcomeTone,
  type AuditFilterState,
} from "../lib/audit.ts";
import { roleLabel, upstreamLabel } from "../lib/permissions.ts";
import { Badge, EmptyState, ErrorBanner, Skeleton } from "../components/ui.tsx";
import { Modal } from "../components/Modal.tsx";

/**
 * Audit viewer (C6/D22): read-only, admin-gated by the server. Keyset
 * pagination (before cursor) with a clamped limit, plus server-whitelisted
 * filters (action / outcome / upstream / tool / actor). Rows are projected
 * through projectAuditRow, so only whitelisted display fields reach the DOM.
 */
export function AuditPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<AuditRowView[]>>(loading());
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [limit, setLimit] = useState(AUDIT_LIMIT_DEFAULT);
  const [filters, setFilters] = useState<AuditFilterState>(emptyAuditFilters());
  const [users, setUsers] = useState<LoadState<UserRecord[]>>(loading());
  const [exhausted, setExhausted] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [detail, setDetail] = useState<AuditRowView | null>(null);
  const seq = useRef(0);

  const activeFilters = useMemo(() => auditFiltersActive(filters), [filters]);
  const query = useMemo(() => buildAuditQuery(filters), [filters]);

  // Actor options for the select (admin-only endpoint; degrade to text input).
  useEffect(() => {
    if (me.role !== "admin") {
      setUsers(failed("forbidden", "requires admin"));
      return;
    }
    let cancelled = false;
    api
      .users()
      .then((response) => {
        if (!cancelled) setUsers(loaded(response.users, response.users.length === 0));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const failure = toFailure(error);
        setUsers(failed(failure.code, failure.message));
      });
    return () => {
      cancelled = true;
    };
  }, [api, me.role]);

  const loadFirstPage = useCallback(
    async (nextLimit: number, nextFilters: AuditFilterState) => {
      const id = ++seq.current;
      if (me.role !== "admin") {
        setState(failed("forbidden", "The audit log requires the admin role."));
        return;
      }
      setState(loading());
      try {
        const response = await api.audit(clampAuditLimit(nextLimit), undefined, buildAuditQuery(nextFilters));
        if (id !== seq.current) return;
        const projected = projectAuditRows(response.entries);
        setRows(projected);
        setExhausted(response.entries.length < clampAuditLimit(nextLimit));
        setState(loaded(projected, projected.length === 0));
      } catch (error) {
        if (id !== seq.current) return;
        const failure = toFailure(error);
        setState(
          failed(
            failure.code,
            failure.code === "forbidden"
              ? "Access denied — the gateway requires the admin role for audit queries."
              : failure.message,
          ),
        );
      }
    },
    [api, me.role],
  );

  useEffect(() => {
    void loadFirstPage(limit, filters);
  }, [limit, filters, loadFirstPage]);

  const loadOlder = async (): Promise<void> => {
    const cursor = auditCursor(rows);
    if (cursor === undefined || olderBusy) return;
    const id = ++seq.current;
    setOlderBusy(true);
    try {
      const response = await api.audit(clampAuditLimit(limit), cursor, query);
      if (id !== seq.current) return;
      const projected = projectAuditRows(response.entries);
      const seen = new Set(rows.map((row) => row.id));
      const appended = [...rows, ...projected.filter((row) => !seen.has(row.id))];
      setRows(appended);
      setExhausted(response.entries.length < clampAuditLimit(limit));
      setState(loaded(appended, appended.length === 0));
    } catch (error) {
      if (id !== seq.current) return;
      const failure = toFailure(error);
      setState(failed(failure.code, failure.message));
    } finally {
      setOlderBusy(false);
    }
  };

  if (me.role !== "admin") {
    return (
      <section aria-labelledby="audit-heading">
        <h1 id="audit-heading">Audit log</h1>
        <ErrorBanner message="The audit log requires the admin role (enforced server-side). You are signed in as a member." />
      </section>
    );
  }

  const setFilter = <K extends keyof AuditFilterState>(key: K, value: AuditFilterState[K]): void =>
    setFilters((current) => ({ ...current, [key]: value }));

  return (
    <section aria-labelledby="audit-heading">
      <div className="row space-between page-head">
        <div>
          <p className="eyebrow">Governance</p>
          <h1 id="audit-heading">Audit log</h1>
        </div>
        <div className="row">
          <label htmlFor="audit-limit" className="muted small">
            Page size
          </label>
          <select
            id="audit-limit"
            value={limit}
            onChange={(event) => setLimit(clampAuditLimit(Number(event.target.value)))}
          >
            {[10, 25, 50, 100].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted">
        Newest first, keyset pagination (<code>before</code> cursor), read-only — rendered from a whitelisted projection
        (no key material).
      </p>

      <div className="filters card" role="group" aria-label="Audit filters">
        <div className="field field-inline">
          <label htmlFor="filter-action">Action</label>
          <select id="filter-action" value={filters.action} onChange={(event) => setFilter("action", event.target.value)}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor="filter-outcome">Outcome</label>
          <select id="filter-outcome" value={filters.outcome} onChange={(event) => setFilter("outcome", event.target.value)}>
            <option value="">All outcomes</option>
            {AUDIT_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor="filter-upstream">Upstream</label>
          <select
            id="filter-upstream"
            value={filters.upstreamId}
            onChange={(event) => setFilter("upstreamId", event.target.value)}
          >
            <option value="">All upstreams</option>
            {UPSTREAM_FILTER_IDS.map((id) => (
              <option key={id} value={id}>
                {upstreamLabel(id)}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor="filter-tool">Tool</label>
          <input
            id="filter-tool"
            type="text"
            placeholder="tool name…"
            value={filters.tool}
            maxLength={64}
            onChange={(event) => setFilter("tool", event.target.value)}
          />
        </div>
        <div className="field field-inline">
          {users.status === "loaded" ? (
            <>
              <label htmlFor="filter-actor">Actor</label>
              <select id="filter-actor" value={filters.userId} onChange={(event) => setFilter("userId", event.target.value)}>
                <option value="">All actors</option>
                {users.data.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} ({roleLabel(user.role)})
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="filter-actor-id">Actor user id</label>
              <input
                id="filter-actor-id"
                type="text"
                placeholder="user id…"
                value={filters.userId}
                onChange={(event) => setFilter("userId", event.target.value)}
              />
            </>
          )}
        </div>
        {activeFilters && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(emptyAuditFilters())}>
            Clear filters
          </button>
        )}
      </div>

      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && <Skeleton rows={5} />}
        {state.status === "error" && (
          <ErrorBanner
            message={state.code === "forbidden" || state.code === "unauthorized" ? state.message : `Could not load audit entries: ${state.message}`}
            onRetry={state.code === "forbidden" || state.code === "unauthorized" ? undefined : () => void loadFirstPage(limit, filters)}
          />
        )}
        {state.status === "empty" && !activeFilters && (
          <EmptyState
            title="No audit entries yet"
            hint="Tool calls, auth failures, key changes and upstream toggles appear here."
          />
        )}
        {state.status === "empty" && activeFilters && (
          <EmptyState
            title="No entries match the current filters"
            hint="Try broadening or clearing the filters above."
            action={
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(emptyAuditFilters())}>
                Clear filters
              </button>
            }
          />
        )}
        {(state.status === "loaded" || state.status === "empty") && rows.length > 0 && (
          <>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Audit entries, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Upstream</th>
                    <th scope="col">Tool</th>
                    <th scope="col">Error</th>
                    <th scope="col" className="num">ms</th>
                    <th scope="col"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="small" title={row.occurred_at}>
                        {formatLocalTime(row.occurred_at)}
                      </td>
                      <td>{row.action}</td>
                      <td>
                        <Badge tone={outcomeTone(row.outcome)}>{row.outcome}</Badge>
                      </td>
                      <td className="small">{row.actor}</td>
                      <td className="small">{row.upstream ?? "—"}</td>
                      <td className="small">{row.tool ?? "—"}</td>
                      <td className="small">{row.error_code ?? "—"}</td>
                      <td className="small num">{row.duration_ms}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDetail(row)}
                          aria-label={`Details for ${row.action} at ${row.occurred_at}`}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button type="button" className="btn btn-secondary" onClick={() => void loadOlder()} disabled={olderBusy || exhausted || rows.length === 0}>
                {olderBusy ? "Loading…" : exhausted ? "No older entries" : "Load older"}
              </button>
              <span className="muted small">{rows.length} entries shown</span>
            </div>
          </>
        )}
      </div>

      {detail !== null && (
        <Modal
          title="Audit event"
          onClose={() => setDetail(null)}
          footer={
            <button type="button" className="btn btn-secondary" onClick={() => setDetail(null)}>
              Close
            </button>
          }
        >
          <dl className="kv">
            <dt>Action</dt>
            <dd>{detail.action}</dd>
            <dt>Outcome</dt>
            <dd>
              <Badge tone={outcomeTone(detail.outcome)}>{detail.outcome}</Badge>
            </dd>
            <dt>Actor</dt>
            <dd>{detail.actor}</dd>
            <dt>Upstream</dt>
            <dd>{detail.upstream ?? "—"}</dd>
            <dt>Tool</dt>
            <dd>{detail.tool ?? "—"}</dd>
            <dt>Time</dt>
            <dd title={detail.occurred_at}>{formatLocalTime(detail.occurred_at)}</dd>
            <dt>Duration</dt>
            <dd>{detail.duration_ms} ms</dd>
            <dt>Error code</dt>
            <dd>{detail.error_code ?? "—"}</dd>
          </dl>
          <p className="muted tiny" style={{ marginTop: "var(--sp-4)" }}>
            Rendered from the server&apos;s whitelisted projection — key material and request payloads are never part of
            this view.
          </p>
        </Modal>
      )}
    </section>
  );
}
