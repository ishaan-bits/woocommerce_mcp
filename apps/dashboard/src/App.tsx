import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ApiClient, MeResponse, UpstreamStatusView } from "./api/client.ts";
import { toFailure, resolveTheme, readStoredTheme, sessionExpiryShouldNotify, storeTheme, type Theme } from "./state.ts";
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

/** Route → icon (inline SVG; no icon dependency). */
function NavIcon({ route }: { route: RouteId }) {
  const common = { className: "nav-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (route) {
    case "overview":
      return <svg {...common}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>;
    case "upstreams":
      return <svg {...common}><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></svg>;
    case "tools":
      return <svg {...common}><path d="M14.7 6.3a4.2 4.2 0 0 0-5.6 5.6L4 17v3h3l5.1-5.1a4.2 4.2 0 0 0 5.6-5.6l-2.6 2.6-2.1-2.1 2.7-2.5z" /></svg>;
    case "chat":
      return <svg {...common}><path d="M21 12a8 8 0 1 1-3.2-6.4" /><path d="M21 4v4h-4" /><path d="M8.5 13.5 11 11l2 2 3-3.5" /></svg>;
    case "audit":
      return <svg {...common}><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>;
    case "team":
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="9" r="2.2" /><path d="M17 14a4 4 0 0 1 3.5 4" /></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" /></svg>;
    default:
      return null;
  }
}

function BrandGlyph() {
  return (
    <span className="brand-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="5.2" r="2.2" />
        <circle cx="5.2" cy="16.5" r="2.2" />
        <circle cx="18.8" cy="16.5" r="2.2" />
        <path d="M10.6 7 6.6 14.6M13.4 7l4 7.6M7.4 16.5h9.2" />
      </svg>
    </span>
  );
}

/** Aggregate upstream state from the real /api/upstreams rows (never fabricated). */
function summarizeUpstreams(rows: UpstreamStatusView[]): { healthy: number; degraded: number; disabled: number; total: number } {
  let healthy = 0;
  let degraded = 0;
  let disabled = 0;
  for (const row of rows) {
    if (row.enabled !== true) disabled += 1;
    else if (row.reachable === true) healthy += 1;
    else degraded += 1;
  }
  return { healthy, degraded, disabled, total: rows.length };
}

const SIDEBAR_KEY = "urumi.sidebar.collapsed";

