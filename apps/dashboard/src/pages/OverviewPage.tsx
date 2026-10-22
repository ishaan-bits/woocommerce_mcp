import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, MeResponse, ToolView, UpstreamStatusView } from "../api/client.ts";
import { failed, loaded, loading, projectAuditRows, toFailure, type AuditRowView, type LoadState } from "../state.ts";
import { connectionStatus, getConnectionState } from "../lib/connection.ts";
import { routeHash } from "../lib/routes.ts";
import { groupToolsByUpstream, upstreamHealth } from "../lib/selectors.ts";
import { roleLabel, upstreamLabel } from "../lib/permissions.ts";
import { formatLocalTime, outcomeTone } from "../lib/audit.ts";
import { Badge, Banner, ErrorBanner, Skeleton } from "../components/ui.tsx";

interface OverviewData {
  upstreams: UpstreamStatusView[];
  tools: ToolView[];
}

/** Real metrics only — every number is counted from an actual API response. */
function summarize(upstreams: readonly UpstreamStatusView[], tools: readonly ToolView[]) {
  const configured = upstreams.filter((u) => u.configured).length;
  const enabled = upstreams.filter((u) => u.configured && u.enabled).length;
  const reachable = upstreams.filter((u) => u.configured && u.enabled && u.reachable).length;
  const unreachable = upstreams.filter((u) => u.configured && u.enabled && !u.reachable).length;
  const grouped = groupToolsByUpstream(upstreams, tools);
  return { configured, enabled, reachable, unreachable, totalTools: tools.length, grouped };
}

