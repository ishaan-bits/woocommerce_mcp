import type { ApiKeyPrincipal } from "@mcp/shared";
import { API_PREFIX } from "@mcp/shared";
import { Router, type Request, type Response } from "express";
import type { AuditWriter } from "../audit.ts";
import { authorizeAdminApi } from "../auth/authorization.ts";
import { generateApiKey } from "../auth/keys.ts";
import { principalOf } from "../auth/middleware.ts";
import type { AuditRepository } from "../db/audit-repository.ts";
import type { AuthRepository } from "../db/auth-repository.ts";

export interface ApiRouterDeps {
  authRepo: AuthRepository;
  auditRepo: AuditRepository;
  audit: AuditWriter;
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

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  router.get("/me", (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({
      user_id: principal.userId,
      display_name: principal.displayName,
      role: principal.role,
      allowed_upstreams: principal.allowedUpstreams,
      allowed_tools: principal.allowedTools,
      key_id: principal.keyId,
    });
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
