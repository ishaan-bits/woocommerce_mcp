import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ApiClient, MeResponse } from "./api/client.ts";
import { toFailure, resolveTheme, readStoredTheme, storeTheme, type Theme } from "./state.ts";
import { LoginPage } from "./LoginPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { ToolsPage } from "./pages/ToolsPage.tsx";
import { UpstreamsPage } from "./pages/UpstreamsPage.tsx";
import { AuditPage } from "./pages/AuditPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { TeamPage } from "./pages/TeamPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import {
  documentTitleFor,
  parseRoute,
  routeHash,
  routesForRole,
  ROUTES,
  type RouteId,
} from "./lib/routes.ts";
import {
  connectionStatus,
  getConnectionState,
  setUnauthorizedHandler,
  subscribeConnection,
  trackApi,
} from "./lib/connection.ts";
import { roleLabel } from "./lib/permissions.ts";
import { Toasts, useToasts } from "./components/Toasts.tsx";

type Session =
  | { status: "checking" }
  | { status: "anonymous"; expired: boolean }
  | { status: "connected"; me: MeResponse }
  | { status: "unreachable"; message: string };

function prefersLight(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches === true;
}

export function App({ api }: { api: ApiClient }) {
  const [session, setSession] = useState<Session>({ status: "checking" });
  const [route, setRoute] = useState<RouteId>(() => parseRoute(window.location.hash));
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readStoredTheme(), prefersLight()));
  const { toasts, push, dismiss } = useToasts();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // All page-level calls go through the tracked client: it feeds the
  // connection pill from real API outcomes and converts any 401 into a
  // session-expired transition (never a silently stale page).
  const tracked = useMemo(() => trackApi(api), [api]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const current = sessionRef.current;
      if (current.status === "connected") {
        push("info", "Session expired — sign in again to continue.");
        setSession({ status: "anonymous", expired: true });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [push]);

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
        setSession({ status: "anonymous", expired: false });
      }
    }
  }, [api]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseRoute(window.location.hash));
      setNavOpen(false);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.title = documentTitleFor(route);
  }, [route]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null) meta.setAttribute("content", theme === "dark" ? "#0e1116" : "#f6f8fa");
  }, [theme]);

  // Follow OS changes until the user makes an explicit choice.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (query === undefined) return undefined;
    const onChange = (): void => {
      if (readStoredTheme() === null) {
        setTheme(resolveTheme(null, query.matches));
      }
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const toggleTheme = (): void => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      storeTheme(next);
      return next;
    });
  };

  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, getConnectionState);
  const pill = connectionStatus(connection, Date.now());

  const onLoggedIn = (me: MeResponse): void => {
    setLogoutError(null);
    setSession({ status: "connected", me });
    window.location.hash = routeHash("overview");
    setRoute("overview");
  };

  const onLogout = async (): Promise<void> => {
    setLogoutError(null);
    try {
      await api.logout();
      setSession({ status: "anonymous", expired: false });
    } catch (error) {
      const failure = toFailure(error);
      setLogoutError(failure.message);
    }
  };

  if (session.status === "checking") {
    return (
      <div className="fullpage" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
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
        <button type="button" className="btn btn-primary" onClick={() => void checkSession()}>
          Retry
        </button>
      </div>
    );
  }

  if (session.status === "anonymous") {
    return (
      <>
        <LoginPage api={api} onLoggedIn={onLoggedIn} sessionExpired={session.expired} />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  const { me } = session;
  const nav = routesForRole(me.role);
  const groups: Array<"Platform" | "Governance" | "Help"> = ["Platform", "Governance", "Help"];
  const currentLabel = ROUTES.find((entry) => entry.id === route)?.label ?? "Overview";

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="btn btn-ghost btn-icon nav-toggle"
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            aria-controls="sidebar"
            onClick={() => setNavOpen((open) => !open)}
          >
            ☰
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              ⬡
            </span>
            <div className="brand-text">
              <span className="brand-name">Urumi MCP Gateway</span>
              <span className="brand-page">{currentLabel}</span>
            </div>
          </div>
        </div>
        <div className="session">
          <span className={`badge badge-${pill.tone === "success" ? "success" : pill.tone === "warn" ? "warn" : "neutral"}`} title="Derived from real API responses">
            {pill.label}
          </span>
          <span className="muted small principal">
            {me.display_name} <span className={`badge badge-${me.role === "admin" ? "admin" : "member"}`}>{roleLabel(me.role)}</span>
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="body">
        {navOpen && (
          <button
            type="button"
            className="nav-overlay"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          />
        )}
        <nav id="sidebar" className={navOpen ? "sidebar sidebar-open" : "sidebar"} aria-label="Dashboard sections">
          {groups.map((group) => {
            const entries = nav.filter((entry) => entry.group === group);
            if (entries.length === 0) return null;
            return (
              <div key={group} className="nav-group">
                <p className="nav-group-title">{group}</p>
                <ul>
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <a
                        href={routeHash(entry.id)}
                        aria-current={route === entry.id ? "page" : undefined}
                        onClick={() => setNavOpen(false)}
                      >
                        {entry.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <main id="content">
          {logoutError !== null && (
            <p className="banner banner-error" role="alert">
              Sign-out failed: {logoutError}
            </p>
          )}
          {route === "overview" && <OverviewPage key="overview" api={tracked} me={me} />}
          {route === "upstreams" && <UpstreamsPage key="upstreams" api={tracked} me={me} />}
          {route === "tools" && <ToolsPage key="tools" api={tracked} me={me} />}
          {route === "chat" && <ChatPage key="chat" api={tracked} />}
          {route === "audit" && <AuditPage key="audit" api={tracked} me={me} />}
          {route === "team" && <TeamPage key="team" api={tracked} me={me} />}
          {route === "settings" && <SettingsPage key="settings" api={tracked} />}
        </main>
      </div>
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
