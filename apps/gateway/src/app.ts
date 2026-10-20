import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Express, NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import { createGatewayMcpServer } from "./mcp-server.ts";
import type { UpstreamRegistry } from "./upstream-registry.ts";

export const DEFAULT_MAX_SESSIONS = 100;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export interface CreateAppOptions {
  config: AppConfig;
  logger: Logger;
  registry: UpstreamRegistry;
  maxSessions?: number;
  sessionIdleMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export interface McpApp {
  app: Express;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  open: number;
  lastActive: number;
}

function sessionHeader(req: Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp(options: CreateAppOptions): McpApp {
  const { config, logger, registry } = options;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, Math.floor(sessionIdleMs / 3));
  const now = options.now ?? Date.now;

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: undefined,
  });

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
        transport = session.transport;
        session.lastActive = now();
        trackResponse(session, res);
      } else if (sessionId === undefined && isInitializeRequest(req.body)) {
        if (sessions.size >= maxSessions) {
          jsonRpcError(res, 503, -32000, "Too many open sessions");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, open: 0, lastActive: now() });
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
        const server = createGatewayMcpServer({ registry, logger });
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
