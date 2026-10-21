import { useCallback, useEffect, useState } from "react";
import type { ApiClient, ToolsResponse } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";

/**
 * Tool list mirror (D6): the same aggregated registry /mcp serves. Degraded
 * upstreams are surfaced as banners (never silently hidden), and the view
 * executes nothing — tool calls only ever happen through /mcp.
 */
export function ToolsPage({ api }: { api: ApiClient }) {
  const [state, setState] = useState<LoadState<ToolsResponse>>(loading());

  const refresh = useCallback(async () => {
    setState(loading());
    try {
      const response = await api.tools();
      setState(loaded(response));
    } catch (error) {
      const failure = toFailure(error);
      setState(failed(failure.code, failure.message));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const degraded = state.status === "loaded" ? state.data.upstreams.filter((entry) => !entry.enabled || !entry.reachable) : [];

  return (
    <section aria-labelledby="tools-heading">
      <div className="row space-between">
        <h1 id="tools-heading">Tools</h1>
        <button type="button" className="ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Aggregated from the gateway registry — the exact list a client sees in <code>tools/list</code>.
      </p>

      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && (
          <p className="muted" role="status">
            Discovering tools…
          </p>
        )}
        {state.status === "error" && (
          <div className="banner banner-error" role="alert">
            <p>
              {state.code === "gateway_unreachable"
                ? "Gateway unreachable — the tool list could not be loaded."
                : `Could not load tools: ${state.message}`}
            </p>
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        {state.status === "loaded" && (
          <>
            {degraded.map((entry) => (
              <p key={entry.id} className="banner banner-warn" role="status">
                Upstream <strong>{entry.id}</strong> is {!entry.enabled ? "disabled" : "unreachable"}
                {entry.last_error !== null ? ` (${entry.last_error})` : ""} — its tools are omitted from the list.
              </p>
            ))}
            {state.data.tools.length === 0 ? (
              <div className="empty-state">
                <p>No tools are currently published.</p>
                <p className="muted">Every upstream may be disabled or unreachable — see the banners above.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Aggregated tool list</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Upstream</th>
                      <th scope="col">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data.tools.map((tool) => (
                      <tr key={tool.qualified_name}>
                        <td>
                          <code>{tool.qualified_name}</code>
                        </td>
                        <td>
                          <span className="badge">{tool.upstream_id}</span>
                        </td>
                        <td>{tool.description.length > 0 ? tool.description : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
