import { useState, type FormEvent } from "react";
import type { ApiClient, MeResponse } from "./api/client.ts";
import { toFailure } from "./state.ts";

/**
 * Login (D23): the key is typed once, sent as a JSON body to /api/auth/login
 * and exchanged for an HttpOnly, SameSite=Strict session cookie. Nothing is
 * written to localStorage/sessionStorage/URLs, and this component discards
 * the value as soon as the request completes (the controlled input resets).
 */
export function LoginPage({ api, onLoggedIn }: { api: ApiClient; onLoggedIn: (me: MeResponse) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await api.login(key.trim());
      setKey("");
      onLoggedIn(me);
    } catch (caught) {
      const failure = toFailure(caught);
      setError(
        failure.code === "gateway_unreachable"
          ? "Gateway unreachable — is it running?"
          : failure.code === "unauthorized"
            ? "That key was rejected (unknown, malformed or revoked)."
            : failure.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fullpage">
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <h1>Sign in</h1>
        <p className="muted">
          Paste a gateway API key (<code>umk_…</code>). It is sent once to <code>POST /api/auth/login</code> and
          exchanged for an HttpOnly session cookie — the key itself is never stored in the browser.
        </p>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          name="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="umk_…"
          required
          aria-describedby="login-help"
          aria-invalid={error !== null}
        />
        <p id="login-help" className="muted small">
          Admin features additionally require the admin role — the server enforces every permission.
        </p>
        {error !== null && (
          <p className="banner banner-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || key.trim().length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
