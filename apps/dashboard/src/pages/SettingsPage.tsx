import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiClient, SettingsResponse } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";
import {
  ENDPOINT_EXAMPLES,
  confirmedEndpoint,
  curlSnippet,
  inspectorSnippet,
  isExampleEndpoint,
  jsonClientSnippet,
} from "../lib/settings.ts";
import { isLocalEndpoint } from "../lib/permissions.ts";
import { routeHash } from "../lib/routes.ts";
import { Badge, ErrorBanner, Skeleton } from "../components/ui.tsx";
import { CopyableCode } from "../components/CopyButton.tsx";

/**
 * Settings / connection instructions. The MCP endpoint is either the
 * deploy-configured public URL from /api/settings (accurate) or — when null —
 * clearly-labelled EXAMPLES that are never presented as confirmed. No key is
 * ever embedded; snippets carry a <YOUR_KEY> placeholder.
 */
export function SettingsPage({ api }: { api: ApiClient }) {
  const [state, setState] = useState<LoadState<SettingsResponse>>(loading());
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    setState(loading());
    try {
      const settings = await api.settings();
      if (id !== seq.current) return;
      setState(loaded(settings));
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

  return (
    <section aria-labelledby="settings-heading">
      <div className="row space-between page-head">
        <h1 id="settings-heading">Settings</h1>
        <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={state.status === "loading"}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Connection instructions for external MCP clients. One gateway <code>/mcp</code> endpoint serves every upstream;
        tools are addressed by qualified name (e.g. <code>woocommerce_list_products</code>). Keys are issued in{" "}
        <a href={routeHash("team")}>Team &amp; API keys</a>.
      </p>

      {state.status === "loading" && <Skeleton rows={4} />}
      {state.status === "error" && (
        <ErrorBanner
          message={state.code === "gateway_unreachable" ? "Gateway unreachable — settings could not be loaded." : state.message}
          onRetry={() => void refresh()}
        />
      )}

      {state.status === "loaded" && (
        <div className="stack">
          <article className="card stack">
            <h2>MCP endpoint</h2>
            {confirmedEndpoint(state.data) !== null ? (
              <>
                <p className="row">
                  <code className="endpoint">{confirmedEndpoint(state.data)}</code>
                  {isLocalEndpoint(state.data.mcp_endpoint) && (
                    <Badge tone="warn" title="This address is only reachable from this machine">
                      local only
                    </Badge>
                  )}
                </p>
                <p className="muted small">
                  Published by the gateway&apos;s <code>GATEWAY_PUBLIC_URL</code> configuration — transport{" "}
                  <code>{state.data.transport}</code>, path <code>{state.data.mcp_path}</code>, session header{" "}
                  <code>{state.data.session_header}</code>.
                </p>
              </>
            ) : (
              <>
                <BannerLike>
                  The gateway has not published a public endpoint (<code>GATEWAY_PUBLIC_URL</code> is unset). Use your
                  gateway&apos;s address — <strong>these are examples, not a confirmed URL</strong>:
                </BannerLike>
                <ul className="example-list">
                  {ENDPOINT_EXAMPLES.map((example) => (
                    <li key={example}>
                      <code>{example}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted small">
              Auth: <strong>Bearer</strong> — send <code>Authorization: Bearer &lt;YOUR_KEY&gt;</code> on every request.
            </p>
          </article>

          <article className="card stack">
            <h2>curl</h2>
            <CopyableCode label="POST initialize" value={curlSnippet(state.data)} />
          </article>

          <article className="card stack">
            <h2>MCP Inspector</h2>
            <CopyableCode label="CLI" value={inspectorSnippet(state.data)} />
          </article>

          <article className="card stack">
            <h2>Generic JSON client config</h2>
            <CopyableCode label="config fragment" value={jsonClientSnippet(state.data)} />
          </article>

          <article className="card stack">
            <h2>Chat</h2>
            {state.data.chat_enabled ? (
              <p>
                <Badge tone="success">enabled</Badge> The in-dashboard chat agent is configured on this gateway.{" "}
                <a href={routeHash("chat")}>Open chat</a>.
              </p>
            ) : (
              <p className="muted">
                <Badge tone="neutral">not configured</Badge> No LLM provider is set on the gateway, so the chat page
                shows a setup banner instead of generating anything.
              </p>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

function BannerLike({ children }: { children: ReactNode }) {
  return (
    <p className="banner banner-warn" role="note">
      {children}
    </p>
  );
}
