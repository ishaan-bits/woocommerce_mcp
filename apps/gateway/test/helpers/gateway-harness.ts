import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import type { UpstreamId } from "@mcp/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type McpApp } from "../../src/app.ts";
import type { AppConfig } from "../../src/config.ts";
import { createLogger, type Logger } from "../../src/logger.ts";
import type { UpstreamRegistry } from "../../src/upstream-registry.ts";
import { createUpstreamRegistry } from "../../src/upstream-registry.ts";
import { startFakeUpstream, type FakeToolSpec, type FakeUpstream } from "./fake-upstream.ts";
import { makeConfig } from "./config.ts";

export interface FakeUpstreamSpec {
  id: UpstreamId;
  name?: string;
  tools: FakeToolSpec[];
}

export interface StartGatewayOptions {
  upstreams?: FakeUpstreamSpec[];
  deadUpstreams?: UpstreamId[];
  hangingUpstreams?: UpstreamId[];
  disableUpstreams?: UpstreamId[];
  timeoutMs?: number;
  connectTimeoutMs?: number;
  toolCacheTtlMs?: number;
  now?: () => number;
  logger?: Logger;
  config?: Partial<AppConfig>;
}

export interface GatewayHarness {
  origin: string;
  client: Client;
  registry: UpstreamRegistry;
  mcpApp: McpApp;
  fakes: Map<UpstreamId, FakeUpstream>;
  stopFake(id: UpstreamId): Promise<void>;
  close(): Promise<void>;
}

export const WOOCOMMERCE_TOOLS_SPEC: FakeToolSpec[] = [
  {
    name: "list_products",
    inputSchema: {
      type: "object",
      properties: { page: { type: "integer" }, search: { type: "string" } },
    },
  },
  {
    name: "create_product",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, regular_price: { type: "string" } },
      required: ["name", "regular_price"],
    },
  },
  {
    name: "list_orders",
    inputSchema: { type: "object", properties: { status: { type: "string" } } },
  },
  {
    name: "get_order",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "integer" } },
      required: ["order_id"],
    },
  },
  {
    name: "update_order_status",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "integer" }, status: { type: "string" } },
      required: ["order_id", "status"],
    },
  },
];

export const INVENTORY_TOOLS_SPEC: FakeToolSpec[] = [
  { name: "list_products", inputSchema: { type: "object", properties: { warehouse: { type: "string" } } } },
  {
    name: "adjust_stock",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" }, delta: { type: "integer" } },
      required: ["sku", "delta"],
    },
  },
];

function defaultSpecs(): FakeUpstreamSpec[] {
  return [
    {
      id: "woocommerce",
      name: "woocommerce-fake",
      tools: WOOCOMMERCE_TOOLS_SPEC.filter((tool) => tool.name === "list_products" || tool.name === "get_order"),
    },
    { id: "inventory", name: "inventory-fake", tools: INVENTORY_TOOLS_SPEC },
  ];
}

async function startHangServer(): Promise<{ mcpUrl: string; close(): Promise<void> }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startGatewayHarness(options: StartGatewayOptions = {}): Promise<GatewayHarness> {
  const specs = options.upstreams ?? defaultSpecs();
  const deadIds = new Set(options.deadUpstreams ?? []);
  const hangingIds = new Set(options.hangingUpstreams ?? []);
  const disabledIds = new Set(options.disableUpstreams ?? []);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;

  const fakes = new Map<UpstreamId, FakeUpstream>();
  const hangServers: Array<{ mcpUrl: string; close(): Promise<void> }> = [];

  const mcpUrls = new Map<UpstreamId, string>();
  for (const spec of specs) {
    const fake = await startFakeUpstream({ name: spec.name, tools: spec.tools });
    fakes.set(spec.id, fake);
    mcpUrls.set(spec.id, fake.mcpUrl);
  }
  for (const id of deadIds) {
    if (!mcpUrls.has(id)) {
      mcpUrls.set(id, "http://127.0.0.1:1/mcp");
    }
  }
  for (const id of hangingIds) {
    if (!mcpUrls.has(id)) {
      const hang = await startHangServer();
      hangServers.push(hang);
      mcpUrls.set(id, hang.mcpUrl);
    }
  }

  const config = makeConfig({
    upstreams: [...mcpUrls.entries()].map(([id, baseUrl]) => ({
      id,
      baseUrl,
      enabled: !disabledIds.has(id),
      timeoutMs,
      connectTimeoutMs,
    })),
    ...options.config,
  });

  const logger =
    options.logger ?? createLogger({ level: "error", sink: { write: () => undefined } });

  const registry = createUpstreamRegistry({
    configs: config.upstreams,
    toolCacheTtlMs: options.toolCacheTtlMs ?? config.toolCacheTtlMs,
    logger,
    now: options.now,
    clientInfo: { name: "harness-gateway", version: "0.0.0" },
  });

  const mcpApp = createApp({ config, logger, registry });

  const httpServer: HttpServer = mcpApp.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", () => resolve());
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: "harness-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);

  let closed = false;

  return {
    origin,
    client,
    registry,
    mcpApp,
    fakes,
    async stopFake(id: UpstreamId): Promise<void> {
      const fake = fakes.get(id);
      if (fake !== undefined) {
        fakes.delete(id);
        await fake.close();
      }
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await client.close().catch(() => undefined);
      await mcpApp.close();
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
      await registry.close();
      for (const fake of fakes.values()) {
        await fake.close();
      }
      fakes.clear();
      for (const hang of hangServers) {
        await hang.close();
      }
    },
  };
}
