/**
 * Create/edit member form used by the Team page. Upstream checkboxes plus an
 * optional advanced multi-select of known qualified tools (from /api/tools).
 * The server validates everything — this form is convenience, not enforcement.
 */

import { useState, type FormEvent } from "react";
import type { ToolView, UserRecord } from "../api/client.ts";
import { UPSTREAM_IDS, roleLabel, upstreamLabel } from "../lib/permissions.ts";
import { Field } from "./ui.tsx";

export interface MemberFormValue {
  displayName: string;
  role: "admin" | "reader";
  allowedUpstreams: string[];
  allowedTools: string[];
}

export function memberFormValue(user: UserRecord): MemberFormValue {
  return {
    displayName: user.displayName,
    role: user.role,
    allowedUpstreams: [...user.allowed_upstreams],
    allowedTools: [...user.allowed_tools],
  };
}

export function MemberForm({
  tools,
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  errorMessage,
}: {
  tools: readonly ToolView[];
  initial: MemberFormValue;
  busy: boolean;
  submitLabel: string;
  onSubmit: (value: MemberFormValue) => void;
  onCancel?: () => void;
  errorMessage?: string | null;
}) {
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [role, setRole] = useState<"admin" | "reader">(initial.role);
  const [upstreams, setUpstreams] = useState<string[]>(initial.allowedUpstreams);
  const [selectedTools, setSelectedTools] = useState<string[]>(initial.allowedTools);
  const [advanced, setAdvanced] = useState(initial.allowedTools.length > 0);

  const toggleUpstream = (id: string): void =>
    setUpstreams((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const toggleTool = (qualified: string): void => {
    const permission = `tools:${qualified}`;
    setSelectedTools((current) =>
      current.includes(permission) ? current.filter((x) => x !== permission) : [...current, permission],
    );
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit({
      displayName: displayName.trim(),
      role,
      allowedUpstreams: upstreams,
      allowedTools: advanced ? selectedTools : [],
    });
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <Field id="member-name" label="Display name" required hint="3–48 characters: letters, digits, spaces, . _ @ -">
        <input
          id="member-name"
          type="text"
          value={displayName}
          minLength={3}
          maxLength={48}
          required
          disabled={busy}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field id="member-role" label="Role" required hint={'"reader" = Member (no admin API); "admin" = admin API — tool calls still need the grants below'}>
        <select id="member-role" value={role} disabled={busy} onChange={(event) => setRole(event.target.value as "admin" | "reader")}>
          <option value="reader">{roleLabel("reader")}</option>
          <option value="admin">{roleLabel("admin")}</option>
        </select>
      </Field>
      <fieldset className="fieldset">
        <legend>Granted upstreams</legend>
        <div className="checkbox-row">
          {UPSTREAM_IDS.map((id) => (
            <label key={id} className="checkbox">
              <input
                type="checkbox"
                checked={upstreams.includes(id)}
                disabled={busy}
                onChange={() => toggleUpstream(id)}
              />
              {upstreamLabel(id)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          {advanced ? "Hide" : "Show"} tool grants (advanced)
        </button>
        {advanced && (
          <div className="tool-grants">
            <p className="muted small">
              Optional exact tool grants (<code>tools:&lt;qualified_name&gt;</code>). A member can only call a tool when
              its upstream is granted <em>and</em> the tool is granted here — for every role, admins included (only
              readers additionally hit the write-tool ceiling).
            </p>
            {tools.length === 0 ? (
              <p className="muted small">No tools discovered yet — start the gateway and refresh the tool catalogue.</p>
            ) : (
              <div className="checkbox-row scroll-box">
                {tools.map((tool) => (
                  <label key={tool.qualified_name} className="checkbox">
                    <input
                      type="checkbox"
                      checked={selectedTools.includes(`tools:${tool.qualified_name}`)}
                      disabled={busy}
                      onChange={() => toggleTool(tool.qualified_name)}
                    />
                    <code>{tool.qualified_name}</code>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {errorMessage !== null && errorMessage !== undefined && (
        <p className="banner banner-error" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || displayName.trim().length < 3}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
