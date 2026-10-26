import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { startGatewayHarness, type GatewayHarness } from "./helpers/gateway-harness.ts";

/**
 * Process-to-process verification for Milestone 5 (M5): the gateway routes
 * to the REAL Inventory, Support and WooCommerce MCP servers as three
 * independent child processes over Streamable HTTP — no fakes anywhere in
 * the path. A small in-process mock WooCommerce REST store stands in for the
 * paid Woo API (Basic-auth + X-WP-Total headers) so this suite stays offline
 * and free. Failure isolation is proven by SIGKILLing one child server and
 * by disabling one upstream at runtime.
 */

interface TextResultLike {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}

function textContent(result: unknown): string {
  const first = (result as TextResultLike).content?.[0];
  if (first === undefined || typeof first.text !== "string") {
    throw new Error("Expected a text content block in the tool result");
  }
  return first.text;
}

function parsedContent(result: unknown): unknown {
  return JSON.parse(textContent(result));
}

const CONSUMER_KEY = "ck_test_not_a_real_key";
const CONSUMER_SECRET = "cs_test_not_a_real_secret";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`, "utf8").toString("base64")}`;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface RunningServer {
  origin: string;
  port: number;
  close(): Promise<void>;
}

interface ServiceHandle {
  name: string;
  child: ChildProcess;
  origin: string;
  port: number;
  logs(): string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Minimal WooCommerce REST stand-in: auth-gated products + one order. */
async function startMockWooStore(): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== EXPECTED_AUTH) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "woocommerce_rest_invalid_consumer_key", message: "Invalid consumer key provided." }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/wp-json/wc/v3/products") {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-wp-total": "2",
        "x-wp-totalpages": "1",
      });
      res.end(JSON.stringify([{ id: 1, name: "Canvas Tote" }, { id: 2, name: "Stoneware Mug" }]));
      return;
    }
    const order = url.pathname.match(/^\/wp-json\/wc\/v3\/orders\/(\d+)$/);
    if (req.method === "GET" && order !== null && Number(order[1]) === 512) {
      res.writeHead(200, { "content-type": "application/json", "x-wp-total": "1", "x-wp-totalpages": "1" });
      res.end(JSON.stringify({ id: 512, status: "processing" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid order ID." }));
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function startService(name: string, extraEnv: Record<string, string>): Promise<ServiceHandle> {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: `${REPO_ROOT}services/${name}-mcp/`,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "error", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };
  const chunks: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const origin = `http://127.0.0.1:${port}`;
  const logs = (): string => chunks.join("").slice(-4000);

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with code ${child.exitCode} during startup:\n${logs()}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) {
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`${name} never became healthy at ${origin}:\n${logs()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { name, child, origin, port, logs };
}

async function stopService(service: ServiceHandle): Promise<void> {
  if (service.child.exitCode !== null || service.child.signalCode !== null) {
    return;
  }
  const exited = waitExit(service.child);
  service.child.kill("SIGTERM");
  const force = setTimeout(() => service.child.kill("SIGKILL"), 3_000);
  await exited;
  clearTimeout(force);
}

describe("gateway to real Inventory, Support and WooCommerce servers", () => {
  let mockStore: RunningServer;
  let woo: ServiceHandle;
  let inventory: ServiceHandle;
  let support: ServiceHandle;
  let harness: GatewayHarness;

  before(async () => {
    mockStore = await startMockWooStore();
    [woo, inventory, support] = await Promise.all([
      startService("woocommerce", {
        WOOCOMMERCE_STORE_URL: mockStore.origin,
        WOOCOMMERCE_CONSUMER_KEY: CONSUMER_KEY,
        WOOCOMMERCE_CONSUMER_SECRET: CONSUMER_SECRET,
      }),
      startService("inventory", {}),
      startService("support", {}),
    ]);
    harness = await startGatewayHarness({
      upstreams: [],
      config: {
        upstreams: [
          { id: "woocommerce", baseUrl: `${woo.origin}/mcp`, enabled: true, timeoutMs: 5_000, connectTimeoutMs: 3_000 },
          { id: "inventory", baseUrl: `${inventory.origin}/mcp`, enabled: true, timeoutMs: 5_000, connectTimeoutMs: 3_000 },
          { id: "support", baseUrl: `${support.origin}/mcp`, enabled: true, timeoutMs: 5_000, connectTimeoutMs: 3_000 },
        ],
      },
    });
  });

  after(async () => {
    await harness?.close();
    await Promise.all([woo, inventory, support].map((service) => (service ? stopService(service) : Promise.resolve())));
    await mockStore?.close();
  });

  test("tools/list aggregates all nine tools from three real servers", async () => {
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(
      [...names].sort(),
      [
        "inventory_adjust_stock",
        "inventory_list_products",
        "support_create_ticket",
        "support_list_tickets",
        "woocommerce_create_product",
        "woocommerce_get_order",
        "woocommerce_list_orders",
        "woocommerce_list_products",
        "woocommerce_update_order_status",
      ].sort(),
    );
    assert.equal(new Set(names).size, names.length, "no duplicate qualified names");
    for (const tool of tools) {
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object input schema`);
    }
  });

  test("each tool is served by its own server process", async () => {
    // WooCommerce: real server backed by the mock REST store (process-to-process).
    const wooPayload = parsedContent(
      await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} }),
    ) as { products?: Array<{ name: string }>; source?: string; pagination?: { total_products: number | null; has_more: boolean | null } };
    assert.equal(wooPayload.products?.[0]?.name, "Canvas Tote", "data came through the real WooCommerce server");
    assert.equal(wooPayload.source, undefined, "the seeded-demo source marker belongs to the new servers only");
    assert.equal(wooPayload.pagination?.total_products, 2, "real metadata from X-WP-Total");
    assert.equal(wooPayload.pagination?.has_more, false);

    // Inventory: its own seeded store, tagged with its own source marker.
    const inventoryPayload = parsedContent(
      await harness.client.callTool({ name: "inventory_list_products", arguments: { per_page: 100 } }),
    ) as { source: string; warehouse: string | null; products: Array<{ sku: string }> };
    assert.equal(inventoryPayload.source, "seeded-demo");
    assert.equal(inventoryPayload.warehouse, null);
    assert.ok(inventoryPayload.products.some((product) => product.sku === "TEE-BLK-M"));

    // Support: its own ticket store, also tagged as seeded demo data.
    const supportPayload = parsedContent(
      await harness.client.callTool({
        name: "support_create_ticket",
        arguments: { customer: "northwind-traders", subject: "Process-to-process check", priority: "high" },
      }),
    ) as { source: string; ticket: { id: number; status: string; priority: string; subject: string } };
    assert.equal(supportPayload.source, "seeded-demo");
    assert.equal(supportPayload.ticket.status, "open");
    assert.equal(supportPayload.ticket.priority, "high");
    assert.equal(supportPayload.ticket.subject, "Process-to-process check");
    assert.ok(supportPayload.ticket.id >= 1009, "ticket ids continue after the seed");
  });

  test("every real call writes exactly one audit row for the right upstream", async () => {
    const before = harness.auditRepo.byAction("tool_call").length;
    await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
    await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
    await harness.client.callTool({ name: "support_create_ticket", arguments: { customer: "a", subject: "b" } });

    const rows = harness.auditRepo.byAction("tool_call").slice(before);
    assert.equal(rows.length, 3, "one row per tools/call");
    assert.deepEqual(
      rows.map((row) => [row.upstreamId, row.qualifiedName, row.outcome]),
      [
        ["woocommerce", "woocommerce_list_products", "success"],
        ["inventory", "inventory_list_products", "success"],
        ["support", "support_create_ticket", "success"],
      ],
    );
  });

  test("disabling one live upstream fails only its tools until re-enabled", async () => {
    assert.equal(harness.registry.setEnabled("support", false), true);

    const disabled = await harness.client.callTool({
      name: "support_create_ticket",
      arguments: { customer: "a", subject: "while-disabled" },
    });
    assert.equal(disabled.isError, true, textContent(disabled));
    assert.match(textContent(disabled), /Upstream 'support' is disabled/);

    const wooOk = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
    assert.ok(wooOk.isError !== true, textContent(wooOk));
    const inventoryOk = await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
    assert.ok(inventoryOk.isError !== true, textContent(inventoryOk));

    assert.equal(harness.registry.setEnabled("support", true), true);
    const reEnabled = await harness.client.callTool({
      name: "support_create_ticket",
      arguments: { customer: "a", subject: "after-reenable" },
    });
    assert.ok(reEnabled.isError !== true, textContent(reEnabled));
  });

  test("SIGKILLing one server fails only its own tools, leaking no internals", async () => {
    const before = harness.auditRepo.byAction("tool_call").length;

    inventory.child.kill("SIGKILL");
    await waitExit(inventory.child);
    assert.ok(inventory.child.signalCode === "SIGKILL" || inventory.child.exitCode !== null);

    const dead = await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
    assert.equal(dead.isError, true, textContent(dead));
    const message = textContent(dead);
    assert.match(message, /unreachable/);
    assert.ok(!message.includes("127.0.0.1"), `no host leak: ${message}`);
    assert.ok(!message.includes(String(inventory.port)), `no port leak: ${message}`);
    assert.ok(!message.includes("http://") && !message.includes("https://"), `no URL leak: ${message}`);

    // The other two servers keep serving.
    const wooOk = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
    assert.ok(wooOk.isError !== true, textContent(wooOk));
    const supportOk = await harness.client.callTool({
      name: "support_create_ticket",
      arguments: { customer: "a", subject: "survivor" },
    });
    assert.ok(supportOk.isError !== true, textContent(supportOk));

    // Exactly one new audit row per attempted call: two successes + one error.
    const rows = harness.auditRepo.byAction("tool_call").slice(before);
    assert.equal(rows.length, 3);
    const failure = rows.find((row) => row.qualifiedName === "inventory_list_products");
    assert.ok(failure, "the failed call must be audited too");
    assert.equal(failure.outcome, "error");
    assert.ok(failure.errorCode !== null, "the failure carries a structural error code");
    assert.equal(rows.filter((row) => row.outcome === "success").length, 2);
  });
});
