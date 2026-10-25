import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, MeResponse, ToolView, UpstreamStatusView } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";
import { formatLocalTime } from "../lib/audit.ts";
import { sanitizeError, upstreamHealth, upstreamHealthText, upstreamHealthTone, groupToolsByUpstream, upstreamStatsSummary } from "../lib/selectors.ts";
import { roleLabel, storeModeLabel, upstreamLabel } from "../lib/permissions.ts";
import { Badge, Banner, EmptyState, ErrorBanner, Skeleton } from "../components/ui.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

interface ServersData {
  upstreams: UpstreamStatusView[];
  tools: ToolView[];
}

interface UpstreamFormState {
  name: string;
  url: string;
  enabled: boolean;
  /** none = no credential; bearer/header = replace; clear = remove on edit. */
  credentialMode: "none" | "bearer" | "header" | "clear";
  credentialValue: string;
  credentialHeader: string;
}

const EMPTY_FORM: UpstreamFormState = {
  name: "",
  url: "",
  enabled: true,
  credentialMode: "none",
  credentialValue: "",
  credentialHeader: "",
};

function formForEdit(row: UpstreamStatusView): UpstreamFormState {
  return {
    name: row.name ?? row.id,
    url: row.url ?? "",
    enabled: row.enabled,
    // The stored credential's value is never sent to the browser; "keep"
    // (omit the field) is the default, "clear" sends null.
    credentialMode: "none",
    credentialValue: "",
    credentialHeader: "",
  };
}

function credentialPayload(
  form: UpstreamFormState,
  editing: boolean,
): { mode: "bearer" | "header"; value: string; header?: string } | null | undefined {
  if (form.credentialMode === "none") {
    // On edit, omitting the field keeps the stored credential unchanged.
    return editing ? undefined : undefined;
  }
  if (form.credentialMode === "clear") {
    return null;
  }
  return form.credentialMode === "header"
    ? { mode: "header", value: form.credentialValue, header: form.credentialHeader }
    : { mode: "bearer", value: form.credentialValue };
}

function healthDot(health: "healthy" | "degraded" | "disabled" | "unknown" | "missing"): string {
  return health === "healthy"
    ? "is-healthy"
    : health === "degraded"
      ? "is-error"
      : health === "disabled"
        ? "is-off"
        : "is-warn";
}

/**
 * MCP servers (D24 + M11/D34): status for every upstream, expandable tool
 * lists, and — for admins — enable/disable plus add/edit/remove of
 * admin-registered servers (URL + optional static credential, encrypted
 * server-side). Fixed deploy-time servers (WooCommerce / Inventory /
 * Support) stay env-configured: their ids answer 409 on edit/delete.
 */
