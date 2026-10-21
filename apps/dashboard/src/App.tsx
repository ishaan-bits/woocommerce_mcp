import { useCallback, useEffect, useState } from "react";
import type { ApiClient, MeResponse } from "./api/client.ts";
import { toFailure } from "./state.ts";
import { LoginPage } from "./LoginPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { ToolsPage } from "./pages/ToolsPage.tsx";
import { UpstreamsPage } from "./pages/UpstreamsPage.tsx";
import { AuditPage } from "./pages/AuditPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";

export type Route = "overview" | "tools" | "upstreams" | "audit" | "chat";

const ROUTES: ReadonlyArray<{ id: Route; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tools", label: "Tools" },
  { id: "upstreams", label: "Upstreams" },
  { id: "audit", label: "Audit log" },
  { id: "chat", label: "Chat" },
];

function parseRoute(hash: string): Route {
  const match = /^#\/([a-z]+)$/.exec(hash);
  const candidate = match?.[1];
  return ROUTES.some((route) => route.id === candidate) ? (candidate as Route) : "overview";
}

type Session =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "connected"; me: MeResponse }
  | { status: "unreachable"; message: string };

export function App({ api }: { api: ApiClient }) {
  const [session, setSession] = useState<Session>({ status: "checking" });
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    setSession({ status: "checking" });
    try {
      const me = await api.me();
      setSession({ status: "connected", me });
    } catch (error) {
      const failure = toFailure(error);
      if (failure.code === "gateway_unreachable") {
        setSession({ status: "unreachable", message: failure.message });
      } else {
        setSession({ status: "anonymous" });
      }
    }
  }, [api]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = (next: Route): void => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  };

  const onLoggedIn = (me: MeResponse): void => {
    setLogoutError(null);
    setSession({ status: "connected", me });
    navigate("overview");
  };

  const onLogout = async (): Promise<void> => {
    setLogoutError(null);
    try {
      await api.logout();
      setSession({ status: "anonymous" });
    } catch (error) {
      const failure = toFailure(error);
      setLogoutError(failure.message);
    }
  };

  if (session.status === "checking") {
    return (
      <div className="fullpage" role="status" aria-live="polite">
        <p className="muted">Contacting gateway…</p>
      </div>
    );
  }

  if (session.status === "unreachable") {
    return (
      <div className="fullpage" role="alert">
        <h1>Gateway unreachable</h1>
        <p className="muted">
          The dashboard could not reach the gateway API. Start the gateway (and check the Vite proxy target{" "}
          <code>VITE_GATEWAY_API_URL</code>), then retry.
        </p>
        <p className="error-text">{session.message}</p>
        <button type="button" onClick={() => void checkSession()}>
          Retry
        </button>
      </div>
    );
  }

  if (session.status === "anonymous") {
    return <LoginPage api={api} onLoggedIn={onLoggedIn} />;
  }

  const { me } = session;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⬡
          </span>
          <span>Urumi MCP Gateway</span>
        </div>
        <div className="session">
          <span className="muted">
            {me.display_name} · <span className={`badge badge-${me.role}`}>{me.role}</span>
          </span>
          <button type="button" className="ghost" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="body">
        <nav aria-label="Dashboard sections">
          <ul>
            {ROUTES.map((entry) => (
              <li key={entry.id}>
                <a
                  href={`#/${entry.id}`}
                  aria-current={route === entry.id ? "page" : undefined}
                  onClick={() => setRoute(entry.id)}
                >
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main id="content">
          {logoutError !== null && (
            <p className="banner banner-error" role="alert">
              Sign-out failed: {logoutError}
            </p>
          )}
          {route === "overview" && <OverviewPage key="overview" api={api} me={me} />}
          {route === "tools" && <ToolsPage key="tools" api={api} />}
          {route === "upstreams" && <UpstreamsPage key="upstreams" api={api} me={me} />}
          {route === "audit" && <AuditPage key="audit" api={api} me={me} />}
          {route === "chat" && <ChatPage key="chat" api={api} />}
        </main>
      </div>
    </div>
  );
}
