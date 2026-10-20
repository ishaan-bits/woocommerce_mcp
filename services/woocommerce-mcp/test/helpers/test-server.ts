import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type McpApp } from "../../src/app.ts";
import type { AppConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { makeConfig } from "./config.ts";

export interface StartHarnessOptions {
  fetchImpl?: typeof fetch;
  config?: Partial<AppConfig>;
  maxSessions?: number;
  sessionIdleMs?: number;
  sweepIntervalMs?: number;
}

export interface RawTestServer {
  origin: string;
  mcpApp: McpApp;
  close(): Promise<void>;
}

export async function startRawServer(options: StartHarnessOptions = {}): Promise<RawTestServer> {
  const config = makeConfig(options.config);
  const logger = createLogger({ level: "error", sink: { write: () => {} } });
  const mcpApp = createApp({
    config,
    logger,
    fetchImpl: options.fetchImpl,
    maxSessions: options.maxSessions,
    sessionIdleMs: options.sessionIdleMs,
    sweepIntervalMs: options.sweepIntervalMs,
  });

  const server: Server = mcpApp.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    mcpApp,
    async close(): Promise<void> {
      await mcpApp.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

export const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-test-client", version: "0.0.0" },
  },
};

export interface TestHarness {
  origin: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
  mcpApp: McpApp;
  close(): Promise<void>;
}

export async function startHarness(options: StartHarnessOptions = {}): Promise<TestHarness> {
  const config = makeConfig(options.config);
  const logger = createLogger({ level: "error", sink: { write: () => {} } });
  const mcpApp = createApp({
    config,
    logger,
    fetchImpl: options.fetchImpl,
    maxSessions: options.maxSessions,
    sessionIdleMs: options.sessionIdleMs,
    sweepIntervalMs: options.sweepIntervalMs,
  });

  const server: Server = mcpApp.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);

  return {
    origin,
    client,
    transport,
    mcpApp,
    async close(): Promise<void> {
      await client.close();
      await mcpApp.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

interface TextResultLike {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}

export function textContent(result: unknown): string {
  const first = (result as TextResultLike).content?.[0];
  if (first === undefined || typeof first.text !== "string") {
    throw new Error("Expected a text content block in the tool result");
  }
  return first.text;
}

export function parsedContent(result: unknown): unknown {
  return JSON.parse(textContent(result));
}
