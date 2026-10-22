import { API_PREFIX, UPSTREAM_IDS, type ApiKeyPrincipal, type AuditAction, type ToolCallOutcome } from "@mcp/shared";
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { AgentInputError, AgentTurnError, type ChatAgent } from "../agent/agent.ts";
import { ProviderError } from "../agent/provider.ts";
import type { AuditWriter } from "../audit.ts";
import { authorizeAdminApi } from "../auth/authorization.ts";
import { generateApiKey } from "../auth/keys.ts";
import { principalOf } from "../auth/middleware.ts";
import {
  cookieSecureRequested,
  createSessionToken,
  hashSessionToken,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionClearCookie,
  sessionSetCookie,
  SESSION_TTL_MS,
} from "../auth/sessions.ts";
import { verifyApiKey } from "../auth/verify.ts";
import { validateUpstreamUrlValue } from "../config.ts";
import type { AuditFilters, AuditRepository } from "../db/audit-repository.ts";
import { UserConflictError, type AuthRepository } from "../db/auth-repository.ts";
import {
  DuplicateUpstreamUrlError,
  type DynamicUpstreamRecord,
  type DynamicUpstreamRepository,
} from "../db/dynamic-upstream-repository.ts";
import type { SessionRepository } from "../db/session-repository.ts";
import type { UpstreamStateRepository } from "../db/upstream-state-repository.ts";
import type { TokenBucketLimiter } from "../limits.ts";
import type { Logger } from "../logger.ts";
import type { UpstreamRegistry } from "../upstream-registry.ts";
import { unionUpstreamIds } from "../routing.ts";
import {
  parseCredentialInput,
  parseCredentialPatch,
  type CredentialVault,
  type UpstreamCredential,
} from "../upstream-credentials.ts";

export interface ApiRouterDeps {
  authRepo: AuthRepository;
  auditRepo: AuditRepository;
  audit: AuditWriter;
  /** Dashboard sessions (D23): login/logout and cookie-session storage. */
  sessions: SessionRepository;
  /** Persisted upstream toggles (D24). */
  upstreamState: UpstreamStateRepository;
  /**
   * Milestone 11 (D34): admin-registered upstream CRUD. Undefined = the
   * feature is unavailable in this wiring (routes answer 503; tests that
   * predate it keep passing).
   */
  dynamicUpstreams?: DynamicUpstreamRepository;
  /** D34: encrypt/decrypt vault; null = UPSTREAM_CREDENTIAL_KEY not set. */
  credentialVault?: CredentialVault | null;
  /** D34: TLS policy for admin-entered URLs ("https-only" in production). */
  dynamicUpstreamTlsPolicy?: "allow-http" | "https-only";
  /** D34: C4 allow-list applied to admin-entered URLs at validation time. */
  upstreamAllowedPrivateHosts?: readonly string[];
  /** D34: per-call/connect timeouts for newly registered servers. */
  upstreamTimeoutMs?: number;
  upstreamConnectTimeoutMs?: number;
  /** The same registry /mcp serves (D6): tool mirror and toggle target. */
  registry: UpstreamRegistry;
  logger: Logger;
  pepper: string;
  /** C7/B1: failed-logins-per-IP throttle; null/undefined disables. */
  loginLimiter?: TokenBucketLimiter | null;
  /**
   * Milestone 9 chat agent (D29): null/undefined = not configured — the
   * route answers 503 with a configuration hint and everything else works.
   */
  agent?: ChatAgent | null;
  /**
   * Display label for the WooCommerce upstream's backing store
   * ("mock" | "real" | null). Deploy-time configuration only — purely
   * presentational for the dashboard; the gateway never switches URLs.
   */
  woocommerceStoreMode?: "mock" | "real" | null;
  /**
   * Externally reachable base URL of this gateway (GATEWAY_PUBLIC_URL), used
   * to render accurate MCP-client connection instructions. null = unknown.
   */
  gatewayPublicUrl?: string | null;
  /**
   * Secure-flag policy for the session cookie (D33): undefined = "auto"
   * (Secure only when the request arrived over HTTPS).
   */
  sessionCookieSecure?: "auto" | "true" | "false";
  now?: () => number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_PATTERN = /^[\w.@ -]{3,48}$/;
const USER_ID_FILTER_PATTERN = /^[0-9a-z_-]{1,64}$/i;
/** Dynamic (admin-registered) upstream ids: lowercase slug, max 32 chars. */
const DYNAMIC_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Slug for an admin-entered server name → dynamic upstream id (D34).
 * Example: "Acme Shop 2" → "acme-shop-2". Always matches DYNAMIC_ID_PATTERN.
 */
function dynamicUpstreamIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (slug.length === 0) {
    return "server";
  }
  if (!/^[a-z]/.test(slug)) {
    return `s-${slug}`.slice(0, 32).replace(/-+$/g, "");
  }
  return slug;
}

