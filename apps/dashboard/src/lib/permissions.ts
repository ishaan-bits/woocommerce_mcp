/**
 * Pure permission + selector helpers mirroring the gateway's authorization
 * rules (apps/gateway/src/auth/authorization.ts). Unit-tested in
 * test/permissions.test.ts. The UI predicate is cosmetic — the server is the
 * real enforcement — but it must mirror the server exactly so the catalogue
 * does not mislead.
 */

export const UPSTREAM_IDS: readonly string[] = ["woocommerce", "inventory", "support"];

export const WRITE_VERBS: readonly string[] = [
  "create",
  "update",
  "delete",
  "remove",
  "patch",
  "put",
  "insert",
  "adjust",
  "set",
];

export interface PrincipalLike {
  readonly role: "admin" | "reader";
  readonly allowed_upstreams: readonly string[];
  readonly allowed_tools: readonly string[];
}

export interface ParsedToolName {
  upstreamId: string;
  localName: string;
}

export function parseToolName(qualifiedName: string): ParsedToolName | null {
  for (const upstreamId of UPSTREAM_IDS) {
    const prefix = `${upstreamId}_`;
    if (qualifiedName.startsWith(prefix)) {
      const localName = qualifiedName.slice(prefix.length);
      if (localName.length > 0) {
        return { upstreamId, localName };
      }
    }
  }
  return null;
}

/** Local name's leading verb marks it a write tool (a ceiling for readers). */
export function isWriteLocalName(localName: string): boolean {
  return WRITE_VERBS.some((verb) => localName.startsWith(`${verb}_`));
}

export function toolPermission(qualifiedName: string): string {
  return `tools:${qualifiedName}`;
}

export type PermissionDecision =
  | { readonly allowed: true; readonly reason: null }
  | { readonly allowed: false; readonly reason: string };

const ALLOWED: PermissionDecision = { allowed: true, reason: null };

function denied(reason: string): PermissionDecision {
  return { allowed: false, reason };
}

/**
 * Mirror of the gateway's authorizeToolCall (C5) check order, byte for byte:
 * parse first, then the reader-role write ceiling, then the upstream grant,
 * then the exact tool grant. Unparseable names are not an authorization
 * decision (the registry answers unknown_tool), so we allow them here and
 * let the server decide.
 *
 * There is deliberately NO admin bypass: admins are bound by their grant
 * lists exactly like readers (only the write ceiling is reader-only), and
 * the /api/keys route even creates admin keys with empty grants by default.
 * The indicator must show what the server would do — see
 * apps/gateway/src/auth/authorization.ts:50-56.
 */
export function canUseTool(
  principal: PrincipalLike,
  qualifiedName: string,
): PermissionDecision {
  const parsed = parseToolName(qualifiedName);
  if (parsed === null) {
    return ALLOWED;
  }
  if (principal.role === "reader" && isWriteLocalName(parsed.localName)) {
    return denied("role_forbidden");
  }
  if (!principal.allowed_upstreams.includes(parsed.upstreamId)) {
    return denied("grant_forbidden");
  }
  if (!principal.allowed_tools.includes(toolPermission(qualifiedName))) {
    return denied("grant_forbidden");
  }
  return ALLOWED;
}

export function isToolAllowed(principal: PrincipalLike, qualifiedName: string): boolean {
  return canUseTool(principal, qualifiedName).allowed;
}

export function roleLabel(role: string): string {
  return role === "admin" ? "Admin" : role === "reader" ? "Member" : role;
}

/** Short human label for an upstream id. */
export function upstreamLabel(id: string, displayName?: string): string {
  // Admin-registered servers (M11) carry their own name; fixed env servers
  // keep their friendly deploy-time label.
  if (displayName !== undefined && displayName !== "" && displayName !== id) {
    return displayName;
  }
  return id === "woocommerce" ? "WooCommerce" : id === "inventory" ? "Inventory" : id === "support" ? "Support" : id;
}

/** The woocommerce backing store mode (deploy-time label), clearly worded. */
export function storeModeLabel(mode: "mock" | "real" | null | undefined): string | null {
  if (mode === "mock") return "Demo mock store";
  if (mode === "real") return "Real store";
  return null;
}

/** True when an endpoint host is a loopback/local address (label "local only"). */
export function isLocalEndpoint(endpoint: string | null | undefined): boolean {
  if (endpoint === null || endpoint === undefined || endpoint === "") return false;
  try {
    const host = new URL(endpoint).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
