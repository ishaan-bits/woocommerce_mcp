import { randomUUID } from "node:crypto";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { API_PREFIX } from "@mcp/shared";
import type { Express, NextFunction, Request, Response } from "express";
import { createChatAgent } from "./agent/agent.ts";
import { OpenAiCompatProvider, type ChatProvider } from "./agent/provider.ts";
import { createApiRouter } from "./api/routes.ts";
import { createAuditWriter } from "./audit.ts";
import { createAuthMiddleware, principalOf } from "./auth/middleware.ts";
import { authorizeToolCall } from "./auth/authorization.ts";
import type { AppConfig } from "./config.ts";
import type { AuditRepository } from "./db/audit-repository.ts";
import type { AuthRepository } from "./db/auth-repository.ts";
import type { SessionRepository } from "./db/session-repository.ts";
import type { UpstreamStateRepository } from "./db/upstream-state-repository.ts";
import { createTokenBucketLimiter, type TokenBucketLimiter } from "./limits.ts";
import type { Logger } from "./logger.ts";
import { createGatewayMcpServer, PERMISSION_DENIED } from "./mcp-server.ts";
import type { UpstreamRegistry } from "./upstream-registry.ts";

export const DEFAULT_MAX_SESSIONS = 100;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export interface CreateAppOptions {
  config: AppConfig;
  logger: Logger;
  registry: UpstreamRegistry;
  authRepo: AuthRepository;
  auditRepo: AuditRepository;
  /** Dashboard sessions (D23) and persisted upstream toggles (D24). */
  sessionRepo: SessionRepository;
  upstreamStateRepo: UpstreamStateRepository;
  maxSessions?: number;
  sessionIdleMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  /**
   * Milestone 9: inject a scripted provider for tests. Production leaves it
   * undefined and the OpenAI-compatible client is built from config.llm.
   */
  provider?: ChatProvider;
}

export interface McpApp {
  app: Express;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  open: number;
  lastActive: number;
  /** Sessions are bound to the principal that created them (see §auth). */
  userId: string;
}