export function App({ api }: { api: ApiClient }) {
  const [session, setSession] = useState<Session>({ status: "checking" });
  const [route, setRoute] = useState<RouteId>(() => parseRoute(window.location.hash));
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readStoredTheme(), prefersLight()));
  const [upstreams, setUpstreams] = useState<UpstreamStatusView[] | null>(null);
  const { toasts, push, dismiss, clear } = useToasts();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const menuRef = useRef<HTMLDivElement | null>(null);

  // All page-level calls go through the tracked client: it feeds the
  // connection pill from real API outcomes and converts any 401 into a
  // session-expired transition (never a silently stale page). D33: the ref
  // flips BEFORE the state update so two 401s arriving in the same tick
  // (parallel page loads) notify exactly once, and a 401 while already
  // anonymous (e.g. the first unauthenticated check) stays silent.
  const tracked = useMemo(() => trackApi(api), [api]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const current = sessionRef.current;
      if (!sessionExpiryShouldNotify(current.status)) {
        return;
      }
      const next: Session = { status: "anonymous", expired: true };
      sessionRef.current = next;
      setSession(next);
      push("info", "Session expired — sign in again to continue.");
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

  // Upstream health summary for the topbar — real rows, current state only.
  useEffect(() => {
    if (session.status !== "connected") return undefined;
    let cancelled = false;
    void api
      .upstreams()
      .then((res) => {
        if (!cancelled) setUpstreams(res.upstreams);
      })
      .catch(() => {
        // The gateway pill already reflects connectivity; the summary
        // simply stays absent (rendered as "—") rather than inventing data.
        if (!cancelled) setUpstreams(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, session.status]);

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
    if (meta !== null) meta.setAttribute("content", theme === "dark" ? "#0b0b10" : "#f6f6f9");
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

  // Account menu: close on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const toggleTheme = (): void => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      storeTheme(next);
      return next;
    });
  };

  const toggleCollapsed = (): void => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        // localStorage unavailable — collapse still works for this session.
      }
      return next;
    });
  };

  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, getConnectionState);
  const pill = connectionStatus(connection, Date.now());

  const onLoggedIn = (me: MeResponse): void => {
    // A successful login starts clean: any stale error/expiry toast from
    // before must not linger over the new session.
    clear();
    setLogoutError(null);
    setSession({ status: "connected", me });
    window.location.hash = routeHash("overview");
    setRoute("overview");
  };

  const onLogout = async (): Promise<void> => {
    setLogoutError(null);
    try {
      await api.logout();
      clear();
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
  const summary = upstreams === null ? null : summarizeUpstreams(upstreams);
  const initials = me.display_name.slice(0, 2).toUpperCase();

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
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className="brand">
            <BrandGlyph />
            <div className="brand-text">
              <span className="brand-name">Urumi MCP</span>
              <span className="brand-page">{currentLabel}</span>
            </div>
          </div>
          <div className="health-strip">
            <span
              className={`health-chip ${pill.tone === "success" ? "is-healthy" : pill.tone === "warn" ? "is-warn" : ""}`}
              title="Gateway connectivity, derived from real API responses"
            >
              <span className={`status-dot ${pill.tone === "success" ? "is-healthy" : pill.tone === "warn" ? "is-error" : ""}`} aria-hidden="true" />
              <span className="health-text">{pill.label}</span>
            </span>
            {summary !== null && (
              <span
                className={`health-chip ${summary.degraded > 0 ? "is-warn" : summary.total > 0 ? "is-healthy" : ""}`}
                title="Upstream server health from GET /api/upstreams (current state)"
              >
                <span className={`status-dot ${summary.degraded > 0 ? "is-warn" : "is-healthy"}`} aria-hidden="true" />
                <span className="health-text">
                  {summary.degraded > 0
                    ? `${summary.degraded} of ${summary.total} upstreams need attention`
                    : `${summary.healthy}/${summary.total} upstreams healthy`}
                  {summary.disabled > 0 ? ` · ${summary.disabled} disabled` : ""}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="session">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            data-tooltip={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? (
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5" />
              </svg>
            ) : (
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 7 7 0 1 0 20 14.5z" />
              </svg>
            )}
          </button>
          <div className="account-wrap" ref={menuRef}>
            <button
              type="button"
              className="account-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="avatar" aria-hidden="true">{initials}</span>
              <span className="principal-name">{me.display_name}</span>
              <svg className="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <div className="menu" role="menu" aria-label="Account">
                <div className="menu-head">
                  {me.display_name} · <span className={`badge badge-${me.role === "admin" ? "admin" : "member"}`}>{roleLabel(me.role)}</span>
                </div>
                <div className="menu-sep" />
                <button type="button" className="menu-item" role="menuitem" onClick={toggleTheme}>
                  {theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                </button>
                <div className="menu-sep" />
                <button type="button" className="menu-item is-danger" role="menuitem" onClick={() => void onLogout()}>
                  Sign out
                </button>
              </div>
            )}
          </div>
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
        <nav
          id="sidebar"
          className={`sidebar${navOpen ? " sidebar-open" : ""}${collapsed ? " collapsed" : ""}`}
          aria-label="Dashboard sections"
        >
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
                        className="nav-link"
                        aria-current={route === entry.id ? "page" : undefined}
                        data-tooltip={collapsed ? entry.label : undefined}
                        onClick={() => setNavOpen(false)}
                      >
                        <NavIcon route={entry.id} />
                        <span className="nav-label">{entry.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="sidebar-foot">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              data-tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <svg
                className="icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ transform: collapsed ? "rotate(180deg)" : "none", transition: "transform 190ms cubic-bezier(0.16,1,0.3,1)" }}
              >
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </button>
          </div>
        </nav>

        <main id="content" className="page-anim" key={route}>
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
