import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { UPSTREAM_IDS, WOOCOMMERCE_TOOLS, type UpstreamId } from "@mcp/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type McpApp } from "../../src/app.ts";
import type { ChatProvider } from "../../src/agent/provider.ts";
import type { AppConfig } from "../../src/config.ts";
import { createLogger, type Logger } from "../../src/logger.ts";
import type { UpstreamRegistry } from "../../src/upstream-registry.ts";
import { createUpstreamRegistry } from "../../src/upstream-registry.ts";
import { startFakeUpstream, type FakeToolSpec, type FakeUpstream } from "./fake-upstream.ts";
import { makeConfig, TEST_PEPPER } from "./config.ts";
import { FakeAuditRepository, FakeAuthRepository, FakeSessionRepository, FakeUpstreamStateRepository } from "./fake-repos.ts";
import { isWriteLocalName } from "../../src/auth/authorization.ts";
import type { StoredUser } from "../../src/db/auth-repository.ts";

export const ADMIN_USER_ID = "11111111-1111-4111-8111-111111111111";
export const READER_USER_ID = "22222222-2222-4222-8222-222222222222";
export { TEST_PEPPER };

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
  /** Milestone 9: scripted chat provider (with config.llm set) for /api/chat tests. */
  provider?: ChatProvider;
  /** Key the harness client authenticates with; defaults to a fresh admin key. */
  clientKey?: string;
  pepper?: string;
  authRepo?: FakeAuthRepository;
  auditRepo?: FakeAuditRepository;
}

export interface GatewayHarness {
  origin: string;
  client: Client;
  registry: UpstreamRegistry;
  mcpApp: McpApp;
  fakes: Map<UpstreamId, FakeUpstream>;
  authRepo: FakeAuthRepository;
  auditRepo: FakeAuditRepository;
  pepper: string;
  adminKey: string;
  readerKey: string;
  /** Auth header object for raw fetches: { authorization: "Bearer ..." }. */
  authHeaders(key?: string): Record<string, string>;
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
    ssrf: { allowedPrivateHosts: ["*"] },
    now: options.now,
    clientInfo: { name: "harness-gateway", version: "0.0.0" },
  });

  const pepper = options.pepper ?? TEST_PEPPER;
  const authRepo = options.authRepo ?? new FakeAuthRepository();
  const auditRepo = options.auditRepo ?? new FakeAuditRepository();

  // Grants are STATIC per-principal configuration (C5 / the migration seed),
  // deliberately independent of which upstreams currently discover tools — a
  // dead upstream must still be *authorized* so its failure surfaces as the
  // structural isolation error, not a permission denial. Spec-derived names
  // are added on top so ad-hoc test tools are callable too.
  const qualifiedNames = new Set<string>([
    ...WOOCOMMERCE_TOOLS.map((name) => `woocommerce_${name}`),
    "inventory_list_products",
    "inventory_adjust_stock",
    "support_create_ticket",
  ]);
  for (const spec of specs) {
    for (const tool of spec.tools) {
      qualifiedNames.add(`${spec.id}_${tool.name}`);
    }
  }
  const grantedUpstreams: UpstreamId[] = ["woocommerce", "inventory", "support"];
  const adminUser: StoredUser = {
    id: ADMIN_USER_ID,
    displayName: "admin-demo",
    role: "admin",
    allowedUpstreams: grantedUpstreams,
    allowedTools: [...qualifiedNames].map((name) => `tools:${name}`),
  };
  const readerUser: StoredUser = {
    id: READER_USER_ID,
    displayName: "reader-demo",
    role: "reader",
    allowedUpstreams: grantedUpstreams,
    allowedTools: [...qualifiedNames]
      .filter((name) => !isWriteLocalName(name.slice(name.indexOf("_") + 1)))
      .map((name) => `tools:${name}`),
  };
  authRepo.seedUser(adminUser);
  authRepo.seedUser(readerUser);
  const adminKey = options.clientKey ?? authRepo.issueKey(ADMIN_USER_ID, pepper).key;
  const readerKey = authRepo.issueKey(READER_USER_ID, pepper).key;

  const mcpApp = createApp({
    config,
    logger,
    registry,
    authRepo,
    auditRepo,
    sessionRepo: new FakeSessionRepository(),
    upstreamStateRepo: new FakeUpstreamStateRepository(),
    provider: options.provider,
  });

  const httpServer: HttpServer = mcpApp.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", () => resolve());
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const connectKey = options.clientKey ?? adminKey;
  const client = new Client({ name: "harness-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${connectKey}` } },
  });
  await client.connect(transport);

  let closed = false;

  return {
    origin,
    client,
    registry,
    mcpApp,
    fakes,
    authRepo,
    auditRepo,
    pepper,
    adminKey,
    readerKey,
    authHeaders(key) {
      return { authorization: `Bearer ${key ?? connectKey}` };
    },
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