const AUDIT_ACTIONS: readonly AuditAction[] = [
  "tool_call",
  "auth_failed",
  "access_denied",
  "key_created",
  "key_revoked",
  "upstream_enabled",
  "upstream_disabled",
  "user_created",
  "user_updated",
  "upstream_created",
  "upstream_updated",
  "upstream_deleted",
];
const AUDIT_OUTCOMES: readonly ToolCallOutcome[] = ["success", "error", "timeout", "denied"];

/** Parse + validate GET /api/audit filters against fixed whitelists (never free-form SQL). */
function parseAuditFilters(
  query: Request["query"],
  knownUpstreamIds: readonly string[],
): { ok: true; filters: AuditFilters } | { ok: false; error: string } {
  const filters: {
    action?: AuditAction;
    outcome?: ToolCallOutcome;
    userId?: string;
    upstreamId?: string;
    tool?: string;
  } = {};

  const action = query.action;
  if (action !== undefined) {
    if (typeof action !== "string" || !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, error: "action must be one of the known audit actions" };
    }
    filters.action = action as AuditAction;
  }
  const outcome = query.outcome;
  if (outcome !== undefined) {
    if (typeof outcome !== "string" || !(AUDIT_OUTCOMES as readonly string[]).includes(outcome)) {
      return { ok: false, error: "outcome must be success, error, timeout or denied" };
    }
    filters.outcome = outcome as ToolCallOutcome;
  }
  const userId = query.userId;
  if (userId !== undefined) {
    if (typeof userId !== "string" || !USER_ID_FILTER_PATTERN.test(userId)) {
      return { ok: false, error: "userId must be a user id (letters, digits, dashes)" };
    }
    filters.userId = userId;
  }
  const upstream = query.upstreamId;
  if (upstream !== undefined) {
    if (typeof upstream !== "string" || !knownUpstreamIds.includes(upstream)) {
      return { ok: false, error: "upstreamId must be a known upstream id" };
    }
    filters.upstreamId = upstream;
  }
  const tool = query.tool;
  if (tool !== undefined) {
    if (typeof tool !== "string" || tool.trim() === "" || tool.length > 64) {
      return { ok: false, error: "tool must be a non-empty term of at most 64 characters" };
    }
    filters.tool = tool.trim();
  }
  return { ok: true, filters };
}

interface UserBodyFields {
  displayName?: string;
  role?: "admin" | "reader";
  allowedUpstreams?: readonly string[];
  allowedTools?: readonly string[];
}

/**
 * Validate the shared body fields of POST /users and PATCH /users/:id.
 * `knownUpstreamIds` is the registry's live set (fixed + admin-registered),
 * so a member can be granted a dynamic server exactly like a fixed one.
 */
