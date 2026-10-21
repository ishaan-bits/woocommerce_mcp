import type { ApiKeyPrincipal } from "@mcp/shared";
import type { NextFunction, Request, Response } from "express";
import type { AuditWriter } from "../audit.ts";
import type { AuthRepository } from "../db/auth-repository.ts";
import type { SessionRepository } from "../db/session-repository.ts";
import type { Logger } from "../logger.ts";
import { hashSessionToken, readCookie, SESSION_COOKIE_NAME } from "./sessions.ts";
import { verifyApiKey, verifySession } from "./verify.ts";

export interface AuthedRequest extends Request {
  principal?: ApiKeyPrincipal;
}

export interface AuthMiddlewareDeps {
  repo: AuthRepository;
  /** Dashboard cookie sessions (D23). When absent, only Bearer keys are honoured. */
  sessions?: SessionRepository;
  pepper: string;
  audit: AuditWriter;
  logger: Logger;
  /** Operational probes and the login endpoint stay unauthenticated (D21/D23). */
  publicPaths?: readonly string[];
}

const DEFAULT_PUBLIC_PATHS = ["/healthz", "/readyz", "/api/auth/login"];

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
 * valid, unrevoked credential — either a Bearer API key (the only credential
 * /mcp accepts, unchanged since Milestone 3) or, for /api paths only, the
 * dashboard session cookie (D23: opaque HttpOnly token → session row → bound
 * key re-checked on every request).
 *
 * Fail-closed on every path — missing, malformed, structurally invalid,
 * unknown, expired, revoked or unverifiable credentials all deny with the
 * *same* 401 body (no oracle for which check failed; the audit row records
 * the exact reason). A database outage denies with 503 because credentials
 * could not be evaluated at all.
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

    const dbError = (error: unknown, where: string): void => {
      // Fail closed: credentials could not be evaluated. The audit store is
      // the same database that just failed, so only a diagnostic is possible.
      deps.logger.error(where, { error: String(error) });
      if (!res.headersSent) {
        res.status(503).json({ error: "service_unavailable" });
      }
    };

    const parsed = parseBearer(req.headers.authorization);

    if (!parsed.ok && parsed.reason === "missing") {
      // No Authorization header at all: try the dashboard session cookie, but
      // only for the REST surface. /mcp never accepts a cookie, so its
      // contract from Milestone 3 is byte-for-byte unchanged. A *malformed*
      // Authorization header below denies outright — it never falls back to
      // the cookie.
      const cookieToken = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
      if (cookieToken === null || !req.path.startsWith("/api") || deps.sessions === undefined) {
        await deny({
          errorCode: "missing_credentials",
          keyId: null,
          status: 401,
          body: { error: "unauthorized" },
        });
        return;
      }

      const result = await verifySession(deps.repo, deps.sessions, hashSessionToken(cookieToken), Date.now());
      if (result.kind === "db_error") {
        dbError(result.error, "auth_session_lookup_failed");
        return;
      }
      if (result.kind === "denied") {
        await deny({ errorCode: result.errorCode, keyId: result.keyId, status: 401, body: { error: "unauthorized" } });
        return;
      }
      (req as AuthedRequest).principal = result.principal;
      next();
      return;
    }

    if (!parsed.ok) {
      await deny({ errorCode: "malformed_credentials", keyId: null, status: 401, body: { error: "unauthorized" } });
      return;
    }

    const result = await verifyApiKey(deps.repo, deps.pepper, parsed.key);
    if (result.kind === "db_error") {
      dbError(result.error, "auth_lookup_failed");
      return;
    }
    if (result.kind === "denied") {
      await deny({ errorCode: result.errorCode, keyId: result.keyId, status: 401, body: { error: "unauthorized" } });
      return;
    }
    (req as AuthedRequest).principal = result.principal;
    next();
  };
}

/** Fail-closed helper for handlers that must have a principal. */
export function principalOf(req: Request): ApiKeyPrincipal | null {
  return (req as AuthedRequest).principal ?? null;
}