export function OverviewPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<OverviewData>>(loading());
  const [recent, setRecent] = useState<LoadState<AuditRowView[]>>(loading());
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [connTick, setConnTick] = useState(0);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    setState(loading());
    if (me.role === "admin") setRecent(loading());
    try {
      const [upstreamRes, toolsRes] = await Promise.all([api.upstreams(), api.tools()]);
      if (id !== seq.current) return;
      const data: OverviewData = { upstreams: upstreamRes.upstreams, tools: toolsRes.tools };
      setState(loaded(data, data.upstreams.length === 0 && data.tools.length === 0));
      setLastRefreshedAt(Date.now());
      setConnTick((t) => t + 1);
    } catch (error) {
      if (id !== seq.current) return;
      const failure = toFailure(error);
      setState(failed(failure.code, failure.message));
      setConnTick((t) => t + 1);
    }
    if (me.role === "admin") {
      try {
        const response = await api.audit(10);
        if (id !== seq.current) return;
        const rows = projectAuditRows(response.entries);
        setRecent(loaded(rows, rows.length === 0));
      } catch (error) {
        if (id !== seq.current) return;
        const failure = toFailure(error);
        setRecent(failed(failure.code, failure.message));
      }
    }
  }, [api, me.role]);

  useEffect(() => {
    void refresh();
    return () => {
      seq.current += 1; // invalidate in-flight responses on unmount
    };
  }, [refresh]);

  // Recompute the pill when the shared connection state changes.
  useEffect(() => {
    const timer = setInterval(() => setConnTick((t) => t + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Recomputed when connTick bumps (initial load, refresh, periodic interval).
  const conn = useMemo(() => connectionStatus(getConnectionState(), Date.now()), [connTick]);

  const metrics = state.status === "loaded" ? summarize(state.data.upstreams, state.data.tools) : null;

  return (
    <section aria-labelledby="overview-heading">
      <div className="row space-between page-head">
        <div>
          <h1 id="overview-heading">Overview</h1>
          <p className="muted">
            Signed in as <strong>{me.display_name}</strong> · <Badge tone={me.role === "admin" ? "admin" : "member"}>{roleLabel(me.role)}</Badge>
          </p>
        </div>
        <div className="row">
          <span className={`badge badge-${conn.tone === "success" ? "success" : conn.tone === "warn" ? "warn" : "neutral"}`} title="Derived from real API responses — the gateway has no separate dashboard health endpoint">
            {conn.label}
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={state.status === "loading"}>
            Refresh
          </button>
        </div>
      </div>

      {lastRefreshedAt !== null && (
        <p className="muted small">Last refreshed {formatLocalTime(new Date(lastRefreshedAt).toISOString())}</p>
      )}

      {state.status === "error" && (
        <ErrorBanner
          message={
            state.code === "gateway_unreachable"
              ? "Gateway unreachable — metrics could not be loaded."
              : `Could not load overview: ${state.message}`
          }
          onRetry={() => void refresh()}
        />
      )}

      {state.status === "loading" && <Skeleton rows={4} />}

      {metrics !== null && (
        <>
          <div className="cards metrics-cards">
            <article className="card metric">
              <h2>Upstreams</h2>
              <p className="metric-value">
                {metrics.configured}
                <span className="metric-sub"> configured</span>
              </p>
              <ul className="metric-list">
                <li>
                  <Badge tone="success">{metrics.enabled} enabled</Badge>
                </li>
                <li>
                  <Badge tone="neutral">{metrics.reachable} reachable</Badge>
                </li>
                <li>
                  <Badge tone={metrics.unreachable > 0 ? "error" : "neutral"}>{metrics.unreachable} unreachable</Badge>
                </li>
              </ul>
            </article>

            <article className="card metric">
              <h2>Discovered tools</h2>
              <p className="metric-value">{metrics.totalTools}</p>
              <ul className="metric-list">
                {metrics.grouped.map((entry) => (
                  <li key={entry.id} className="small muted">
                    {upstreamLabel(entry.id)}: {entry.tools.length}
                  </li>
                ))}
              </ul>
            </article>

            <article className="card">
              <h2>Server status</h2>
              <ul className="status-list">
                {metrics.grouped.map((entry) => {
                  const health = upstreamHealth(entry.status);
                  return (
                    <li key={entry.id}>
                      <Badge tone={health === "healthy" ? "success" : health === "degraded" ? "error" : health === "disabled" ? "neutral" : "warn"}>
                        {health}
                      </Badge>
                      <span className="status-name">{upstreamLabel(entry.id)}</span>
                      <span className="muted small">{entry.tools.length} tools</span>
                    </li>
                  );
                })}
              </ul>
            </article>
          </div>

          <div className="cards">
            <article className="card">
              <h2>Recent activity</h2>
              {me.role !== "admin" && (
                <p className="muted">The audit log requires the admin role (enforced server-side). Ask an admin for access.</p>
              )}
              {me.role === "admin" && recent.status === "loading" && <Skeleton rows={3} />}
              {me.role === "admin" && recent.status === "error" && <ErrorBanner message={recent.message} onRetry={() => void refresh()} />}
              {me.role === "admin" && recent.status === "empty" && <p className="muted">No audit entries yet.</p>}
              {me.role === "admin" && recent.status === "loaded" && (
                <ul className="status-list">
                  {recent.data.map((row) => (
                    <li key={row.id}>
                      <Badge tone={outcomeTone(row.outcome)}>{row.outcome}</Badge>
                      <span className="status-name">{row.action}</span>
                      <span className="muted small" title={row.occurred_at}>
                        {formatLocalTime(row.occurred_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="card">
              <h2>Quick links</h2>
              <ul className="quick-links">
                <li>
                  <a href={routeHash("upstreams")}>MCP servers</a>
                </li>
                <li>
                  <a href={routeHash("tools")}>Tool catalogue</a>
                </li>
                <li>
                  <a href={routeHash("chat")}>Chat</a>
                </li>
                {me.role === "admin" && (
                  <li>
                    <a href={routeHash("audit")}>Audit log</a>
                  </li>
                )}
                <li>
                  <a href={routeHash("settings")}>Connection settings</a>
                </li>
              </ul>
            </article>
          </div>
        </>
      )}

      {state.status === "loaded" && metrics !== null && metrics.configured === 0 && (
        <Banner tone="warn">
          No upstreams are configured. Set the gateway&apos;s <code>*_MCP_URL</code> environment variables — the dashboard
          cannot point the gateway at arbitrary addresses.
        </Banner>
      )}
    </section>
  );
}
