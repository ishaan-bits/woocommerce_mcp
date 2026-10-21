import { API_PREFIX, UPSTREAM_IDS, type ApiKeyPrincipal, type AuditAction } from "@mcp/shared";
import { Router, type Request, type Response } from "express";
import type { AuditWriter } from "../audit.ts";
import { authorizeAdminApi } from "../auth/authorization.ts";
import { generateApiKey } from "../auth/keys.ts";
import { principalOf } from "../auth/middleware.ts";
import {
  createSessionToken,
  hashSessionToken,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionClearCookie,
  sessionSetCookie,
  SESSION_TTL_MS,
} from "../auth/sessions.ts";
import { verifyApiKey } from "../auth/verify.ts";
import type { AuditRepository } from "../db/audit-repository.ts";
import type { AuthRepository } from "../db/auth-repository.ts";
import type { SessionRepository } from "../db/session-repository.ts";
import type { UpstreamStateRepository } from "../db/upstream-state-repository.ts";
import type { Logger } from "../logger.ts";
import type { UpstreamRegistry } from "../upstream-registry.ts";

export interface ApiRouterDeps {
  authRepo: AuthRepository;
  auditRepo: AuditRepository;
  audit: AuditWriter;
  /** Dashboard sessions (D23): login/logout and cookie-session storage. */
  sessions: SessionRepository;
  /** Persisted upstream toggles (D24). */
  upstreamState: UpstreamStateRepository;
  /** The same registry /mcp serves (D6): tool mirror and toggle target. */
  registry: UpstreamRegistry;
  logger: Logger;
  pepper: string;
  now?: () => number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin gate with audit (C2: denials still produce a row with outcome
 * "denied"). Returns the principal when allowed, null after responding 403.
 */
async function requireAdmin(req: Request, res: Response, audit: AuditWriter, principal: ApiKeyPrincipal): Promise<boolean> {
  const decision = authorizeAdminApi(principal);
  if (decision.allowed) {
    return true;
  }
  await audit.record({
    action: "access_denied",
    keyId: principal.keyId,
    userId: principal.userId,
    role: principal.role,
    upstreamId: null,
    toolName: null,
    qualifiedName: null,
    outcome: "denied",
    durationMs: 0,
    errorCode: decision.errorCode,
  });
  res.status(403).json({ error: "forbidden" });
  return false;
}

function meBody(principal: ApiKeyPrincipal): Record<string, unknown> {
  return {
    user_id: principal.userId,
    display_name: principal.displayName,
    role: principal.role,
    allowed_upstreams: principal.allowedUpstreams,
    allowed_tools: principal.allowedTools,
    key_id: principal.keyId,
  };
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  /**
   * Dashboard login (D23): exchange an API key for an HttpOnly session
   * cookie. The key is read from a JSON body (never a URL), verified through
   * the *same* fail-closed checks as the middleware, and then discarded — the
   * browser only ever holds the opaque session token. Failures audit like
   * every other auth failure; success stores sha256(token) bound to the key.
   */
  router.post("/auth/login", async (req, res) => {
    const startedAt = now();
    const body = req.body as { key?: unknown } | undefined;
    const key = typeof body?.key === "string" ? body.key : null;
    if (key === null) {
      res.status(400).json({ error: "key must be a string" });
      return;
    }

    const result = await verifyApiKey(deps.authRepo, deps.pepper, key);
    if (result.kind === "db_error") {
      deps.logger.error("login_lookup_failed", { error: String(result.error) });
      res.status(503).json({ error: "service_unavailable" });
      return;
    }
    if (result.kind === "denied") {
      await deps.audit.record({
        action: "auth_failed",
        keyId: result.keyId,
        userId: null,
        role: null,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "denied",
        durationMs: now() - startedAt,
        errorCode: result.errorCode,
      });
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const token = createSessionToken();
    try {
      await deps.sessions.create({
        tokenHash: hashSessionToken(token),
        userId: result.principal.userId,
        keyId: result.principal.keyId,
        expiresAt: new Date(startedAt + SESSION_TTL_MS).toISOString(),
      });
      await deps.sessions.deleteExpired(new Date(now()).toISOString());
    } catch (error) {
      deps.logger.error("login_session_store_failed", { error: String(error) });
      res.status(503).json({ error: "service_unavailable" });
      return;
    }

    res.setHeader("Set-Cookie", sessionSetCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
    res.json(meBody(result.principal));
  });

  /** Server-side logout: the session row is removed before the cookie is cleared. */
  router.post("/auth/logout", async (req, res) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (token !== null) {
      try {
        await deps.sessions.delete(hashSessionToken(token));
      } catch (error) {
        deps.logger.error("logout_session_delete_failed", { error: String(error) });
        res.status(503).json({ error: "service_unavailable" });
        return;
      }
    }
    res.setHeader("Set-Cookie", sessionClearCookie());
    res.json({ ok: true });
  });

  router.get("/me", (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(meBody(principal));
  });

  /**
   * Read-only mirror of the aggregated registry (D6) for the dashboard: the
   * same list /mcp serves, plus per-upstream reachability so the UI can show
   * degraded upstreams. Not audited — it executes nothing and exposes no
   * arguments, responses or internal URLs (descriptions/schemas are the
   * upstreams' own published contract, already visible to any MCP client).
   */
  router.get("/tools", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const tools = await deps.registry.listAggregatedTools();
      const health = deps.registry.health();
      res.json({
        tools: tools.map((tool) => ({
          qualified_name: tool.qualifiedName,
          name: tool.name,
          upstream_id: tool.upstreamId,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        upstreams: health.map((entry) => ({
          id: entry.id,
          enabled: entry.enabled,
          reachable: entry.reachable,
          last_error: entry.lastErrorMessage,
        })),
      });
    } catch (error) {
      deps.logger.error("tools_mirror_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
    }
  });

  /** Status for every configured *and* unconfigured upstream id (fast: no connections). */
  router.get("/upstreams", (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const health = deps.registry.health();
    res.json({
      upstreams: UPSTREAM_IDS.map((id) => {
        const entry = health.find((candidate) => candidate.id === id);
        return {
          id,
          configured: entry !== undefined,
          enabled: entry?.enabled ?? false,
          reachable: entry?.reachable ?? false,
          last_error: entry?.lastErrorMessage ?? null,
        };
      }),
    });
  });

  /**
   * Upstream enable/disable (D24, architecture §6): admin-only, the id must
   * be one of the fixed UPSTREAM_IDS *and* currently configured via env — a
   * toggle can never point the gateway at an arbitrary URL. The new state is
   * persisted first (survives restart), applied live to the registry second,
   * and audited as upstream_enabled/upstream_disabled. Idempotent: re-sending
   * the current state changes nothing and writes no audit row.
   */
  router.post("/upstreams/:spec", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }

    const spec = req.params.spec ?? "";
    const separator = spec.lastIndexOf(":");
    const rawId = separator > 0 ? spec.slice(0, separator) : "";
    const action = separator > 0 ? spec.slice(separator + 1) : "";
    if (action !== "enable" && action !== "disable") {
      res.status(400).json({ error: "spec must be <upstream>:enable or <upstream>:disable" });
      return;
    }
    const upstreamId = UPSTREAM_IDS.find((candidate) => candidate === rawId);
    if (upstreamId === undefined) {
      res.status(400).json({ error: "unknown_upstream" });
      return;
    }

    const configuredState = deps.registry.health().find((entry) => entry.id === upstreamId);
    if (configuredState === undefined) {
      res.status(409).json({ error: "upstream_not_configured" });
      return;
    }

    const target = action === "enable";
    if (configuredState.enabled === target) {
      res.json({ id: upstreamId, enabled: target, changed: false });
      return;
    }

    const startedAt = now();
    const auditAction: AuditAction = target ? "upstream_enabled" : "upstream_disabled";
    try {
      await deps.upstreamState.setOverride(upstreamId, target, principal.userId);
    } catch (error) {
      deps.logger.error("upstream_toggle_persist_failed", { upstream_id: upstreamId, error: String(error) });
      await deps.audit.record({
        action: auditAction,
        keyId: principal.keyId,
        userId: principal.userId,
        role: principal.role,
        upstreamId,
        toolName: null,
        qualifiedName: null,
        outcome: "error",
        durationMs: now() - startedAt,
        errorCode: "persist_failed",
      });
      res.status(500).json({ error: "internal_error" });
      return;
    }

    const applied = deps.registry.setEnabled(upstreamId, target);
    if (!applied) {
      await deps.audit.record({
        action: auditAction,
        keyId: principal.keyId,
        userId: principal.userId,
        role: principal.role,
        upstreamId,
        toolName: null,
        qualifiedName: null,
        outcome: "error",
        durationMs: now() - startedAt,
        errorCode: "apply_failed",
      });
      res.status(500).json({ error: "internal_error" });
      return;
    }

    await deps.audit.record({
      action: auditAction,
      keyId: principal.keyId,
      userId: principal.userId,
      role: principal.role,
      upstreamId,
      toolName: null,
      qualifiedName: null,
      outcome: "success",
      durationMs: now() - startedAt,
      errorCode: null,
    });
    res.json({ id: upstreamId, enabled: target, changed: true });
  });

  router.get("/keys", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }
    res.json({ keys: await deps.authRepo.listKeys() });
  });

