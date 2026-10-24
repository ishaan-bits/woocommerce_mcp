import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiClient, IssuedKey, SettingsResponse } from "../api/client.ts";
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
import { CopyableCode, CopyButton } from "../components/CopyButton.tsx";

/**
 * Settings / connection instructions. The MCP endpoint is either the
 * deploy-configured public URL from /api/settings (accurate) or — when null —
 * clearly-labelled EXAMPLES that are never presented as confirmed. No key is
 * ever embedded; snippets carry a <YOUR_KEY> placeholder. Members can issue
 * their own API key here (self-serve, M1/X4); admins manage everyone's keys
 * on the Team page.
 */
export function SettingsPage({ api }: { api: ApiClient }) {
  const [state, setState] = useState<LoadState<SettingsResponse>>(loading());
  const [myKeys, setMyKeys] = useState<
    LoadState<{ keys: Array<{ id: string; key_prefix: string; created_at: string; revoked_at: string | null }> }>
  >(loading());
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const seq = useRef(0);
  const keySeq = useRef(0);

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

  const refreshKeys = useCallback(async () => {
    const id = ++keySeq.current;
    setMyKeys(loading());
    try {
      const response = await api.myKeys();
      if (id !== keySeq.current) return;
      setMyKeys(loaded(response));
    } catch (error) {
      if (id !== keySeq.current) return;
      const failure = toFailure(error);
      setMyKeys(failed(failure.code, failure.message));
    }
  }, [api]);

  const issueKey = useCallback(async () => {
    setIssuing(true);
    setIssueError(null);
    try {
      const key = await api.issueMyKey();
      setIssued(key);
      await refreshKeys();
    } catch (error) {
      const failure = toFailure(error);
      setIssueError(failure.message);
    } finally {
      setIssuing(false);
    }
  }, [api, refreshKeys]);

  useEffect(() => {
    void refresh();
    void refreshKeys();
    return () => {
      seq.current += 1;
      keySeq.current += 1;
    };
  }, [refresh, refreshKeys]);

  return (
    <section aria-labelledby="settings-heading">
      <div className="row space-between page-head">
        <div>
          <p className="eyebrow">Help</p>
          <h1 id="settings-heading">Settings</h1>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={state.status === "loading"}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Connection instructions for external MCP clients. One gateway <code>/mcp</code> endpoint serves every upstream;
        tools are addressed by qualified name (e.g. <code>woocommerce_list_products</code>). Issue your own API key
        below; admins manage every member&apos;s keys in <a href={routeHash("team")}>Team &amp; API keys</a>.
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

          <article className="card stack">
            <h2>Your API keys</h2>
            <p className="muted small">
              Keys authenticate external MCP clients as <strong>you</strong> (your role and grants apply). The full key
              is shown once when created — copy it now; it is never displayed again.
            </p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => void issueKey()} disabled={issuing}>
                {issuing ? "Issuing…" : "Create API key"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void refreshKeys()}
                disabled={myKeys.status === "loading"}
              >
                Refresh
              </button>
            </div>
            {issueError !== null && <ErrorBanner message={issueError} onRetry={() => void issueKey()} />}
            {issued !== null && (
              <div className="stack" role="alert">
                <p className="banner banner-warn">
                  Copy this key now — it is shown <strong>only once</strong>. Treat it like a password.
                </p>
                <div className="row">
                  <code className="endpoint" data-testid="issued-key">
                    {issued.key}
                  </code>
                  <CopyButton value={issued.key} label="Copy key" />
                </div>
              </div>
            )}
            {myKeys.status === "loading" && <Skeleton rows={2} />}
            {myKeys.status === "error" && (
              <ErrorBanner
                message={myKeys.code === "gateway_unreachable" ? "Gateway unreachable — keys could not be loaded." : myKeys.message}
                onRetry={() => void refreshKeys()}
              />
            )}
            {myKeys.status === "loaded" &&
              (myKeys.data.keys.length === 0 ? (
                <p className="muted">No keys yet — create one to connect an external client.</p>
              ) : (
                <ul className="example-list">
                  {myKeys.data.keys.map((key) => (
                    <li key={key.id}>
                      <code>{key.key_prefix}…</code>{" "}
                      {key.revoked_at === null ? (
                        <Badge tone="success">active</Badge>
                      ) : (
                        <Badge tone="neutral">revoked</Badge>
                      )}{" "}
                      <span className="muted small">created {new Date(key.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              ))}
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
