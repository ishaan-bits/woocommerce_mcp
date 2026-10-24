import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, MeResponse, ToolView, UpstreamStatusView } from "../api/client.ts";
import { failed, loaded, loading, projectAuditRows, toFailure, type AuditRowView, type LoadState } from "../state.ts";
import { connectionStatus, getConnectionState } from "../lib/connection.ts";
import { routeHash } from "../lib/routes.ts";
import { groupToolsByUpstream, upstreamHealth } from "../lib/selectors.ts";
import { roleLabel, upstreamLabel } from "../lib/permissions.ts";
import { formatLocalTime, outcomeTone } from "../lib/audit.ts";
import { Badge, ErrorBanner, Skeleton } from "../components/ui.tsx";

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
  const disabled = configured - enabled;
  const grouped = groupToolsByUpstream(upstreams, tools);
  return { configured, enabled, reachable, unreachable, disabled, totalTools: tools.length, grouped };
}

function MetricCard({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "success" | "warn" | "danger" }) {
  return (
    <article className={`metric-card${tone !== undefined ? ` tone-${tone}` : ""}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {sub !== undefined && <span className="metric-sub">{sub}</span>}
    </article>
  );
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
    <section aria-labelledby="overview-heading" className="stack loose">
      <div className="row space-between page-head">
        <div>
          <p className="eyebrow">MCP control plane</p>
          <h1 id="overview-heading">Overview</h1>
          <p className="muted">
            Signed in as <strong>{me.display_name}</strong>{" "}
            <Badge tone={me.role === "admin" ? "admin" : "member"}>{roleLabel(me.role)}</Badge>
          </p>
        </div>
        <div className="row">
          <span
            className={`health-chip ${conn.tone === "success" ? "is-healthy" : conn.tone === "warn" ? "is-warn" : ""}`}
            title="Derived from real API responses — the gateway has no separate dashboard health endpoint"
          >
            <span className={`status-dot ${conn.tone === "success" ? "is-healthy" : conn.tone === "warn" ? "is-error" : ""}`} aria-hidden="true" />
            {conn.label}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={state.status === "loading"}>
            {state.status === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {lastRefreshedAt !== null && (
        <p className="muted tiny">Last refreshed {formatLocalTime(new Date(lastRefreshedAt).toISOString())}</p>
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
          <div className="grid cols-4" aria-label="Key metrics">
            <MetricCard
              label="Upstream servers"
              value={metrics.configured}
              sub={`${metrics.enabled} enabled${metrics.disabled > 0 ? ` · ${metrics.disabled} disabled` : ""}`}
            />
            <MetricCard
              label="Reachable now"
              value={metrics.reachable}
              tone={metrics.unreachable > 0 ? "warn" : "success"}
              sub={metrics.unreachable > 0 ? `${metrics.unreachable} unreachable` : "all enabled servers responding"}
            />
            <MetricCard
              label="Discovered tools"
              value={metrics.totalTools}
              sub={metrics.grouped.length > 0 ? `across ${metrics.grouped.length} servers` : "no servers discovered"}
            />
            <MetricCard
              label="Recent audit events"
              value={me.role === "admin" && recent.status === "loaded" ? recent.data.length : "—"}
              sub={me.role === "admin" ? "latest 10 actions" : "admin role required"}
            />
          </div>

          <div className="grid cols-2">
            <article className="card">
              <div className="row space-between">
                <h2>Server health</h2>
                <a className="small" href={routeHash("upstreams")}>Manage</a>
              </div>
              <ul className="status-list">
                {metrics.grouped.map((entry) => {
                  const health = upstreamHealth(entry.status);
                  return (
                    <li key={entry.id} className="row space-between" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8, gap: 12 }}>
                      <span className="row tight">
                        <span
                          className={`status-dot ${health === "healthy" ? "is-healthy" : health === "degraded" ? "is-error" : health === "disabled" ? "is-off" : "is-warn"}`}
                          aria-hidden="true"
                        />
                        <span className="status-name">{upstreamLabel(entry.id)}</span>
                        <Badge tone={health === "healthy" ? "success" : health === "degraded" ? "error" : health === "disabled" ? "muted" : "warn"}>
                          {health}
                        </Badge>
                      </span>
                      <span className="muted small">{entry.tools.length} tool{entry.tools.length === 1 ? "" : "s"}</span>
                    </li>
                  );
                })}
                {metrics.grouped.length === 0 && (
                  <li className="muted">No upstreams discovered yet.</li>
                )}
              </ul>
            </article>

            <article className="card">
              <div className="row space-between">
                <h2>Recent activity</h2>
                {me.role === "admin" && (
                  <a className="small" href={routeHash("audit")}>Audit log</a>
                )}
              </div>
              {me.role !== "admin" && (
                <p className="muted">The audit log requires the admin role (enforced server-side). Ask an admin for access.</p>
              )}
              {me.role === "admin" && recent.status === "loading" && <Skeleton rows={3} />}
              {me.role === "admin" && recent.status === "error" && <ErrorBanner message={recent.message} onRetry={() => void refresh()} />}
              {me.role === "admin" && recent.status === "empty" && <p className="muted">No audit entries yet.</p>}
              {me.role === "admin" && recent.status === "loaded" && (
                <ul className="status-list">
                  {recent.data.map((row) => (
                    <li key={row.id} className="row space-between" style={{ gap: 12 }}>
                      <span className="row tight">
                        <Badge tone={outcomeTone(row.outcome)}>{row.outcome}</Badge>
                        <span className="status-name">{row.action}</span>
                      </span>
                      <span className="muted tiny" title={row.occurred_at}>
                        {formatLocalTime(row.occurred_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </div>

          <article className="card">
            <h2>Quick links</h2>
            <ul className="quick-links">
              <li>
                <a className="btn btn-secondary btn-sm" href={routeHash("upstreams")}>MCP servers</a>
              </li>
              <li>
                <a className="btn btn-secondary btn-sm" href={routeHash("tools")}>Tool catalogue</a>
              </li>
              <li>
                <a className="btn btn-secondary btn-sm" href={routeHash("chat")}>AI chat</a>
              </li>
              {me.role === "admin" && (
                <li>
                  <a className="btn btn-secondary btn-sm" href={routeHash("audit")}>Audit log</a>
                </li>
              )}
              <li>
                <a className="btn btn-secondary btn-sm" href={routeHash("settings")}>Connection settings</a>
              </li>
            </ul>
          </article>
        </>
      )}

      {state.status === "loaded" && metrics !== null && metrics.configured === 0 && (
        <div className="banner banner-warn" role="status">
          <p>
            No upstreams are configured. Set the gateway&apos;s <code>*_MCP_URL</code> environment variables — the dashboard
            cannot point the gateway at arbitrary addresses.
          </p>
        </div>
      )}
    </section>
  );
}