  router.post("/keys", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }

    const startedAt = now();
    const body = req.body as { user_id?: unknown } | undefined;
    const userId = typeof body?.user_id === "string" ? body.user_id : "";
    if (!UUID_PATTERN.test(userId)) {
      res.status(400).json({ error: "user_id must be a UUID" });
      return;
    }
    if (!(await deps.authRepo.userExists(userId))) {
      res.status(404).json({ error: "unknown_user" });
      return;
    }

    // Plaintext key: built here, returned once below, never stored or logged.
    const generated = generateApiKey(deps.pepper);
    const created = await deps.authRepo.createKey(userId, generated.keyPrefix, generated.keyHash);

    await deps.audit.record({
      action: "key_created",
      keyId: created.id,
      userId: principal.userId,
      role: principal.role,
      upstreamId: null,
      toolName: null,
      qualifiedName: null,
      outcome: "success",
      durationMs: now() - startedAt,
      errorCode: null,
    });

    res.status(201).json({
      id: created.id,
      user_id: userId,
      key_prefix: generated.keyPrefix,
      created_at: created.createdAt,
      revoked_at: null,
      key: generated.key,
    });
  });

  router.post("/keys/:id/revoke", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }

    const keyId = req.params.id ?? "";
    if (!UUID_PATTERN.test(keyId)) {
      res.status(400).json({ error: "invalid key id" });
      return;
    }

    const startedAt = now();
    const result = await deps.authRepo.revokeKey(keyId);
    if (!result.found) {
      res.status(404).json({ error: "unknown_key" });
      return;
    }

    if (result.revokedNow) {
      await deps.audit.record({
        action: "key_revoked",
        keyId,
        userId: principal.userId,
        role: principal.role,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "success",
        durationMs: now() - startedAt,
        errorCode: null,
      });
    }

    res.json({ id: keyId, revoked_at: result.revokedAt, already_revoked: !result.revokedNow });
  });

  router.get("/audit", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }

    const rawLimit = req.query.limit;
    const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 50;
    if (limit < 1 || limit > 100) {
      res.status(400).json({ error: "limit must be between 1 and 100" });
      return;
    }
    const rawBefore = req.query.before;
    if (rawBefore !== undefined && (typeof rawBefore !== "string" || !/^\d{1,19}$/.test(rawBefore))) {
      res.status(400).json({ error: "before must be an audit id (digits)" });
      return;
    }

    const entries = await deps.auditRepo.recent(limit, rawBefore as string | undefined);
    res.json({ entries });
  });

  return router;
}

export { API_PREFIX };
