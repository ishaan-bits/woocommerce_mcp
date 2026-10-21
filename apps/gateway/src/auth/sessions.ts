import { createHash, randomBytes } from "node:crypto";

/**
 * Dashboard browser sessions (D23).
 *
 * A session is an opaque 256-bit random token: the browser sees it only as an
 * HttpOnly cookie, the server stores only its sha256 hex digest, and the
 * session row is bound to the API key that created it — revoking the key
 * invalidates every session it created on the next request. The plaintext
 * token is never persisted, logged, or placed in a URL.
 *
 * The cookie is scoped to Path=/ so the gateway can read it under /api, but
 * the auth middleware only honours it for /api paths: /mcp keeps its
 * Bearer-only contract unchanged.
 */

export const SESSION_COOKIE_NAME = "urumi_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Minimal cookie header parser (no extra dependency): name=value pairs split on ";". */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (cookieHeader === undefined || cookieHeader.length === 0) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    if (part.slice(0, eq).trim() !== name) {
      continue;
    }
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Secure attributes for the session cookie (D23 / threat model):
 * - HttpOnly: JavaScript (and therefore any XSS payload) cannot read it;
 * - SameSite=Strict: the browser never attaches it to cross-site requests;
 * - Secure: only sent over https (localhost counts as a trustworthy origin,
 *   so this works in local development and behind the M7 ingress TLS);
 * - no Domain attribute: host-only cookie, cannot leak to sibling hosts.
 */
export function sessionSetCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}; Secure`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`;
}
