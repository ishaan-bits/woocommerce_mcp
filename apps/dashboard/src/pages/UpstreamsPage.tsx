import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, MeResponse, ToolView, UpstreamStatusView } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";
import { formatLocalTime } from "../lib/audit.ts";
import { sanitizeError, upstreamHealth, upstreamHealthText, upstreamHealthTone, groupToolsByUpstream } from "../lib/selectors.ts";
import { roleLabel, storeModeLabel, upstreamLabel } from "../lib/permissions.ts";
import { Badge, Banner, EmptyState, ErrorBanner, Skeleton } from "../components/ui.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

interface ServersData {
  upstreams: UpstreamStatusView[];
  tools: ToolView[];
}

/**
 * MCP servers (D24): status for every fixed upstream id, expandable tool
 * lists, and — for admins — enable/disable behind a confirmation dialog.
 * The registry is deploy-time config: add/edit/remove of servers is
 * intentionally not offered here.
 */
export function UpstreamsPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<ServersData>>(loading());
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; enable: boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    setState(loading());
    try {
      const [upstreamRes, toolsRes] = await Promise.all([api.upstreams(), api.tools()]);
      if (id !== seq.current) return;
      setState(loaded({ upstreams: upstreamRes.upstreams, tools: toolsRes.tools }));
      setCheckedAt(Date.now());
    } catch (error) {
      if (id !== seq.current) return;
      const failure = toFailure(error);
      setState(failed(failure.code, failure.message));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    return () => {
      seq.current += 1;
    };
  }, [refresh]);

  const applyToggle = async (id: string, enable: boolean): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    setActionOk(null);
    const myTurn = ++seq.current;
    try {
      const result = await api.setUpstream(id, enable);
      if (myTurn !== seq.current) return;
      setActionOk(
        result.changed
          ? `${upstreamLabel(id)} is now ${enable ? "enabled" : "disabled"} (persisted; audit row written).`
          : `${upstreamLabel(id)} was already ${enable ? "enabled" : "disabled"}.`,
      );
    } catch (error) {
      if (myTurn !== seq.current) return;
      const failure = toFailure(error);
      setActionError(
        failure.code === "forbidden"
          ? "Not permitted — the gateway rejected this toggle (role checked server-side)."
          : failure.message,
      );
    } finally {
      setBusyId(null);
      setConfirm(null);
      await refresh();
    }
  };

  return (
    <section aria-labelledby="servers-heading">
      <div className="row space-between page-head">
        <h1 id="servers-heading">MCP servers</h1>
        <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={state.status === "loading"}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Servers are registered at deploy time via the gateway&apos;s <code>*_MCP_URL</code> environment — adding, editing or
        removing them from this dashboard is intentionally not offered.
      </p>
      {checkedAt !== null && (
        <p className="muted small">Last checked {formatLocalTime(new Date(checkedAt).toISOString())}</p>
      )}

      {actionOk !== null && <Banner tone="ok">{actionOk}</Banner>}
      {actionError !== null && <Banner tone="error" role="alert">{actionError}</Banner>}

      {me.role !== "admin" && (
        <Banner tone="info" role="note">
          You are signed in as <strong>{roleLabel(me.role)}</strong>: enable/disable controls are hidden here and the
          gateway would refuse them with 403 anyway (every admin action is checked and audited server-side).
        </Banner>
      )}

      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && <Skeleton rows={4} />}
        {state.status === "error" && (
          <ErrorBanner
            message={state.code === "gateway_unreachable" ? "Gateway unreachable — server status could not be loaded." : state.message}
            onRetry={() => void refresh()}
          />
        )}
        {state.status === "empty" && (
          <EmptyState
            title="No servers registered"
            hint="Set the *_MCP_URL variables on the gateway to register a server."
          />
        )}
        {state.status === "loaded" &&
          groupToolsByUpstream(state.data.upstreams, state.data.tools).map((entry) => {
            const health = upstreamHealth(entry.status);
            const tone = upstreamHealthTone(health);
            const isOpen = expanded === entry.id;
            const modeLabel = storeModeLabel(entry.status.mode);
            const errorText = sanitizeError(entry.status.last_error);
            return (
              <article key={entry.id} className="card server-card">
                <div className="row space-between">
                  <div className="row">
                    <h2 className="server-name">{upstreamLabel(entry.id)}</h2>
                    <Badge tone={tone === "success" ? "success" : tone === "error" ? "error" : tone === "neutral" ? "neutral" : "warn"}>
                      {upstreamHealthText(entry.status)}
                    </Badge>
                    {modeLabel !== null && (
                      <Badge tone={modeLabel === "Demo mock store" ? "info" : "success"} title="Backing store label (deploy-time configuration)">
                        {modeLabel}
                      </Badge>
                    )}
                    <span className="muted small">{entry.tools.length} tools</span>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-expanded={isOpen}
                      aria-controls={`server-tools-${entry.id}`}
                      onClick={() => setExpanded(isOpen ? null : entry.id)}
                    >
                      {isOpen ? "Hide tools" : "Show tools"}
                    </button>
                    {me.role === "admin" && entry.status.configured && (
                      <button
                        type="button"
                        className={entry.status.enabled ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
                        disabled={busyId === entry.id}
                        onClick={() => setConfirm({ id: entry.id, enable: !entry.status.enabled })}
                        aria-label={`${entry.status.enabled ? "Disable" : "Enable"} ${upstreamLabel(entry.id)}`}
                      >
                        {busyId === entry.id ? "Applying…" : entry.status.enabled ? "Disable" : "Enable"}
                      </button>
                    )}
                  </div>
                </div>
                {errorText !== null && (
                  <p className="small error-text server-error" title={entry.status.last_error ?? undefined}>
                    Last error: {errorText}
                  </p>
                )}
                {entry.status.configured && (
                  <p className="muted small">Status as of this page load — refresh to re-check.</p>
                )}
                <div id={`server-tools-${entry.id}`} hidden={!isOpen}>
                  {entry.tools.length === 0 ? (
                    <p className="muted small">No tools discovered (server disabled or unreachable).</p>
                  ) : (
                    <ul className="tool-mini-list">
                      {entry.tools.map((tool) => (
                        <li key={tool.qualified_name}>
                          <code>{tool.name}</code>
                          <span className="muted small">{tool.description !== "" ? tool.description : "no description"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            );
          })}
      </div>

      {confirm !== null && (
        <ConfirmDialog
          title={`${confirm.enable ? "Enable" : "Disable"} ${upstreamLabel(confirm.id)}?`}
          danger={!confirm.enable}
          busy={busyId !== null}
          message={
            <>
              <p>
                {confirm.enable
                  ? "Enabling this server makes its tools discoverable again (tools/list) and callable through /mcp and chat."
                  : "Disabling this server removes its tools from discovery immediately, and calls to them will be rejected."}
              </p>
              <p className="muted small">
                The change is persisted (survives a gateway restart) and audited. Clients may need to re-run discovery to
                see the updated tool list.
              </p>
            </>
          }
          confirmLabel={confirm.enable ? "Enable server" : "Disable server"}
          onConfirm={() => void applyToggle(confirm.id, confirm.enable)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
