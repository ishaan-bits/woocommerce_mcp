import { UPSTREAM_IDS, type ApiKeyPrincipal, type ToolPermission } from "@mcp/shared";
import { parseToolName } from "../routing.ts";

export interface AuthzDecision {
  readonly allowed: boolean;
  /** Stable machine code for audit rows, e.g. `role_forbidden`, `grant_forbidden`. */
  readonly errorCode: string | null;
  /** Human-safe reason; never contains secrets or internals. */
  readonly reason: string | null;
}

const ALLOWED: AuthzDecision = { allowed: true, errorCode: null, reason: null };

function denied(errorCode: string, reason: string): AuthzDecision {
  return { allowed: false, errorCode, reason };
}

/**
 * Write tools are recognised by their verb prefix. This is a *ceiling* for the
 * `reader` role (C2); the explicit per-principal grant list (C5) still has to
 * allow the tool afterwards, so unknown tools fail closed via the grant check.
 */
const WRITE_VERBS = ["create", "update", "delete", "remove", "patch", "put", "insert", "adjust", "set"] as const;

export function isWriteLocalName(localName: string): boolean {
  return WRITE_VERBS.some((verb) => localName.startsWith(`${verb}_`));
}

function toolPermission(qualifiedName: string): ToolPermission {
  return `tools:${qualifiedName}`;
}

/**
 * C5 check order applied at the gateway: role ceiling first, then
 * upstream grant, then exact tool grant. Everything is derived from the
 * authenticated principal — never from request input.
 *
 * `knownUpstreamIds` must be the registry's LIVE ids (fixed + admin-added):
 * grant checks only apply to names that parse, so a caller that omitted the
 * dynamic ids would let them past this function. Production call sites all
 * pass `registry.upstreamIds()`; the default covers the fixed ids for unit
 * tests of the fixed world.
 */
export function authorizeToolCall(
  principal: ApiKeyPrincipal,
  qualifiedName: string,
  knownUpstreamIds: readonly string[] = UPSTREAM_IDS,
): AuthzDecision {
  const parsed = parseToolName(qualifiedName, knownUpstreamIds);
  if (parsed === null) {
    // Unparseable names are the registry's `unknown_tool` path (outcome "error"),
    // not an authorization decision.
    return ALLOWED;
  }

  if (principal.role === "reader" && isWriteLocalName(parsed.localName)) {
    return denied("role_forbidden", `role 'reader' may not call write tool '${qualifiedName}'`);
  }

  if (!principal.allowedUpstreams.includes(parsed.upstreamId)) {
    return denied("grant_forbidden", `upstream '${parsed.upstreamId}' is not granted to this principal`);
  }

  if (!principal.allowedTools.includes(toolPermission(qualifiedName))) {
    return denied("grant_forbidden", `tool '${qualifiedName}' is not granted to this principal`);
  }

  return ALLOWED;
}

/** Admin-only REST surface (C2: "reader — no admin API"). */
export function authorizeAdminApi(principal: ApiKeyPrincipal): AuthzDecision {
  if (principal.role !== "admin") {
    return denied("role_forbidden", "this endpoint requires the admin role");
  }
  return ALLOWED;
}
