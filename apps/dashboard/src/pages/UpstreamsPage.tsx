import { useCallback, useEffect, useState } from "react";
import type { ApiClient, MeResponse, UpstreamStatusView } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";

/**
 * Upstream management (D24): status for every fixed upstream id, and — for
 * admins — enable/disable controls. Hiding the button from readers is pure
 * cosmetics; the real enforcement is server-side (403 + access_denied audit
 * row), and a toggle can only target configured registry ids (the server
 * answers 400/409 otherwise), never an arbitrary URL.
 */
export function UpstreamsPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<UpstreamStatusView[]>>(loading());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState(loading());
    try {
      const response = await api.upstreams();
      setState(loaded(response.upstreams, response.upstreams.length === 0));
    } catch (error) {
      const failure = toFailure(error);
      setState(failed(failure.code, failure.message));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    setActionOk(null);
    try {
      const result = await api.setUpstream(id, enabled);
      setActionOk(
        result.changed
          ? `${id} is now ${enabled ? "enabled" : "disabled"} (persisted; audit row written).`
          : `${id} was already ${enabled ? "enabled" : "disabled"}.`,
      );
    } catch (error) {
      const failure = toFailure(error);
      setActionError(
        failure.code === "forbidden"
          ? "Not permitted — the gateway rejected this toggle (role checked server-side)."
          : failure.message,
      );
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  return (
    <section aria-labelledby="upstreams-heading">
      <div className="row space-between">
        <h1 id="upstreams-heading">Upstreams</h1>
        <button type="button" className="ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Toggles are admin-only, validated against the fixed upstream registry, and persisted (they survive a gateway
        restart). Unconfigured upstreams need their <code>*_MCP_URL</code> environment variable — the dashboard cannot
        point the gateway at arbitrary addresses.
      </p>

      {actionOk !== null && (
        <p className="banner banner-ok" role="status">
          {actionOk}
        </p>
      )}
      {actionError !== null && (
        <p className="banner banner-error" role="alert">
          {actionError}
        </p>
      )}

      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && (
          <p className="muted" role="status">
            Loading upstream status…
          </p>
        )}
        {state.status === "error" && (
          <div className="banner banner-error" role="alert">
            <p>{state.message}</p>
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        {state.status === "empty" && <p className="muted">No upstreams configured — set the *_MCP_URL variables.</p>}
        {state.status === "loaded" && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Upstream status and controls</caption>
              <thead>
                <tr>
                  <th scope="col">Upstream</th>
                  <th scope="col">Configured</th>
                  <th scope="col">Enabled</th>
                  <th scope="col">Reachable</th>
                  <th scope="col">Last error</th>
                  {me.role === "admin" && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {state.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <code>{entry.id}</code>
                    </td>
                    <td>{entry.configured ? "yes" : "no"}</td>
                    <td>
                      <span className={`badge ${entry.enabled ? "badge-ok" : "badge-warn"}`}>
                        {entry.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td>{entry.configured ? (entry.reachable ? "yes" : "no") : "—"}</td>
                    <td className="small">{entry.last_error ?? "—"}</td>
                    {me.role === "admin" && (
                      <td>
                        {entry.configured ? (
                          <button
                            type="button"
                            disabled={busyId === entry.id}
                            onClick={() => void toggle(entry.id, !entry.enabled)}
                            aria-label={`${entry.enabled ? "Disable" : "Enable"} upstream ${entry.id}`}
                          >
                            {busyId === entry.id
                              ? "Applying…"
                              : entry.enabled
                                ? "Disable"
                                : "Enable"}
                          </button>
                        ) : (
                          <span className="muted small">not configured</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {me.role !== "admin" && (
        <p className="banner banner-warn" role="note">
          Your account is a reader: toggles are disabled here, and the gateway would refuse them with 403 anyway
          (every admin action is checked and audited server-side).
        </p>
      )}
    </section>
  );
}
