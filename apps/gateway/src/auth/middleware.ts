import type { ApiKeyPrincipal } from "@mcp/shared";
import type { NextFunction, Request, Response } from "express";
import type { AuditWriter } from "../audit.ts";
import type { AuthRepository, StoredApiKey } from "../db/auth-repository.ts";
import { dummyCompare, hashApiKey, hashesMatch, keyPrefixOf, looksLikeApiKey } from "./keys.ts";
import type { Logger } from "../logger.ts";

export interface AuthedRequest extends Request {
  principal?: ApiKeyPrincipal;
}

export interface AuthMiddlewareDeps {
  repo: AuthRepository;
  pepper: string;
  audit: AuditWriter;
  logger: Logger;
  /** Operational probes stay unauthenticated (D21): aggregate status only. */
  publicPaths?: readonly string[];
}

const DEFAULT_PUBLIC_PATHS = ["/healthz", "/readyz"];

interface AuthFailure {
  readonly errorCode: string;
  readonly keyId: string | null;
  readonly status: 401 | 503;
  readonly body: { error: string };
}

function parseBearer(header: string | undefined): { ok: true; key: string } | { ok: false; reason: "missing" | "malformed" } {
  if (header === undefined || header.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const match = /^Bearer[ ]+(\S+)$/i.exec(header);
  const key = match?.[1];
  if (key === undefined || key.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, key };
}

/**
 * Boundary B2: every request except the operational probes must present a
 * valid, unrevoked API key. Fail-closed on every path — missing, malformed,
 * structurally invalid, unknown, revoked or unverifiable credentials all deny
 * with the *same* 401 body (no oracle for which check failed; the audit row
 * records the exact reason). A database outage denies with 503 because
 * credentials could not be evaluated at all.
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const publicPaths = deps.publicPaths ?? DEFAULT_PUBLIC_PATHS;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (publicPaths.includes(req.path)) {
      next();
      return;
    }

    const startedAt = Date.now();

    const deny = async (failure: AuthFailure): Promise<void> => {
      await deps.audit.record({
        action: "auth_failed",
        keyId: failure.keyId,
        userId: null,
        role: null,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "denied",
        durationMs: Date.now() - startedAt,
        errorCode: failure.errorCode,
      });
      if (!res.headersSent) {
        res.status(failure.status).json(failure.body);
      }
    };

    const parsed = parseBearer(req.headers.authorization);
    if (!parsed.ok) {
      await deny({
        errorCode: parsed.reason === "missing" ? "missing_credentials" : "malformed_credentials",
        keyId: null,
        status: 401,
        body: { error: "unauthorized" },
      });
      return;
    }

    if (!looksLikeApiKey(parsed.key)) {
      await deny({ errorCode: "invalid_format", keyId: null, status: 401, body: { error: "unauthorized" } });
      return;
    }

    const prefix = keyPrefixOf(parsed.key);
    const expectedHash = hashApiKey(parsed.key, deps.pepper);

    let rows: StoredApiKey[];
    try {
      rows = await deps.repo.findByPrefix(prefix);
    } catch (error) {
      // Fail closed: credentials could not be evaluated. The audit store is
      // the same database that just failed, so only a diagnostic is possible.
      deps.logger.error("auth_lookup_failed", { error: String(error) });
      if (!res.headersSent) {
        res.status(503).json({ error: "service_unavailable" });
      }
      return;
    }

    if (rows.length === 0) {
      dummyCompare(expectedHash);
      await deny({ errorCode: "unknown_key", keyId: prefix, status: 401, body: { error: "unauthorized" } });
      return;
    }

    let matched: StoredApiKey | null = null;
    for (const row of rows) {
      if (hashesMatch(expectedHash, row.keyHash)) {
        matched = row;
        break;
      }
    }

    if (matched === null) {
      await deny({ errorCode: "invalid_key", keyId: prefix, status: 401, body: { error: "unauthorized" } });
      return;
    }

    if (matched.revokedAt !== null) {
      await deny({ errorCode: "revoked_key", keyId: matched.id, status: 401, body: { error: "unauthorized" } });
      return;
    }

    const principal: ApiKeyPrincipal = {
      userId: matched.user.id,
      displayName: matched.user.displayName,
      role: matched.user.role,
      allowedUpstreams: matched.user.allowedUpstreams,
      allowedTools: matched.user.allowedTools,
      keyId: matched.id,
    };
    (req as AuthedRequest).principal = principal;
    next();
  };
}

/** Fail-closed helper for handlers that must have a principal. */
export function principalOf(req: Request): ApiKeyPrincipal | null {
  return (req as AuthedRequest).principal ?? null;
}
