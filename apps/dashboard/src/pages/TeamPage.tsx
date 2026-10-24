import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, IssuedKey, KeyRecord, MeResponse, ToolView, UserRecord } from "../api/client.ts";
import { failed, loaded, loading, toFailure, type LoadState } from "../state.ts";
import { formatLocalTime } from "../lib/audit.ts";
import { roleLabel, upstreamLabel } from "../lib/permissions.ts";
import { Badge, EmptyState, ErrorBanner, Field, Skeleton } from "../components/ui.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Modal } from "../components/Modal.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { MemberForm, memberFormValue, type MemberFormValue } from "../components/MemberForm.tsx";

type Tab = "members" | "keys";

interface TeamData {
  users: UserRecord[];
  tools: ToolView[];
}

/**
 * Team & API keys (admin-only; the server 403s readers regardless). Members
 * are managed with POST/PATCH /api/users; keys are issued with POST /api/keys
 * and the plaintext value is shown EXACTLY ONCE in a modal that cannot be
 * dismissed accidentally. Only safe metadata is ever listed.
 */
export function TeamPage({ api, me }: { api: ApiClient; me: MeResponse }) {
  const [tab, setTab] = useState<Tab>("members");
  const [team, setTeam] = useState<LoadState<TeamData>>(loading());
  const [keys, setKeys] = useState<LoadState<KeyRecord[]>>(loading());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRecord | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issueFor, setIssueFor] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<KeyRecord | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  // One sequencer per loader. REGRESSION: the members and keys loaders run in
  // the SAME mount effect; a shared counter made the first loader's id stale
  // (1 !== 2) as soon as the second one started, so its result was silently
  // discarded and the Members tab stayed on the skeleton forever.
  const teamSeq = useRef(0);
  const keysSeq = useRef(0);

  const refreshTeam = useCallback(async () => {
    const id = ++teamSeq.current;
    setTeam(loading());
    try {
      const [usersRes, toolsRes] = await Promise.all([api.users(), api.tools()]);
      if (id !== teamSeq.current) return;
      setTeam(loaded({ users: usersRes.users, tools: toolsRes.tools }));
    } catch (error) {
      if (id !== teamSeq.current) return;
      const failure = toFailure(error);
      setTeam(
        failed(
          failure.code,
          failure.code === "forbidden" ? "Access denied — the Team area requires the admin role." : failure.message,
        ),
      );
    }
  }, [api]);

  const refreshKeys = useCallback(async () => {
    const id = ++keysSeq.current;
    setKeys(loading());
    try {
      const response = await api.keys();
      if (id !== keysSeq.current) return;
      setKeys(loaded(response.keys, response.keys.length === 0));
    } catch (error) {
      if (id !== keysSeq.current) return;
      const failure = toFailure(error);
      setKeys(failed(failure.code, failure.message));
    }
  }, [api]);

  useEffect(() => {
    void refreshTeam();
    void refreshKeys();
    return () => {
      teamSeq.current += 1;
      keysSeq.current += 1;
    };
  }, [refreshTeam, refreshKeys]);

  const createUser = async (value: MemberFormValue): Promise<void> => {
    setFormBusy(true);
    setFormError(null);
    try {
      await api.createUser({
        display_name: value.displayName,
        role: value.role,
        allowed_upstreams: value.allowedUpstreams,
        allowed_tools: value.allowedTools,
      });
      setCreating(false);
      setActionOk(`Member “${value.displayName}” created.`);
      await refreshTeam();
    } catch (error) {
      const failure = toFailure(error);
      setFormError(
        failure.code === "display_name_in_use"
          ? "That display name is already in use — pick another."
          : failure.message,
      );
    } finally {
      setFormBusy(false);
    }
  };

  const patchUser = async (user: UserRecord, value: MemberFormValue): Promise<void> => {
    setFormBusy(true);
    setFormError(null);
    try {
      await api.updateUser(user.id, {
        display_name: value.displayName,
        role: value.role,
        allowed_upstreams: value.allowedUpstreams,
        allowed_tools: value.allowedTools,
      });
      setEditing(null);
      setActionOk(`Member “${value.displayName}” updated.`);
      await refreshTeam();
    } catch (error) {
      const failure = toFailure(error);
      setFormError(
        failure.code === "display_name_in_use"
          ? "That display name is already in use — pick another."
          : failure.code === "unknown_user"
            ? "That member no longer exists — refresh and try again."
            : failure.message,
      );
    } finally {
      setFormBusy(false);
    }
  };

  const issueKey = async (userId: string): Promise<void> => {
    setIssueFor(null);
    try {
      const result = await api.issueKey(userId);
      // Plaintext key lives only in this component state until the modal closes.
      setIssued(result);
      await refreshKeys();
    } catch (error) {
      const failure = toFailure(error);
      setIssueError(failure.code === "unknown_user" ? "That member no longer exists." : failure.message);
    }
  };

  const revoke = async (): Promise<void> => {
    if (revokeTarget === null) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      const result = await api.revokeKey(revokeTarget.id);
      setActionOk(
        result.already_revoked
          ? "That key was already revoked — no change."
          : `Key ${revokeTarget.keyPrefix}… revoked.`,
      );
      setRevokeTarget(null);
      await refreshKeys();
    } catch (error) {
      const failure = toFailure(error);
      setRevokeError(failure.code === "unknown_key" ? "That key no longer exists." : failure.message);
    } finally {
      setRevokeBusy(false);
    }
  };

  if (team.status === "error" && team.code === "forbidden") {
    return (
      <section aria-labelledby="team-heading">
        <h1 id="team-heading">Team & API keys</h1>
        <ErrorBanner message="This area requires the admin role (enforced server-side)." />
      </section>
    );
  }

  return (
    <section aria-labelledby="team-heading">
      <div className="row space-between page-head">
        <div>
          <p className="eyebrow">Governance</p>
          <h1 id="team-heading">Team & API keys</h1>
        </div>
        <div className="tabs" role="tablist" aria-label="Team sections">
          <button
            type="button"
            className={tab === "members" ? "tab is-active" : "tab"}
            role="tab"
            aria-pressed={tab === "members"}
            onClick={() => setTab("members")}
          >
            Members
          </button>
          <button
            type="button"
            className={tab === "keys" ? "tab is-active" : "tab"}
            role="tab"
            aria-pressed={tab === "keys"}
            onClick={() => setTab("keys")}
          >
            API keys
          </button>
        </div>
      </div>
      <p className="muted">
        Signed in as {me.display_name} · <Badge tone="admin">{roleLabel("admin")}</Badge>. Only safe metadata is listed —
        key material appears exactly once, at issue time.
      </p>

      {actionOk !== null && (
        <p className="banner banner-ok" role="status">
          {actionOk}
        </p>
      )}
      {issueError !== null && (
        <p className="banner banner-error" role="alert">
          {issueError}
        </p>
      )}

      {tab === "members" && (
        <div className="stack">
          {team.status === "loading" && <Skeleton rows={4} />}
          {team.status === "error" && <ErrorBanner message={team.message} onRetry={() => void refreshTeam()} />}
          {(team.status === "loaded" || team.status === "empty") && (
            <>
              <div className="row space-between">
                <h2>Members</h2>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)} disabled={creating}>
                  Create member
                </button>
              </div>
              {team.status === "empty" || team.data.users.length === 0 ? (
                <EmptyState title="No members yet" hint="Create the first member, then issue them an API key." />
              ) : (
                <div className="table-wrap">
                  <table>
                    <caption className="sr-only">Team members</caption>
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Role</th>
                        <th scope="col">Upstreams</th>
                        <th scope="col">Tool grants</th>
                        <th scope="col">Keys (active/total)</th>
                        <th scope="col">Created</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.data.users.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <strong>{user.displayName}</strong>
                            {user.id === me.user_id && <span className="muted small"> (you)</span>}
                          </td>
                          <td>
                            <Badge tone={user.role === "admin" ? "admin" : "member"}>{roleLabel(user.role)}</Badge>
                          </td>
                          <td className="small">
                            {user.allowedUpstreams.length > 0
                              ? user.allowedUpstreams.map((id) => upstreamLabel(id)).join(", ")
                              : "none"}
                          </td>
                          <td className="small">{user.allowedTools.length}</td>
                          <td className="small">
                            {user.activeKeys} / {user.totalKeys}
                          </td>
                          <td className="small" title={user.createdAt}>
                            {formatLocalTime(user.createdAt)}
                          </td>
                          <td>
                            <div className="row">
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(user); setFormError(null); }}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  setIssueFor(user.id);
                                  setIssueError(null);
                                }}
                              >
                                Issue key
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {creating && team.status === "loaded" && (
                <MemberForm
                  tools={team.data.tools}
                  initial={{ displayName: "", role: "reader", allowedUpstreams: [], allowedTools: [] }}
                  busy={formBusy}
                  submitLabel="Create member"
                  errorMessage={formError}
                  onCancel={() => {
                    setCreating(false);
                    setFormError(null);
                  }}
                  onSubmit={(value) => void createUser(value)}
                />
              )}
              {editing !== null && team.status === "loaded" && (
                <MemberForm
                  tools={team.data.tools}
                  initial={memberFormValue(editing)}
                  busy={formBusy}
                  submitLabel="Save changes"
                  errorMessage={formError}
                  onCancel={() => {
                    setEditing(null);
                    setFormError(null);
                  }}
                  onSubmit={(value) => void patchUser(editing, value)}
                />
              )}
            </>
          )}
        </div>
      )}

      {tab === "keys" && (
        <div className="stack">
          <div className="row space-between">
            <h2>API keys</h2>
            <div className="row">
              {team.status === "loaded" && (
                <div className="field field-inline">
                  <label htmlFor="issue-for" className="sr-only">
                    Issue key for member
                  </label>
                  <select
                    id="issue-for"
                    value=""
                    onChange={(event) => {
                      if (event.target.value !== "") void issueKey(event.target.value);
                      event.target.value = "";
                    }}
                  >
                    <option value="">Issue key for member…</option>
                    {team.data.users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} ({roleLabel(user.role)})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshKeys()} disabled={keys.status === "loading"}>
                Refresh
              </button>
            </div>
          </div>
          {keys.status === "loading" && <Skeleton rows={4} />}
          {keys.status === "error" && <ErrorBanner message={keys.message} onRetry={() => void refreshKeys()} />}
          {keys.status === "empty" && (
            <EmptyState title="No API keys issued" hint="Issue a key for a member from the select above — it will be shown once." />
          )}
          {keys.status === "loaded" && (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">API keys (metadata only)</caption>
                <thead>
                  <tr>
                    <th scope="col">Prefix</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Role</th>
                    <th scope="col">Created</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.map((key) => {
                    const revoked = key.revokedAt !== null;
                    return (
                      <tr key={key.id} className={revoked ? "row-revoked" : undefined}>
                        <td>
                          <code>{key.keyPrefix}…</code>
                        </td>
                        <td>{key.displayName}</td>
                        <td>
                          <Badge tone={key.role === "admin" ? "admin" : "member"}>{roleLabel(key.role)}</Badge>
                        </td>
                        <td className="small" title={key.createdAt}>
                          {formatLocalTime(key.createdAt)}
                        </td>
                        <td>
                          {revoked ? (
                            <Badge tone="error" title={`Revoked ${formatLocalTime(key.revokedAt ?? "")}`}>
                              revoked
                            </Badge>
                          ) : (
                            <Badge tone="success">active</Badge>
                          )}
                        </td>
                        <td>
                          {revoked ? (
                            <span className="muted small">—</span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              onClick={() => {
                                setRevokeTarget(key);
                                setRevokeError(null);
                              }}
                              aria-label={`Revoke key ${key.keyPrefix}`}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {issued !== null && (
        <Modal
          title="Copy your API key now"
          dismissable={false}
          onClose={() => setIssued(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setIssued(null)}>
              I stored it — close
            </button>
          }
        >
          <div className="stack">
            <p className="banner banner-warn" role="alert">
              This key is shown <strong>once</strong>. It cannot be retrieved again — store it in a password manager
              now. If you lose it, revoke it and issue a new one.
            </p>
            <div className="key-reveal">
              <code className="key-value">{issued.key}</code>
              <CopyButton value={issued.key} label="Copy key" className="btn btn-primary" />
            </div>
            <p className="muted small">
              Prefix <code>{issued.key_prefix}…</code> · owner user <code>{issued.user_id}</code> · created{" "}
              {formatLocalTime(issued.created_at)}
            </p>
          </div>
        </Modal>
      )}

      {issueFor !== null && team.status === "loaded" && (
        <ConfirmDialog
          title="Issue a new API key?"
          message={
            <p>
              A new key will be issued for{' '}
              <strong>{team.data.users.find((user) => user.id === issueFor)?.displayName ?? "this member"}</strong>. The
              plaintext key is shown exactly once, immediately after creation.
            </p>
          }
          confirmLabel="Issue key"
          onConfirm={() => void issueKey(issueFor)}
          onCancel={() => setIssueFor(null)}
        />
      )}

      {revokeTarget !== null && (
        <ConfirmDialog
          title="Revoke this key?"
          danger
          busy={revokeBusy}
          message={
            <>
              <p>
                Key <code>{revokeTarget.keyPrefix}…</code> ({revokeTarget.displayName}) will stop working immediately —
                any client still using it will get 401s.
              </p>
              {revokeError !== null && (
                <p className="banner banner-error" role="alert">
                  {revokeError}
                </p>
              )}
            </>
          }
          confirmLabel="Revoke key"
          onConfirm={() => void revoke()}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </section>
  );
}
