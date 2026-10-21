import { useCallback, useEffect, useState } from "react";
import type { ApiClient, MeResponse } from "../api/client.ts";
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

/**
 * Audit viewer (C6/D22): read-only, admin-gated by the server. Pagination is
 * keyset (`before` cursor) with a clamped limit — the client never fetches
 * unbounded history. Rows are projected through projectAuditRow, so only
 * whitelisted display fields reach the DOM (no keys, hashes, headers or
 * cookies, whatever the server returns).
 */
export function AuditPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<AuditRowView[]>>(loading());
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [limit, setLimit] = useState(AUDIT_LIMIT_DEFAULT);
  const [exhausted, setExhausted] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);

  const loadFirstPage = useCallback(
    async (nextLimit: number) => {
      if (me.role !== "admin") {
        setState({ status: "error", code: "forbidden", message: "The audit viewer requires the admin role." });
        return;
      }
      setState(loading());
      try {
        const response = await api.audit(clampAuditLimit(nextLimit));
        const projected = projectAuditRows(response.entries);
        setRows(projected);
        setExhausted(response.entries.length < clampAuditLimit(nextLimit));
        setState(loaded(projected, projected.length === 0));
      } catch (error) {
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
    void loadFirstPage(limit);
    // Refetch only when the limit changes (each route mount remounts the page).
  }, [limit, loadFirstPage]);

  const loadOlder = async (): Promise<void> => {
    const cursor = auditCursor(rows);
    if (cursor === undefined || olderBusy) {
      return;
    }
    setOlderBusy(true);
    try {
      const response = await api.audit(clampAuditLimit(limit), cursor);
      const projected = projectAuditRows(response.entries);
      const seen = new Set(rows.map((row) => row.id));
      const appended = [...rows, ...projected.filter((row) => !seen.has(row.id))];
      setRows(appended);
      setExhausted(response.entries.length < clampAuditLimit(limit));
      setState(loaded(appended, appended.length === 0));
    } catch (error) {
      const failure = toFailure(error);
      setState(failed(failure.code, failure.message));
    } finally {
      setOlderBusy(false);
    }
  };

  return (
    <section aria-labelledby="audit-heading">
      <div className="row space-between">
        <h1 id="audit-heading">Audit log</h1>
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

      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && (
          <p className="muted" role="status">
            Loading audit entries…
          </p>
        )}
        {state.status === "error" && (
          <div className="banner banner-error" role="alert">
            <p>{state.message}</p>
            {state.code === "forbidden" || state.code === "unauthorized" ? null : (
              <button type="button" onClick={() => void loadFirstPage(limit)}>
                Retry
              </button>
            )}
          </div>
        )}
        {state.status === "empty" && (
          <div className="empty-state">
            <p>No audit entries yet.</p>
            <p className="muted">Tool calls, auth failures, key changes and upstream toggles appear here.</p>
          </div>
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
                    <th scope="col">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="small">{new Date(row.occurred_at).toLocaleString()}</td>
                      <td>{row.action}</td>
                      <td>
                        <span className={`badge ${row.outcome === "success" ? "badge-ok" : "badge-warn"}`}>
                          {row.outcome}
                        </span>
                      </td>
                      <td className="small">{row.actor}</td>
                      <td className="small">{row.upstream ?? "—"}</td>
                      <td className="small">{row.tool ?? "—"}</td>
                      <td className="small">{row.error_code ?? "—"}</td>
                      <td className="small">{row.duration_ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={olderBusy || exhausted || rows.length === 0}
              >
                {olderBusy ? "Loading…" : exhausted ? "No older entries" : "Load older"}
              </button>
              <span className="muted small">{rows.length} entries shown</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