function parseUserBody(
  body: unknown,
  requireDisplayName: boolean,
  knownUpstreamIds: readonly string[],
):
  | { ok: true; fields: UserBodyFields }
  | { ok: false; status: number; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const fields: UserBodyFields = {};

  if (raw.display_name !== undefined || requireDisplayName) {
    if (typeof raw.display_name !== "string" || !DISPLAY_NAME_PATTERN.test(raw.display_name.trim())) {
      return { ok: false, status: 400, error: "display_name must be 3-48 characters (letters, digits, spaces, . _ @ -)" };
    }
    fields.displayName = raw.display_name.trim();
  }
  if (raw.role !== undefined || requireDisplayName) {
    if (raw.role !== "admin" && raw.role !== "reader") {
      return { ok: false, status: 400, error: 'role must be "admin" or "reader"' };
    }
    fields.role = raw.role;
  }
  if (raw.allowed_upstreams !== undefined) {
    if (!Array.isArray(raw.allowed_upstreams)) {
      return { ok: false, status: 400, error: "allowed_upstreams must be an array" };
    }
    const seen = new Set<string>();
    for (const entry of raw.allowed_upstreams) {
      if (typeof entry !== "string" || !knownUpstreamIds.includes(entry)) {
        return {
          ok: false,
          status: 400,
          error: "allowed_upstreams entries must be a known upstream id (woocommerce, inventory, support or an admin-registered server)",
        };
      }
      if (seen.has(entry)) {
        return { ok: false, status: 400, error: "allowed_upstreams must not contain duplicates" };
      }
      seen.add(entry);
    }
    fields.allowedUpstreams = raw.allowed_upstreams as string[];
  }
  if (raw.allowed_tools !== undefined) {
    if (!Array.isArray(raw.allowed_tools) || raw.allowed_tools.length > 64) {
      return { ok: false, status: 400, error: "allowed_tools must be an array of at most 64 entries" };
    }
    for (const entry of raw.allowed_tools) {
      if (typeof entry !== "string" || !entry.startsWith("tools:") || entry.length > 160) {
        return { ok: false, status: 400, error: 'allowed_tools entries must look like "tools:<qualified_name>"' };
      }
    }
    fields.allowedTools = raw.allowed_tools as string[];
  }
  if (!requireDisplayName && Object.keys(fields).length === 0) {
    return { ok: false, status: 400, error: "at least one of display_name, role, allowed_upstreams, allowed_tools is required" };
  }
  return { ok: true, fields };
}

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

    // B1/C7: throttle failed logins per client IP. A token is consumed per
    // attempt and the bucket is cleared on success, so only failures count
    // against the limit. With TRUST_PROXY set, req.ip comes from X-Forwarded-For.
    const clientIp = req.ip ?? "unknown";
    if (deps.loginLimiter != null && !deps.loginLimiter.tryTake(clientIp)) {
      await deps.audit.record({
        action: "auth_failed",
        keyId: null,
        userId: null,
        role: null,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "denied",
        durationMs: now() - startedAt,
        errorCode: "rate_limited",
      });
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }

    const result = await verifyApiKey(deps.authRepo, deps.pepper, key);
    if (result.kind === "ok") {
      deps.loginLimiter?.reset(clientIp);
    }
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

    res.setHeader(
      "Set-Cookie",
      sessionSetCookie(
        token,
        Math.floor(SESSION_TTL_MS / 1000),
        cookieSecureRequested(deps.sessionCookieSecure ?? "auto", req.secure === true),
      ),
    );
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
    res.setHeader(
      "Set-Cookie",
      sessionClearCookie(cookieSecureRequested(deps.sessionCookieSecure ?? "auto", req.secure === true)),
    );
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
   * Self-serve API keys (requirement matrix M1/X4). Any authenticated member
   * — not only admins — can list their OWN keys and mint a new one. The user
   * id always comes from the credential, never the body: a member cannot
   * issue a key for someone else, and the plaintext is returned exactly once
   * (only the prefix and sha256 hash are stored). Audited as key_created.
   */
  router.get("/me/keys", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const keys = await deps.authRepo.listKeysForUser(principal.userId);
    res.json({
      keys: keys.map((key) => ({
        id: key.id,
        key_prefix: key.keyPrefix,
        created_at: key.createdAt,
        revoked_at: key.revokedAt,
      })),
    });
  });

  router.post("/me/keys", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const startedAt = now();
    // Plaintext key: built here, returned once below, never stored or logged.
    const generated = generateApiKey(deps.pepper);
    const created = await deps.authRepo.createKey(principal.userId, generated.keyPrefix, generated.keyHash);

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
      user_id: principal.userId,
      key_prefix: generated.keyPrefix,
      created_at: created.createdAt,
      revoked_at: null,
      key: generated.key,
    });
  });

  /**
   * Connection instructions for external MCP clients (Settings page). The
   * public base URL is deploy-time configuration (GATEWAY_PUBLIC_URL) — when
   * it is unknown the endpoint returns null and the dashboard shows generic
   * guidance rather than inventing a localhost URL as if it were public.
   * Never includes credentials or internal upstream addresses.
   */
  router.get("/settings", (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const base = deps.gatewayPublicUrl ?? null;
    res.json({
      mcp_endpoint: base === null ? null : `${base.replace(/\/$/, "")}/mcp`,
      mcp_path: "/mcp",
      transport: "streamable-http",
      auth: "bearer",
      session_header: "mcp-session-id",
      chat_enabled: deps.agent !== null && deps.agent !== undefined,
    });
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
      // Admin-registered servers carry a human name; fixed env servers use
      // their id as the label. The name comes from the DB (never the URL).
      const dynamicNames = new Map<string, string>();
      if (deps.dynamicUpstreams !== undefined) {
        try {
          for (const row of await deps.dynamicUpstreams.list()) {
            dynamicNames.set(row.id, row.name);
          }
        } catch (error) {
          deps.logger.error("dynamic_upstreams_list_failed", { error: String(error) });
        }
      }
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
          display_name: dynamicNames.get(entry.id) ?? entry.id,
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

  /**
   * Milestone 9 chat agent (D29/D30): authenticated natural-language chat.
   * The loop runs server-side; every model-requested tool call goes through
   * the shared executeToolCall pipeline (same authorization, rate limit and
   * exactly-one audit row as /mcp). The provider key never leaves the server;
   * provider failures map to coarse codes with generic messages.
   */
  router.post("/chat", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const agent = deps.agent ?? null;
    if (agent === null) {
      res.status(503).json({
        error: "agent_not_configured",
        message:
          "The chat agent is not configured. Set GROQ_API_KEY (or LLM_BASE_URL for a local OpenAI-compatible server) in the gateway environment and restart it.",
      });
      return;
    }

    const body = req.body as { message?: unknown; history?: unknown } | undefined;
    try {
      // Type-level only: the agent validates shape/length and answers 400.
      const result = await agent.run(
        { message: body?.message as string, history: body?.history as never },
        principal,
      );
      res.json({
        reply: result.reply,
        tool_calls: result.toolCalls,
        rounds: result.rounds,
      });
    } catch (error) {
      if (error instanceof AgentInputError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof ProviderError) {
        // Log the coarse kind + HTTP status server-side; never the body or key.
        deps.logger.error("chat_provider_failed", {
          kind: error.kind,
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
        });
        // A turn that failed after some tool calls ran keeps its gateway-
        // computed tool state in the error body (outcome chips survive; the
        // model never relabels them).
        const partial = error instanceof AgentTurnError ? { tool_calls: error.toolCalls, rounds: error.rounds } : {};
        const retryAfterSeconds =
          error.retryAfterMs !== undefined ? Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) : undefined;
        switch (error.kind) {
          case "rate_limited":
            if (retryAfterSeconds !== undefined) {
              res.setHeader("Retry-After", String(retryAfterSeconds));
            }
            res.status(429).json({
              error: "provider_rate_limited",
              message: "The LLM provider is rate limiting requests; try again shortly.",
              ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
              ...partial,
            });
            return;
          case "timeout":
            res.status(504).json({
              error: "provider_timeout",
              message: "The LLM provider did not respond in time; try again.",
              ...partial,
            });
            return;
          default:
            res.status(502).json({
              error: "provider_error",
              message: "The LLM provider could not complete the request; try again.",
              ...partial,
            });
            return;
        }
      }
      deps.logger.error("chat_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
    }
  });

  /**
   * Status for every configured *and* unconfigured upstream id (fast: no
   * connections), plus every admin-registered dynamic server (D34). Members
   * see id/enabled/reachable only; admins additionally see the stored URL
   * and whether a credential is configured (never the URL… never the value).
   */
  router.get("/upstreams", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const isAdmin = principal.role === "admin";
    const health = deps.registry.health();

    const rows: Array<{
      id: string;
      name: string;
      configured: boolean;
      enabled: boolean;
      reachable: boolean;
      last_error: string | null;
      mode: string | null;
      source: "env" | "admin";
      url?: string;
      has_credential?: boolean;
      credential_mode?: "bearer" | "header" | null;
    }> = [];

    for (const id of UPSTREAM_IDS) {
      const entry = health.find((candidate) => candidate.id === id);
      rows.push({
        id,
        name: id,
        configured: entry !== undefined,
        enabled: entry?.enabled ?? false,
        reachable: entry?.reachable ?? false,
        last_error: entry?.lastErrorMessage ?? null,
        // Display label for the WooCommerce upstream only (mock vs real
        // store) — deploy-time config, never a runtime switch.
        mode: id === "woocommerce" ? (deps.woocommerceStoreMode ?? null) : null,
        source: "env",
      });
    }

    if (deps.dynamicUpstreams !== undefined) {
      try {
        for (const record of await deps.dynamicUpstreams.list()) {
          const entry = health.find((candidate) => candidate.id === record.id);
          rows.push({
            id: record.id,
            name: record.name,
            configured: true,
            enabled: record.enabled,
            reachable: entry?.reachable ?? false,
            last_error: entry?.lastErrorMessage ?? null,
            mode: null,
            source: "admin",
            // Admin-only detail: the upstream URL (C4) and whether a static
            // credential is stored — the decrypted value is never returned.
            ...(isAdmin
              ? {
                  url: record.url,
                  has_credential: record.credentialCipher !== null,
                  credential_mode: record.credentialMode,
                }
              : {}),
          });
        }
      } catch (error) {
        // Fail-closed-ish: if the dynamic table is unreachable we still show
        // the fixed env upstreams rather than 500ing the whole status page.
        deps.logger.error("dynamic_upstreams_list_failed", { error: String(error) });
      }
    }

    res.json({ upstreams: rows });
  });

  /**
   * Upstream enable/disable (D24, architecture §6): admin-only. Works for a
   * fixed UPSTREAM_IDS entry (env-configured) *or* an admin-registered
   * dynamic server (D34) — the target is always a known id, never a URL, so
   * this can never point the gateway at an arbitrary address. The new state
   * is persisted first (survives restart), applied live to the registry
   * second, and audited as upstream_enabled/upstream_disabled. Idempotent:
   * re-sending the current state changes nothing and writes no audit row.
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

    const isFixed = (UPSTREAM_IDS as readonly string[]).includes(rawId);
    const configuredState = deps.registry.health().find((entry) => entry.id === rawId);
    const dynamicRow =
      !isFixed && deps.dynamicUpstreams !== undefined
        ? await deps.dynamicUpstreams.findById(rawId).catch(() => null)
        : null;
    if (!isFixed && dynamicRow === null) {
      res.status(400).json({ error: "unknown_upstream" });
      return;
    }
    const upstreamId = rawId;
    if (configuredState === undefined && dynamicRow === null) {
      // A fixed id whose env URL is not configured in this deploy.
      res.status(409).json({ error: "upstream_not_configured" });
      return;
    }

    const target = action === "enable";
    if (configuredState?.enabled === target) {
      res.json({ id: upstreamId, enabled: target, changed: false });
      return;
    }

    const startedAt = now();
    const auditAction: AuditAction = target ? "upstream_enabled" : "upstream_disabled";
    try {
      if (dynamicRow !== null && deps.dynamicUpstreams !== undefined) {
        await deps.dynamicUpstreams.setEnabled(upstreamId, target, principal.userId);
      } else {
        await deps.upstreamState.setOverride(upstreamId, target, principal.userId);
      }
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

  // ---------------------------------------------------------------------
  // Milestone 11 (D34 / PDF §Gateway): admin-registered MCP upstreams.
  //
  // Admins can add / edit / disable / remove extra MCP servers at runtime by
  // URL + optional static credential (header or bearer token). The flow is:
  // validate the URL against the same SSRF/TLS policy as env-configured
  // servers, AES-256-GCM-encrypt the credential (ciphertext only in the DB,
  // never logged or echoed), persist the row, then register it live in the
  // tool registry so /mcp and the dashboard pick it up immediately.
  //
  // Fixed deploy-time ids (woocommerce / inventory / support) are immutable
  // through these routes: they belong to env config, not the database. The
  // dynamic `source: "admin"` rows are additive and never collide with them
  // (ids are slugged from the name; `UPSTREAM_ALLOWED_PRIVATE_HOSTS` and
  // `DYNAMIC_UPSTREAM_TLS_POLICY` keep the same security posture as D6).
  // ---------------------------------------------------------------------

  /** Persisted credential store is optional: absent = feature unavailable. */
  function requireDynamicRepo(res: Response): DynamicUpstreamRepository | null {
    if (deps.dynamicUpstreams === undefined) {
      res.status(503).json({
        error: "dynamic_upstreams_unavailable",
        message: "Upstream registration is not configured for this gateway.",
      });
      return null;
    }
    return deps.dynamicUpstreams;
  }

  /** A stored credential needs the vault; absent key = fail closed. */
  function requireVault(res: Response): CredentialVault | null {
    const vault = deps.credentialVault ?? null;
    if (vault === null) {
      res.status(503).json({
        error: "credential_vault_unavailable",
        message: "UPSTREAM_CREDENTIAL_KEY is not configured; cannot store upstream credentials.",
      });
      return null;
    }
    return vault;
  }

  function urlPolicy(): { allowedPrivateHosts: readonly string[]; requireTls: boolean } {
    return {
      allowedPrivateHosts: deps.upstreamAllowedPrivateHosts ?? [],
      requireTls: (deps.dynamicUpstreamTlsPolicy ?? "allow-http") === "https-only",
    };
  }

  /** Pick a unique id from the name slug, suffixing -2, -3 … on collision. */
  async function uniqueDynamicId(
    repo: DynamicUpstreamRepository,
    base: string,
  ): Promise<string> {
    const taken = new Set<string>(UPSTREAM_IDS);
    for (const row of await repo.list()) {
      taken.add(row.id);
    }
    if (!taken.has(base)) {
      return base;
    }
    for (let suffix = 2; suffix < 50; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  function dynamicRowToResponse(row: DynamicUpstreamRecord): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: row.enabled,
      credential_mode: row.credentialMode,
      has_credential: row.credentialCipher !== null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      source: "admin",
    };
  }

  /** Encrypt a plaintext credential for `id`; returns the columns to store. */
  function encryptCredentialColumns(
    vault: CredentialVault | null,
    id: string,
    credential: UpstreamCredential | null,
  ): {
    credentialCipher: Buffer | null;
    credentialMode: "bearer" | "header" | null;
    credentialHeaderName: string | null;
  } {
    if (credential === null || vault === null) {
      return { credentialCipher: null, credentialMode: null, credentialHeaderName: null };
    }
    return {
      credentialCipher: vault.encrypt(credential.value, id),
      credentialMode: credential.mode,
      credentialHeaderName: credential.headerName,
    };
  }

  function registryConfigFor(row: { id: string; url: string; enabled: boolean }): {
    id: string;
    baseUrl: string;
    enabled: boolean;
    timeoutMs: number;
    connectTimeoutMs: number;
  } {
    return {
      id: row.id,
      baseUrl: row.url,
      enabled: row.enabled,
      timeoutMs: deps.upstreamTimeoutMs ?? 10_000,
      connectTimeoutMs: deps.upstreamConnectTimeoutMs ?? 3_000,
    };
  }

  /**
   * POST /api/upstreams — register a new dynamic upstream. Admin-only.
   * Body: { name, url, enabled?, credential? } where credential is
   * { mode: "bearer"|"header", value, header? }. 201 on success. The URL is
   * validated (C4 SSRF allow-list + TLS policy) before it is stored.
   */
  router.post("/upstreams", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }
    const repo = requireDynamicRepo(res);
    if (repo === null) {
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,47}$/.test(name)) {
      res.status(400).json({ error: "name must be 3-48 chars (letters, digits, space, dot, underscore, dash)" });
      return;
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (url.length === 0 || url.length > 2048) {
      res.status(400).json({ error: "url is required and must be at most 2048 characters" });
      return;
    }
    const urlCheck = validateUpstreamUrlValue(url, urlPolicy());
    if (!urlCheck.ok) {
      res.status(400).json({ error: urlCheck.issues.join("; ") });
      return;
    }
    const enabled = body.enabled === undefined ? true : body.enabled === true;
    const credential = parseCredentialInput(body.credential);
    if (!credential.ok) {
      res.status(400).json({ error: credential.error });
      return;
    }
    let vault: CredentialVault | null = null;
    if (credential.credential !== null) {
      vault = requireVault(res);
      if (vault === null) {
        return;
      }
    }

    const startedAt = now();
    const base = dynamicUpstreamIdFromName(name);
    const id = await uniqueDynamicId(repo, base);
    const columns = encryptCredentialColumns(vault, id, credential.credential);

    let row: DynamicUpstreamRecord;
    try {
      row = await repo.create(
        id,
        {
          name,
          url: urlCheck.normalized,
          enabled,
          credentialMode: columns.credentialMode,
          credentialHeaderName: columns.credentialHeaderName,
          credentialCipher: columns.credentialCipher,
        },
        principal.userId,
      );
    } catch (error) {
      if (error instanceof DuplicateUpstreamUrlError) {
        res.status(409).json({ error: "an upstream with this URL already exists" });
        return;
      }
      deps.logger.error("dynamic_upstream_create_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
      return;
    }

    // Wire the credential into the live registry so /mcp can call it now.
    try {
      await deps.registry.addOrUpdateServer(registryConfigFor(row), credential.credential);
    } catch (error) {
      deps.logger.error("dynamic_upstream_register_failed", { upstream_id: row.id, error: String(error) });
    }

    await deps.audit.record({
      action: "upstream_created",
      keyId: principal.keyId,
      userId: principal.userId,
      role: principal.role,
      upstreamId: id,
      toolName: null,
      qualifiedName: null,
      outcome: "success",
      durationMs: now() - startedAt,
      errorCode: null,
    });

    res.status(201).json(dynamicRowToResponse(row));
  });

  /**
   * PUT /api/upstreams/:id — update a dynamic upstream. Admin-only.
   * Fixed ids → 409. Unknown id → 404. Body uses three-state credential
   * semantics: omitted = unchanged, null = clear, object = replace. The
   * registry is re-wired after a successful persist.
   */
  router.put("/upstreams/:id", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }
    const repo = requireDynamicRepo(res);
    if (repo === null) {
      return;
    }

    const id = req.params.id ?? "";
    if ((UPSTREAM_IDS as readonly string[]).includes(id)) {
      res.status(409).json({ error: "fixed_upstreams_are_configured_via_environment" });
      return;
    }
    const existing = await repo.findById(id).catch(() => null);
    if (existing === null) {
      res.status(404).json({ error: "unknown_upstream" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : existing.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,47}$/.test(name)) {
      res.status(400).json({ error: "name must be 3-48 chars (letters, digits, space, dot, underscore, dash)" });
      return;
    }
    let url = existing.url;
    if (body.url !== undefined) {
      const raw = typeof body.url === "string" ? body.url.trim() : "";
      if (raw.length === 0 || raw.length > 2048) {
        res.status(400).json({ error: "url must be at most 2048 characters" });
        return;
      }
      const urlCheck = validateUpstreamUrlValue(raw, urlPolicy());
      if (!urlCheck.ok) {
        res.status(400).json({ error: urlCheck.issues.join("; ") });
        return;
      }
      url = urlCheck.normalized;
    }
    const enabled = body.enabled === undefined ? existing.enabled : body.enabled === true;

    const credentialPatch = parseCredentialPatch(body.credential);
    if (!credentialPatch.ok) {
      res.status(400).json({ error: credentialPatch.error });
      return;
    }
    let vault: CredentialVault | null = null;
    let credential: UpstreamCredential | null = null;
    if (credentialPatch.patch.kind === "set") {
      vault = requireVault(res);
      if (vault === null) {
        return;
      }
      credential = credentialPatch.patch.credential;
    } else if (credentialPatch.patch.kind === "unchanged" && existing.credentialCipher !== null) {
      // Re-wire the existing credential (decrypted in memory only, never
      // logged or returned). "unchanged" with no stored credential stays null.
      vault = deps.credentialVault ?? null;
      if (vault === null) {
        res.status(503).json({ error: "credential_vault_unavailable" });
        return;
      }
      credential = {
        mode: existing.credentialMode ?? "bearer",
        value: vault.decrypt(existing.credentialCipher, id),
        headerName: existing.credentialHeaderName,
      };
    }

    const startedAt = now();
    const columns =
      credentialPatch.patch.kind === "unchanged"
        ? {
            credentialCipher: existing.credentialCipher,
            credentialMode: existing.credentialMode,
            credentialHeaderName: existing.credentialHeaderName,
          }
        : encryptCredentialColumns(vault, id, credential);

    let row: DynamicUpstreamRecord | null;
    try {
      row = await repo.update(
        id,
        {
          name,
          url,
          enabled,
          credentialMode: columns.credentialMode,
          credentialHeaderName: columns.credentialHeaderName,
          credentialCipher: columns.credentialCipher,
        },
        principal.userId,
      );
    } catch (error) {
      if (error instanceof DuplicateUpstreamUrlError) {
        res.status(409).json({ error: "an upstream with this URL already exists" });
        return;
      }
      deps.logger.error("dynamic_upstream_update_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: "unknown_upstream" });
      return;
    }

    // Re-wire the live registry: the decrypted credential (or null after a
    // clear) replaces whatever the id held, and connectivity is refreshed.
    try {
      await deps.registry.addOrUpdateServer(registryConfigFor(row), credential);
    } catch (error) {
      deps.logger.error("dynamic_upstream_register_failed", { upstream_id: row.id, error: String(error) });
    }

    await deps.audit.record({
      action: "upstream_updated",
      keyId: principal.keyId,
      userId: principal.userId,
      role: principal.role,
      upstreamId: id,
      toolName: null,
      qualifiedName: null,
      outcome: "success",
      durationMs: now() - startedAt,
      errorCode: null,
    });

    res.json(dynamicRowToResponse(row));
  });

  /**
   * DELETE /api/upstreams/:id — remove a dynamic upstream. Admin-only.
   * Fixed ids → 409 (they are not rows). The row is deleted first, then the
   * live registry entry is dropped so its tools disappear from /mcp. The
   * optional `?credential=null` never appears here: DELETE always drops the
   * stored credential with the row.
   */
  router.delete("/upstreams/:id", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }
    const repo = requireDynamicRepo(res);
    if (repo === null) {
      return;
    }

    const id = req.params.id ?? "";
    if ((UPSTREAM_IDS as readonly string[]).includes(id)) {
      res.status(409).json({ error: "fixed_upstreams_are_configured_via_environment" });
      return;
    }
    const existing = await repo.findById(id).catch(() => null);
    if (existing === null) {
      res.status(404).json({ error: "unknown_upstream" });
      return;
    }

    const startedAt = now();
    let deleted: boolean;
    try {
      deleted = await repo.delete(id);
    } catch (error) {
      deps.logger.error("dynamic_upstream_delete_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
      return;
    }
    if (!deleted) {
      res.status(404).json({ error: "unknown_upstream" });
      return;
    }

    // removeServer drops the id's config AND its in-memory credential.
    try {
      await deps.registry.removeServer(id);
    } catch (error) {
      deps.logger.error("dynamic_upstream_unregister_failed", { upstream_id: id, error: String(error) });
    }

    await deps.audit.record({
      action: "upstream_deleted",
      keyId: principal.keyId,
      userId: principal.userId,
      role: principal.role,
      upstreamId: id,
      toolName: null,
      qualifiedName: null,
      outcome: "success",
      durationMs: now() - startedAt,
      errorCode: null,
    });

    res.json({ id, deleted: true });
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

  /**
   * Member administration (dashboard "Team" area): admin-only listing of
   * users with grant and key-count metadata. Never exposes key hashes or any
   * credential — only display names, roles, grants and counts.
   */
  router.get("/users", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }
    res.json({ users: await deps.authRepo.listUsers() });
  });

  /**
   * Create a member. Admin-only; validation is server-side (a forged body
   * cannot escalate: the role and grants are whatever this endpoint writes,
   * and the caller's own principal comes from their credential, not the
   * body). The new user starts with no API keys — a key is issued
   * separately through POST /api/keys.
   */
  router.post("/users", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }

    const parsed = parseUserBody(req.body, true, unionUpstreamIds(deps.registry.upstreamIds()));
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    const startedAt = now();
    try {
      const created = await deps.authRepo.createUser({
        displayName: parsed.fields.displayName as string,
        role: parsed.fields.role as "admin" | "reader",
        allowedUpstreams: parsed.fields.allowedUpstreams ?? [],
        allowedTools: parsed.fields.allowedTools ?? [],
      });
      await deps.audit.record({
        action: "user_created",
        keyId: principal.keyId,
        userId: principal.userId,
        role: principal.role,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "success",
        durationMs: now() - startedAt,
        errorCode: null,
      });
      res.status(201).json(created);
    } catch (error) {
      if (error instanceof UserConflictError) {
        res.status(409).json({ error: "display_name_in_use" });
        return;
      }
      deps.logger.error("user_create_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
    }
  });

  /** Partial member update: display name, role and/or grants. Admin-only. */
  router.patch("/users/:id", async (req, res) => {
    const principal = principalOf(req);
    if (principal === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireAdmin(req, res, deps.audit, principal))) {
      return;
    }

    const userId = req.params.id ?? "";
    if (!UUID_PATTERN.test(userId)) {
      res.status(400).json({ error: "invalid user id" });
      return;
    }
    const parsed = parseUserBody(req.body, false, unionUpstreamIds(deps.registry.upstreamIds()));
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    const startedAt = now();
    try {
      const updated = await deps.authRepo.updateUser(userId, parsed.fields);
      if (updated === null) {
        res.status(404).json({ error: "unknown_user" });
        return;
      }
      await deps.audit.record({
        action: "user_updated",
        keyId: principal.keyId,
        userId: principal.userId,
        role: principal.role,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "success",
        durationMs: now() - startedAt,
        errorCode: null,
      });
      res.json(updated);
    } catch (error) {
      if (error instanceof UserConflictError) {
        res.status(409).json({ error: "display_name_in_use" });
        return;
      }
      deps.logger.error("user_update_failed", { error: String(error) });
      res.status(500).json({ error: "internal_error" });
    }
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
    const parsed = parseAuditFilters(req.query, unionUpstreamIds(deps.registry.upstreamIds()));
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const entries = await deps.auditRepo.recent(limit, rawBefore as string | undefined, parsed.filters);
    res.json({ entries });
  });

  return router;
}

export { API_PREFIX };
