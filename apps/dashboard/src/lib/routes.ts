/**
 * Pure route parsing for the hand-rolled hash router — no DOM, so it is
 * unit-testable under `node --test` (test/routes.test.ts). Old `#/` routes
 * keep working; unknown hashes fall back to "overview".
 */

export type RouteId =
  | "overview"
  | "upstreams"
  | "tools"
  | "chat"
  | "audit"
  | "team"
  | "settings";

export interface RouteDef {
  readonly id: RouteId;
  readonly label: string;
  readonly group: "Platform" | "Governance" | "Help";
  /** Admin-only nav entries are hidden from readers (server still enforces 403). */
  readonly adminOnly?: boolean;
}

export const ROUTES: readonly RouteDef[] = [
  { id: "overview", label: "Overview", group: "Platform" },
  { id: "upstreams", label: "MCP servers", group: "Platform" },
  { id: "tools", label: "Tool catalogue", group: "Platform" },
  { id: "chat", label: "Chat", group: "Platform" },
  { id: "audit", label: "Audit log", group: "Governance", adminOnly: true },
  { id: "team", label: "Team & API keys", group: "Governance", adminOnly: true },
  { id: "settings", label: "Settings", group: "Help" },
];

export const ROUTE_IDS: readonly RouteId[] = ROUTES.map((route) => route.id);

export function isRouteId(value: string): value is RouteId {
  return ROUTE_IDS.includes(value as RouteId);
}

/**
 * Accepts `#overview`, `#/overview`, `#overview?x=1`, and bare/empty hashes.
 * Query strings and trailing junk are ignored for matching (the dashboard
 * does not use query state, but tolerates pasted links).
 */
export function parseRoute(hash: string): RouteId {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  const id = cleaned.split(/[?#]/)[0] ?? "";
  return isRouteId(id) ? id : "overview";
}

export function routeHash(id: RouteId): string {
  return `#/${id}`;
}

export function documentTitleFor(id: RouteId): string {
  const route = ROUTES.find((entry) => entry.id === id);
  const label = route?.label ?? "Overview";
  return `${label} · Urumi MCP Gateway`;
}

export function routesForRole(role: "admin" | "reader"): readonly RouteDef[] {
  return ROUTES.filter((route) => route.adminOnly !== true || role === "admin");
}
