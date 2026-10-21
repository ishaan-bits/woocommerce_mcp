import type { ApiKeyPrincipal } from "@mcp/shared";
import type { AuthRepository } from "../db/auth-repository.ts";
import { dummyCompare, hashApiKey, hashesMatch, keyPrefixOf, looksLikeApiKey } from "./keys.ts";

/**
 * The one API-key verification path, shared by the request middleware and the
 * dashboard login endpoint (D23) so both apply the exact same fail-closed
 * checks: structure → prefix lookup → hash compare → revocation. The caller
 * decides what a denial means (audit row, HTTP status); this function never
 * leaks *which* check failed to the client — only the structured reason for
 * the audit record.
 */
export type VerifyApiKeyResult =
  | { readonly kind: "ok"; readonly principal: ApiKeyPrincipal }
  | { readonly kind: "denied"; readonly errorCode: string; readonly keyId: string | null }
  | { readonly kind: "db_error"; readonly error: unknown };

export async function verifyApiKey(repo: AuthRepository, pepper: string, key: string): Promise<VerifyApiKeyResult> {
  if (!looksLikeApiKey(key)) {
    return { kind: "denied", errorCode: "invalid_format", keyId: null };
  }

  const prefix = keyPrefixOf(key);
  const expectedHash = hashApiKey(key, pepper);

  let rows;
  try {
    rows = await repo.findByPrefix(prefix);
  } catch (error) {
    return { kind: "db_error", error };
  }

  if (rows.length === 0) {
    dummyCompare(expectedHash);
    return { kind: "denied", errorCode: "unknown_key", keyId: prefix };
  }

  let matched = null;
  for (const row of rows) {
    if (hashesMatch(expectedHash, row.keyHash)) {
      matched = row;
      break;
    }
  }
  if (matched === null) {
    return { kind: "denied", errorCode: "invalid_key", keyId: prefix };
  }
  if (matched.revokedAt !== null) {
    return { kind: "denied", errorCode: "revoked_key", keyId: matched.id };
  }

  return {
    kind: "ok",
    principal: {
      userId: matched.user.id,
      displayName: matched.user.displayName,
      role: matched.user.role,
      allowedUpstreams: matched.user.allowedUpstreams,
      allowedTools: matched.user.allowedTools,
      keyId: matched.id,
    },
  };
}

/**
 * Session-token verification (D23): hash → row → expiry → bound key still
 * valid. Every request re-derives the principal from the *key*, so grant
 * changes apply immediately and key revocation kills live sessions.
 */
export type VerifySessionResult =
  | { readonly kind: "ok"; readonly principal: ApiKeyPrincipal; readonly expired: boolean }
  | { readonly kind: "denied"; readonly errorCode: string; readonly keyId: string | null }
  | { readonly kind: "db_error"; readonly error: unknown };

export async function verifySession(
  repo: AuthRepository,
  sessions: { find(tokenHash: string): Promise<{ keyId: string; expiresAt: string } | null>; delete(tokenHash: string): Promise<boolean> },
  tokenHash: string,
  nowMs: number,
): Promise<VerifySessionResult> {
  let row;
  try {
    row = await sessions.find(tokenHash);
  } catch (error) {
    return { kind: "db_error", error };
  }
  if (row === null) {
    return { kind: "denied", errorCode: "unknown_session", keyId: null };
  }
  if (Date.parse(row.expiresAt) <= nowMs) {
    // Lazy cleanup: an expired session is removed the first time it is seen.
    await sessions.delete(tokenHash).catch(() => undefined);
    return { kind: "denied", errorCode: "expired_session", keyId: row.keyId };
  }

  let key;
  try {
    key = await repo.findKeyById(row.keyId);
  } catch (error) {
    return { kind: "db_error", error };
  }
  if (key === null) {
    return { kind: "denied", errorCode: "unknown_key", keyId: row.keyId };
  }
  if (key.revokedAt !== null) {
    return { kind: "denied", errorCode: "revoked_key", keyId: key.id };
  }

  return {
    kind: "ok",
    expired: false,
    principal: {
      userId: key.user.id,
      displayName: key.user.displayName,
      role: key.user.role,
      allowedUpstreams: key.user.allowedUpstreams,
      allowedTools: key.user.allowedTools,
      keyId: key.id,
    },
  };
}