function sessionHeader(req: Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp(options: CreateAppOptions): McpApp {
  const { config, logger, registry, authRepo, auditRepo, sessionRepo, upstreamStateRepo } = options;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, Math.floor(sessionIdleMs / 3));
  const now = options.now ?? Date.now;

  // C7: bound request body size. The SDK app mounts express.json() with its
  // own defaults (100kb) at creation time; we temporarily wrap express.json so
  // that parser is created with our configured limit instead.
  const originalJson = express.json.bind(express);
  express.json = ((opts?: Parameters<typeof originalJson>[0]) =>
    originalJson({ ...opts, limit: config.jsonBodyLimit })) as typeof express.json;
  let app: Express;
  try {
    app = createMcpExpressApp({
      host: config.host,
      allowedHosts: undefined,
    });
  } finally {
    express.json = originalJson;
  }

  // Client IPs for the login throttle: only trust a proxy when configured
  // (the Helm chart sets TRUST_PROXY=1 behind the dashboard's nginx).
  if (config.trustProxy > 0) {
    app.set("trust proxy", config.trustProxy);
  }

  const audit = createAuditWriter(auditRepo, logger);

  // C7: per-key tool-call throttle; null disables (RATE_LIMIT_CALLS_PER_MINUTE=0).
  const toolCallRateLimiter: TokenBucketLimiter | null =
    config.rateLimitPerMinute > 0
      ? createTokenBucketLimiter({
          capacity: config.rateLimitBurst,
          refillPerMinute: config.rateLimitPerMinute,
        })
      : null;

  // C7/B1: failed-logins-per-IP throttle; null disables (LOGIN_MAX_FAILURES_PER_IP=0).
  const loginRateLimiter: TokenBucketLimiter | null =
    config.loginMaxFailuresPerIp > 0
      ? createTokenBucketLimiter({
          capacity: config.loginMaxFailuresPerIp,
          refillPerMinute: (60_000 / config.loginFailureWindowMs) * config.loginMaxFailuresPerIp,
        })
      : null;

  // Boundary B2: every request except the operational probes needs a valid,
  // unrevoked credential — a Bearer key, or (for /api only) the dashboard
  // session cookie (D21/D23). Fail-closed.
  app.use(
    createAuthMiddleware({
      repo: authRepo,
      sessions: sessionRepo,
      pepper: config.apiKeyPepper,
      audit,
      logger,
    }),
  );

  // D6: the REST surface shares the same authentication, authorization and
  // audit writer as /mcp. Tools only ever execute through the shared
  // executeToolCall pipeline — on /mcp and, for the chat agent, via /api/chat.
  //
  // Milestone 9 (D29): the agent exists only when a provider is configured
  // (GROQ_API_KEY or LLM_BASE_URL). Tests inject a scripted provider; the
  // production path builds the OpenAI-compatible client from config. Either
  // way it runs with the *same* rate limiter and audit writer as /mcp.
  const chatAgent =
    config.llm !== null
      ? createChatAgent({
          provider: options.provider ?? new OpenAiCompatProvider(config.llm),
          registry,
          logger,
          audit,
          rateLimiter: toolCallRateLimiter,
        })
      : null;

  app.use(
    API_PREFIX,
    createApiRouter({
      authRepo,
      auditRepo,
      audit,
      sessions: sessionRepo,
      upstreamState: upstreamStateRepo,
      registry,
      logger,
      pepper: config.apiKeyPepper,
      loginLimiter: loginRateLimiter,
      agent: chatAgent,
      woocommerceStoreMode: config.woocommerceStoreMode,
      gatewayPublicUrl: config.gatewayPublicUrl,
      now,
    }),
  );

  const sessions = new Map<string, Session>();
  let draining = false;

  function trackResponse(session: Session, res: Response): void {
    if (!res.socket || res.destroyed) {
      return;
    }
    session.open += 1;
    res.on("close", () => {
      session.open -= 1;
      session.lastActive = now();
    });
  }

  const sweeper = setInterval(() => {
    const cutoff = now() - sessionIdleMs;
    for (const [sid, session] of sessions) {
      if (session.open === 0 && session.lastActive < cutoff) {
        logger.info("session_idle_close", { session_id: sid });
        session.transport.close().catch((error: unknown) => {
          logger.warn("session_close_failed", { session_id: sid, error: String(error) });
        });
      }
    }
  }, sweepIntervalMs);
  sweeper.unref();

  /** Continuation requests must present the same principal the session was created with. */
  function sessionAllowed(session: Session, req: Request, res: Response): boolean {
    const principal = principalOf(req);
    if (principal === null) {
      jsonRpcError(res, 401, -32000, "Unauthorized");
      return false;
    }
    if (session.userId !== principal.userId) {
      void audit.record({
        action: "access_denied",
        keyId: principal.keyId,
        userId: principal.userId,
        role: principal.role,
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "denied",
        durationMs: 0,
        errorCode: "session_principal_mismatch",
      });
      jsonRpcError(res, 403, PERMISSION_DENIED, "Session belongs to another principal");
      return false;
    }
    return true;
  }

  app.post("/mcp", async (req, res) => {
    const sessionId = sessionHeader(req);
    try {
      if (draining) {
        jsonRpcError(res, 503, -32000, "Server is shutting down");
        return;
      }
      const session = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      let transport: StreamableHTTPServerTransport;
      if (session !== undefined) {
        if (!sessionAllowed(session, req, res)) {
          return;
        }
        transport = session.transport;
        session.lastActive = now();
        trackResponse(session, res);
      } else if (sessionId === undefined && isInitializeRequest(req.body)) {
        const principal = principalOf(req);
        if (principal === null) {
          jsonRpcError(res, 401, -32000, "Unauthorized");
          return;
        }
        if (sessions.size >= maxSessions) {
          jsonRpcError(res, 503, -32000, "Too many open sessions");
          return;
        }
        const ownerUserId = principal.userId;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, open: 0, lastActive: now(), userId: ownerUserId });
            logger.info("session_initialized", { session_id: sid });
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid !== undefined && sessions.has(sid)) {
            sessions.delete(sid);
            logger.info("session_closed", { session_id: sid });
          }
        };
        const server = createGatewayMcpServer({
          registry,
          logger,
          audit,
          principal,
          authorize: authorizeToolCall.bind(null, principal),
          rateLimiter: toolCallRateLimiter,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId !== undefined) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      } else {
        jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("mcp_request_failed", { error: String(error) });
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = sessionHeader(req);
    if (sessionId === undefined) {
      res.status(400).send("Missing session ID");
      return;
    }
    const session = sessions.get(sessionId);
    if (session === undefined) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    if (!sessionAllowed(session, req, res)) {
      return;
    }
    session.lastActive = now();
    trackResponse(session, res);
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error("mcp_get_failed", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = sessionHeader(req);
    if (sessionId === undefined) {
      res.status(400).send("Missing session ID");
      return;
    }
    const session = sessions.get(sessionId);
    if (session === undefined) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    if (!sessionAllowed(session, req, res)) {
      return;
    }
    session.lastActive = now();
    trackResponse(session, res);
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error("mcp_delete_failed", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination");
      }
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", (_req, res) => {
    if (draining) {
      res.status(503).json({ status: "draining" });
      return;
    }
    if (sessions.size >= maxSessions) {
      res.status(503).json({ status: "at_session_capacity", sessions: sessions.size, max_sessions: maxSessions });
      return;
    }
    res.json({
      status: "ready",
      sessions: sessions.size,
      max_sessions: maxSessions,
      upstreams: registry.health().map((entry) => ({
        id: entry.id,
        enabled: entry.enabled,
        reachable: entry.reachable,
        last_error: entry.lastErrorMessage,
      })),
    });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const type = (error as { type?: string }).type;
    const status = (error as { status?: number }).status;
    if (type === "entity.parse.failed") {
      jsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON");
      return;
    }
    if (type === "entity.too.large" || status === 413) {
      jsonRpcError(res, 413, -32600, "Request body too large");
      return;
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      jsonRpcError(res, status, -32600, "Invalid Request");
      return;
    }
    logger.error("express_error", { error: String(error) });
    jsonRpcError(res, 500, -32603, "Internal server error");
  });

  async function close(): Promise<void> {
    draining = true;
    clearInterval(sweeper);
    const openSessions = [...sessions.values()];
    await Promise.all(
      openSessions.map(async (session) => {
        try {
          await session.transport.close();
        } catch {
          // Transport may already be closed by the client.
        }
      }),
    );
    sessions.clear();
  }

  return { app, close };
}
