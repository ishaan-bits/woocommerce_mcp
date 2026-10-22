import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, MeResponse, ToolsResponse } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";
import { canUseTool, upstreamLabel } from "../lib/permissions.ts";
import { filterTools, toolCountSummary } from "../lib/selectors.ts";
import { Badge, EmptyState, ErrorBanner, Skeleton } from "../components/ui.tsx";

/**
 * Tool catalogue (D6): the same aggregated registry /mcp serves. A search
 * box, an upstream filter and a per-row permission indicator (derived from
 * /api/me, mirroring the gateway's authorization exactly) help members see
 * what they can actually call. The view executes nothing.
 */
export function ToolsPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<ToolsResponse>>(loading());
  const [search, setSearch] = useState("");
  const [upstreamFilter, setUpstreamFilter] = useState("");
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    setState(loading());
    try {
      const response = await api.tools();
      if (id !== seq.current) return;
      setState(loaded(response, response.tools.length === 0));
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

  const principal = useMemo(
    () => ({ role: me.role, allowed_upstreams: me.allowed_upstreams, allowed_tools: me.allowed_tools }),
    [me.role, me.allowed_upstreams, me.allowed_tools],
  );

  const tools = state.status === "loaded" ? state.data.tools : [];
  const shown = useMemo(() => filterTools(tools, { search, upstreamId: upstreamFilter }), [tools, search, upstreamFilter]);
  const degraded =
    state.status === "loaded" ? state.data.upstreams.filter((entry) => !entry.enabled || !entry.reachable) : [];

  return (
    <section aria-labelledby="tools-heading">
      <div className="row space-between page-head">
        <h1 id="tools-heading">Tool catalogue</h1>
        <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={state.status === "loading"}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Aggregated from the gateway registry — the exact list a client sees in <code>tools/list</code>.
      </p>

      <div className="filters card">
        <div className="field field-inline">
          <label htmlFor="tool-search">Search</label>
          <input
            id="tool-search"
            type="search"
            placeholder="name, qualified name or description…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="field field-inline">
          <label htmlFor="tool-upstream">Upstream</label>
          <select id="tool-upstream" value={upstreamFilter} onChange={(event) => setUpstreamFilter(event.target.value)}>
            <option value="">All upstreams</option>
            {(state.status === "loaded" ? state.data.upstreams : []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {upstreamLabel(entry.id)}
              </option>
            ))}
          </select>
        </div>
        <div className="filters-summary">
          <span className="muted small">{state.status === "loaded" ? toolCountSummary(shown.length, tools.length) : "…"}</span>
          {(search !== "" || upstreamFilter !== "") && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSearch("");
                setUpstreamFilter("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && <Skeleton rows={5} />}
        {state.status === "error" && (
          <ErrorBanner
            message={
              state.code === "gateway_unreachable"
                ? "Gateway unreachable — the tool list could not be loaded."
                : `Could not load tools: ${state.message}`
            }
            onRetry={() => void refresh()}
          />
        )}
        {state.status === "loaded" && (
          <>
            {degraded.map((entry) => (
              <p key={entry.id} className="banner banner-warn" role="status">
                Upstream <strong>{upstreamLabel(entry.id)}</strong> is {!entry.enabled ? "disabled" : "unreachable"}
                {entry.last_error !== null ? ` (${entry.last_error})` : ""} — its tools are omitted from discovery.
              </p>
            ))}
            {tools.length === 0 && (
              <EmptyState
                title="No tools are currently published"
                hint="Every upstream may be disabled or unreachable — see the banners above."
              />
            )}
            {tools.length > 0 && shown.length === 0 && (
              <EmptyState title="No tools match the current filters" hint="Try a different search term or upstream." />
            )}
            {shown.length > 0 && (
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Aggregated tool list</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Upstream</th>
                      <th scope="col">Description</th>
                      <th scope="col">Permission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((tool) => {
                      const decision = canUseTool(principal, tool.qualified_name);
                      return (
                        <tr key={tool.qualified_name}>
                          <td>
                            <code>{tool.qualified_name}</code>
                          </td>
                          <td>
                            <span className="badge">{upstreamLabel(tool.upstream_id)}</span>
                          </td>
                          <td>{tool.description !== "" ? tool.description : <span className="muted">—</span>}</td>
                          <td>
                            {decision.allowed ? (
                              <Badge tone="success" title="You may call this tool (server enforces the same rule)">
                                allowed
                              </Badge>
                            ) : (
                              <Badge tone="muted" title={`Server would deny: ${decision.reason ?? "not granted"}`}>
                                not granted
                              </Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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