export function UpstreamsPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [state, setState] = useState<LoadState<ServersData>>(loading());
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; enable: boolean } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<UpstreamStatusView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<"add" | "edit" | null>(null);
  const [editRow, setEditRow] = useState<UpstreamStatusView | null>(null);
  const [form, setForm] = useState<UpstreamFormState>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    setState(loading());
    try {
      const [upstreamRes, toolsRes] = await Promise.all([api.upstreams(true), api.tools()]);
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

  const openAdd = (): void => {
    setForm(EMPTY_FORM);
    setEditRow(null);
    setFormError(null);
    setFormOpen("add");
  };

  const openEdit = (row: UpstreamStatusView): void => {
    setForm(formForEdit(row));
    setEditRow(row);
    setFormError(null);
    setFormOpen("edit");
  };

  const submitForm = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFormBusy(true);
    setFormError(null);
    setActionError(null);
    setActionOk(null);
    try {
      const credential = credentialPayload(form, formOpen === "edit");
      if (formOpen === "edit" && editRow !== null) {
        const updated = await api.updateUpstream(editRow.id, {
          name: form.name,
          url: form.url,
          enabled: form.enabled,
          ...(credential === undefined ? {} : { credential }),
        });
        setActionOk(`${upstreamLabel(updated.id, updated.name)} was updated (audit row written).`);
      } else {
        const created = await api.createUpstream({
          name: form.name,
          url: form.url,
          enabled: form.enabled,
          ...(credential === undefined || credential === null ? {} : { credential }),
        });
        setActionOk(`${upstreamLabel(created.id, created.name)} was registered and is live (audit row written).`);
      }
      setFormOpen(null);
      setEditRow(null);
    } catch (error) {
      const failure = toFailure(error);
      setFormError(
        failure.code === "forbidden"
          ? "Not permitted — only admins may register upstreams (checked and audited server-side)."
          : failure.message,
      );
    } finally {
      setFormBusy(false);
      await refresh();
    }
  };

  const removeServer = async (row: UpstreamStatusView): Promise<void> => {
    setBusyId(row.id);
    setActionError(null);
    setActionOk(null);
    try {
      await api.deleteUpstream(row.id);
      setActionOk(`${upstreamLabel(row.id, row.name)} was removed; its tools no longer appear in tools/list.`);
    } catch (error) {
      const failure = toFailure(error);
      setActionError(failure.message);
    } finally {
      setBusyId(null);
      setRemoveConfirm(null);
      await refresh();
    }
  };

  return (
    <section aria-labelledby="servers-heading" className="stack">
      <div className="row space-between page-head">
        <div>
          <p className="eyebrow">Infrastructure</p>
          <h1 id="servers-heading">MCP servers</h1>
          <p className="muted">
            Upstream discovery, health and registration. The three built-in servers are deploy-time configured; admins
            can register more by URL with an optional static credential (encrypted by the gateway, never shown again).
          </p>
        </div>
        <div className="row">
          {me.role === "admin" && formOpen === null && (
            <button type="button" className="btn btn-primary" onClick={openAdd}>
              <svg className="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Add server
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={state.status === "loading"}>
            {state.status === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {checkedAt !== null && (
        <p className="muted tiny">Last checked {formatLocalTime(new Date(checkedAt).toISOString())}</p>
      )}

      {actionOk !== null && <Banner tone="ok">{actionOk}</Banner>}
      {actionError !== null && <Banner tone="error" role="alert">{actionError}</Banner>}

      {me.role !== "admin" && (
        <Banner tone="info" role="note">
          You are signed in as <strong>{roleLabel(me.role)}</strong>: management controls are hidden here and the
          gateway would refuse them with 403 anyway (every admin action is checked and audited server-side).
        </Banner>
      )}

      {me.role === "admin" && formOpen !== null && (
        <form className="card" aria-label={formOpen === "add" ? "Add upstream server" : "Edit upstream server"} onSubmit={(event) => void submitForm(event)}>
          <h2>{formOpen === "add" ? "Add MCP server" : `Edit ${upstreamLabel(editRow?.id ?? "", editRow?.name)}`}</h2>
          {formError !== null && (
            <Banner tone="error" role="alert">
              {formError}
            </Banner>
          )}
          <div className="field">
            <label htmlFor="upstream-name">
              Name <span className="muted small">· 3–48 characters</span>
            </label>
            <input
              id="upstream-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
              minLength={3}
              maxLength={48}
              placeholder="Acme Shop"
            />
          </div>
          <div className="field">
            <label htmlFor="upstream-url">
              MCP server URL <span className="muted small">· https recommended</span>
            </label>
            <input
              id="upstream-url"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
              required
              placeholder="https://mcp.example.test/mcp"
            />
            <p className="muted tiny">
              Private and metadata addresses are refused unless explicitly allow-listed (SSRF guard, enforced by the
              gateway).
            </p>
          </div>
          <div className="checkbox-row">
            <input
              type="checkbox"
              id="upstream-enabled"
              className="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            <label htmlFor="upstream-enabled">Enabled — tools discoverable and callable</label>
          </div>
          <div className="field">
            <label htmlFor="upstream-cred-mode">Static credential</label>
            <select
              id="upstream-cred-mode"
              value={form.credentialMode}
              onChange={(event) => setForm({ ...form, credentialMode: event.target.value as UpstreamFormState["credentialMode"] })}
            >
              <option value="none">{formOpen === "edit" ? "Keep unchanged" : "None"}</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
              {formOpen === "edit" && <option value="clear">Clear stored credential</option>}
            </select>
          </div>
          {(form.credentialMode === "bearer" || form.credentialMode === "header") && (
            <>
              <div className="field">
                <label htmlFor="upstream-cred-value">Credential value</label>
                <input
                  id="upstream-cred-value"
                  type="password"
                  value={form.credentialValue}
                  onChange={(event) => setForm({ ...form, credentialValue: event.target.value })}
                  required
                  autoComplete="off"
                />
                <p className="muted tiny">
                  Shown once here, then stored encrypted at rest. It never appears in the browser, API responses or logs
                  again.
                </p>
              </div>
              {form.credentialMode === "header" && (
                <div className="field">
                  <label htmlFor="upstream-cred-header">Header name</label>
                  <input
                    id="upstream-cred-header"
                    value={form.credentialHeader}
                    onChange={(event) => setForm({ ...form, credentialHeader: event.target.value })}
                    required
                    placeholder="x-api-key"
                  />
                </div>
              )}
            </>
          )}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={formBusy}>
              {formBusy ? "Saving…" : formOpen === "add" ? "Register server" : "Save changes"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setFormOpen(null);
                setEditRow(null);
              }}
              disabled={formBusy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div aria-busy={state.status === "loading"} className="stack">
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
            hint="Set the *_MCP_URL variables on the gateway, or register a server with the button above."
          />
        )}
        {state.status === "loaded" &&
          groupToolsByUpstream(state.data.upstreams, state.data.tools).map((entry) => {
            const health = upstreamHealth(entry.status);
            const tone = upstreamHealthTone(health);
            const isOpen = expanded === entry.id;
            const modeLabel = storeModeLabel(entry.status.mode);
            const errorText = sanitizeError(entry.status.last_error);
            const label = upstreamLabel(entry.id, entry.status.name);
            const isAdminRow = me.role === "admin" && entry.status.source === "admin";
            return (
              <article key={entry.id} className={`server-card${entry.status.enabled ? "" : " is-disabled"}`}>
                <div className="row space-between">
                  <div className="row">
                    <span className={`status-dot ${healthDot(health)}`} aria-hidden="true" />
                    <h2 className="server-name">{label}</h2>
                    <Badge tone={tone === "success" ? "success" : tone === "error" ? "error" : tone === "neutral" ? "neutral" : "warn"}>
                      {upstreamHealthText(entry.status)}
                    </Badge>
                    {entry.status.source === "admin" && (
                      <Badge tone="info" title="Registered at runtime by an admin">
                        Admin-added
                      </Badge>
                    )}
                    {modeLabel !== null && (
                      <Badge tone={modeLabel === "Demo mock store" ? "info" : "success"} title="Backing store label (deploy-time configuration)">
                        {modeLabel}
                      </Badge>
                    )}
                    <span className="muted small">{entry.tools.length} tool{entry.tools.length === 1 ? "" : "s"}</span>
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
                    {isAdminRow && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => openEdit(entry.status)}
                        aria-label={`Edit ${label}`}
                      >
                        Edit
                      </button>
                    )}
                    {me.role === "admin" && entry.status.configured && (
                      <button
                        type="button"
                        className={entry.status.enabled ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
                        disabled={busyId === entry.id}
                        onClick={() => setConfirm({ id: entry.id, enable: !entry.status.enabled })}
                        aria-label={`${entry.status.enabled ? "Disable" : "Enable"} ${label}`}
                      >
                        {busyId === entry.id ? "Applying…" : entry.status.enabled ? "Disable" : "Enable"}
                      </button>
                    )}
                    {isAdminRow && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={busyId === entry.id}
                        onClick={() => setRemoveConfirm(entry.status)}
                        aria-label={`Remove ${label}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                {isAdminRow && entry.status.url !== undefined && (
                  <p className="row tight muted small">
                    <span className="endpoint">{sanitizeError(entry.status.url)}</span>
                    {entry.status.has_credential === true && <Badge tone="muted" title="Stored encrypted server-side; the value never leaves the gateway">credential stored</Badge>}
                  </p>
                )}
                {errorText !== null && (
                  <p className="small error-text server-error" title={entry.status.last_error ?? undefined}>
                    Last error: {errorText}
                  </p>
                )}
                {upstreamStatsSummary(entry.status.stats) !== null && (
                  <p className="muted small" title="Aggregate tool-call metrics from the audit log (this gateway's history)">
                    {upstreamStatsSummary(entry.status.stats)}
                  </p>
                )}
                {entry.status.configured && (
                  <p className="muted tiny">Refresh re-probes every server live (not cached state).</p>
                )}
                <div id={`server-tools-${entry.id}`} hidden={!isOpen}>
                  <div className="divider" />
                  {entry.tools.length === 0 ? (
                    <p className="muted small">No tools discovered (server disabled or unreachable).</p>
                  ) : (
                    <ul className="tool-mini-list" style={{ flexDirection: "column", gap: 6 }}>
                      {entry.tools.map((tool) => (
                        <li key={tool.qualified_name} className="row tight" style={{ gap: 10 }}>
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

      {removeConfirm !== null && (
        <ConfirmDialog
          title={`Remove ${upstreamLabel(removeConfirm.id, removeConfirm.name)}?`}
          danger
          busy={busyId === removeConfirm.id}
          message={
            <>
              <p>
                This deletes the server registration (and its stored credential) and removes its tools from discovery
                immediately. Members&apos; grants for it become inert.
              </p>
              <p className="muted small">The removal is audited. This cannot be undone from the dashboard.</p>
            </>
          }
          confirmLabel="Remove server"
          onConfirm={() => void removeServer(removeConfirm)}
          onCancel={() => setRemoveConfirm(null)}
        />
      )}
    </section>
  );
}
