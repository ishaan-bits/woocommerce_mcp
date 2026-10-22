import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

export interface FakeToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
  delayMs?: number;
}

export interface FakeUpstream {
  name: string;
  origin: string;
  mcpUrl: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /**
   * Authorization-relevant headers observed on /mcp requests (D34 wire
   * check): the Authorization header plus any x-* custom header, so a test
   * can prove the gateway attached the admin-entered credential.
   */
  seenAuthHeaders: Array<Record<string, string>>;
  close(): Promise<void>;
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

const NOT_ALLOWED = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null };

export async function startFakeUpstream(options: {
  name?: string;
  tools: FakeToolSpec[];
}): Promise<FakeUpstream> {
  const name = options.name ?? "fake-upstream";
  const tools = options.tools;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const seenAuthHeaders: Array<Record<string, string>> = [];
  let closed = false;

  function makeServer(): Server {
    const server = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool): Tool => ({
        name: tool.name,
        description: tool.description ?? `Tool ${tool.name} served by ${name}`,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as Tool["inputSchema"],
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments ?? {};
      calls.push({ name: toolName, args });
      const spec = tools.find((tool) => tool.name === toolName);
      if (spec === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${toolName}`);
      }
      if (spec.delayMs !== undefined && spec.delayMs > 0) {
        await unrefDelay(spec.delayMs);
      }
      if (spec.handler !== undefined) {
        return spec.handler(args);
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ served_by: name, tool: toolName, arguments: args }) },
        ],
      };
    });
    return server;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/mcp", async (req, res) => {
    const observed: Record<string, string> = {};
    if (typeof req.headers.authorization === "string") {
      observed.authorization = req.headers.authorization;
    }
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.startsWith("x-") && typeof value === "string") {
        observed[key] = value;
      }
    }
    seenAuthHeaders.push(observed);
    const server = makeServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json(NOT_ALLOWED);
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json(NOT_ALLOWED);
  });

  const httpServer: HttpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", () => resolve());
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    name,
    origin,
    mcpUrl: `${origin}/mcp`,
    calls,
    seenAuthHeaders,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
    },
  };
}
