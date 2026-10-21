import { useCallback, useEffect, useState } from "react";
import type { ApiClient, MeResponse, UpstreamStatusView } from "../api/client.ts";
import { failed, loaded, loading, projectAuditRows, toFailure, type AuditRowView, type LoadState } from "../state.ts";

export function OverviewPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [upstreams, setUpstreams] = useState<LoadState<UpstreamStatusView[]>>(loading());
  const [recent, setRecent] = useState<LoadState<AuditRowView[]>>(loading());

  const refresh = useCallback(async () => {
    setUpstreams(loading());
    try {
      const response = await api.upstreams();
      setUpstreams(loaded(response.upstreams, response.upstreams.length === 0));
    } catch (error) {
      const failure = toFailure(error);
      setUpstreams(failed(failure.code, failure.message));
    }
    if (me.role === "admin") {
      setRecent(loading());
      try {
        const response = await api.audit(5);
        const rows = projectAuditRows(response.entries);
        setRecent(loaded(rows, rows.length === 0));
      } catch (error) {
        const failure = toFailure(error);
        setRecent(failed(failure.code, failure.message));
      }
    }
  }, [api, me.role]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-labelledby="overview-heading">
      <div className="row space-between">
        <h1 id="overview-heading">Overview</h1>
        <button type="button" className="ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="cards">
        <article className="card">
          <h2>Session</h2>
          <dl className="kv">
            <div>
              <dt>Signed in as</dt>
              <dd>{me.display_name}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                <span className={`badge badge-${me.role}`}>{me.role}</span>
              </dd>
            </div>
            <div>
              <dt>Granted upstreams</dt>
              <dd>{me.allowed_upstreams.length > 0 ? me.allowed_upstreams.join(", ") : "none"}</dd>
            </div>
            <div>
              <dt>Granted tools</dt>
              <dd>{me.allowed_tools.length}</dd>
            </div>
          </dl>
        </article>

        <article className="card" aria-busy={upstreams.status === "loading"}>
          <h2>Upstreams</h2>
          {upstreams.status === "loading" && <p className="muted">Loading status…</p>}
          {upstreams.status === "error" && (
            <p className="banner banner-error" role="alert">
              {upstreams.message}
              {upstreams.code === "gateway_unreachable" && " — the gateway appears to be disconnected."}
            </p>
          )}
          {upstreams.status === "empty" && <p className="muted">No upstreams configured.</p>}
          {upstreams.status === "loaded" && (
            <ul className="status-list">
              {upstreams.data.map((entry) => (
                <li key={entry.id}>
                  <span className={`dot ${entry.configured && entry.enabled && entry.reachable ? "dot-ok" : "dot-warn"}`} />
                  <span className="status-name">{entry.id}</span>
                  <span className="muted small">
                    {!entry.configured
                      ? "not configured"
                      : !entry.enabled
                        ? "disabled"
                        : entry.reachable
                          ? "reachable"
                          : `unreachable${entry.last_error !== null ? `: ${entry.last_error}` : ""}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="card" aria-busy={recent.status === "loading"}>
          <h2>Recent audit activity</h2>
          {me.role !== "admin" && (
            <p className="muted">The audit viewer requires the admin role (enforced server-side).</p>
          )}
          {me.role === "admin" && recent.status === "loading" && <p className="muted">Loading…</p>}
          {me.role === "admin" && recent.status === "error" && (
            <p className="banner banner-error" role="alert">
              {recent.message}
            </p>
          )}
          {me.role === "admin" && recent.status === "empty" && <p className="muted">No audit entries yet.</p>}
          {me.role === "admin" && recent.status === "loaded" && (
            <ul className="status-list">
              {recent.data.map((row) => (
                <li key={row.id}>
                  <span className="status-name">{row.action}</span>
                  <span className={`badge badge-${row.outcome === "success" ? "ok" : "warn"}`}>{row.outcome}</span>
                  <span className="muted small">{new Date(row.occurred_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
