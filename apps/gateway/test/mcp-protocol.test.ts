import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../src/logger.ts";
import {
  INVENTORY_TOOLS_SPEC,
  WOOCOMMERCE_TOOLS_SPEC,
  startGatewayHarness,
  type GatewayHarness,
} from "./helpers/gateway-harness.ts";

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

async function assertInvalidParams(promise: Promise<unknown>, match?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof McpError, `expected McpError, got ${String(error)}`);
    assert.equal(error.code, -32602);
    if (match !== undefined) {
      assert.match(error.message, match);
    }
    return true;
  });
}

describe("gateway MCP protocol over Streamable HTTP", () => {
  let harness: GatewayHarness;

  before(async () => {
    harness = await startGatewayHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("tools/list aggregates qualified names from both upstreams", async () => {
    const { tools } = await harness.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "inventory_adjust_stock",
        "inventory_list_products",
        "woocommerce_get_order",
        "woocommerce_list_products",
      ],
    );
  });

  test("every published tool carries a description and an object schema", async () => {
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      assert.ok(
        typeof tool.description === "string" && tool.description.length > 0,
        `${tool.name} needs a description`,
      );
      assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object input schema`);
    }
  });

  test("qualified names route calls to the correct upstream despite a local name collision", async () => {
    const woo = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
    assert.ok(woo.isError !== true, textContent(woo));
    const wooPayload = parsedContent(woo) as { served_by: string };
    assert.equal(wooPayload.served_by, "woocommerce-fake");

    const inventory = await harness.client.callTool({
      name: "inventory_list_products",
      arguments: {},
    });
    assert.ok(inventory.isError !== true, textContent(inventory));
    const inventoryPayload = parsedContent(inventory) as { served_by: string };
    assert.equal(inventoryPayload.served_by, "inventory-fake");
  });

  test("routing strips only the upstream prefix and preserves local names", async () => {
    const result = await harness.client.callTool({
      name: "woocommerce_get_order",
      arguments: { order_id: 42 },
    });
    assert.ok(result.isError !== true, textContent(result));
    const payload = parsedContent(result) as { tool: string; arguments: { order_id: number } };
    assert.equal(payload.tool, "get_order");
    assert.equal(payload.arguments.order_id, 42);
  });

  test("validation uses the owning upstream's schema and blocks the forward", async () => {
    const inventory = harness.fakes.get("inventory");
    assert.ok(inventory !== undefined);
    const callsBefore = inventory.calls.length;
    await assertInvalidParams(
      harness.client.callTool({ name: "inventory_adjust_stock", arguments: { order_id: 1 } }),
      /Input validation error/,
    );
    assert.equal(inventory.calls.length, callsBefore, "invalid arguments must not reach the upstream");
  });

  test("missing required arguments are rejected with -32602 before any upstream call", async () => {
    const woo = harness.fakes.get("woocommerce");
    assert.ok(woo !== undefined);
    const callsBefore = woo.calls.length;
    await assertInvalidParams(
      harness.client.callTool({ name: "woocommerce_get_order", arguments: {} }),
      /Input validation error/,
    );
    assert.equal(woo.calls.length, callsBefore, "invalid arguments must not reach the upstream");
  });

  test("unknown tool names are rejected with -32602", async () => {
    await assertInvalidParams(
      harness.client.callTool({ name: "does_not_exist", arguments: {} }),
      /Unknown tool: does_not_exist/,
    );
  });

  test("unknown upstream prefixes are never forwarded", async () => {
    await assertInvalidParams(
      harness.client.callTool({ name: "mystery_list_products", arguments: {} }),
      /Unknown tool: mystery_list_products/,
    );
  });

  test("healthz and readyz report gateway and upstream health", async () => {
    const health = await fetch(`${harness.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    await harness.client.listTools();

    const ready = await fetch(`${harness.origin}/readyz`);
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as {
      status: string;
      sessions: number;
      upstreams: Array<{ id: string; reachable: boolean }>;
    };
    assert.equal(body.status, "ready");
    assert.ok(body.sessions >= 1);
    assert.equal(body.upstreams.length, 2);
    for (const upstream of body.upstreams) {
      assert.equal(upstream.reachable, true, `${upstream.id} should be reachable`);
    }
  });

  test("a disabled upstream publishes no tools and returns a structured error on call", async () => {
    const harness = await startGatewayHarness({ disableUpstreams: ["woocommerce"] });
    try {
      const { tools } = await harness.client.listTools();
      assert.ok(tools.length > 0);
      assert.ok(tools.every((tool) => tool.name.startsWith("inventory_")));
      const result = await harness.client.callTool({
        name: "woocommerce_list_products",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /disabled/);
    } finally {
      await harness.close();
    }
  });

  test("discovery warns when the woocommerce upstream is missing contract tools", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: { write: (line) => lines.push(line) } });
    const harness = await startGatewayHarness({
      logger,
      upstreams: [
        {
          id: "woocommerce",
          name: "woocommerce-partial",
          tools: WOOCOMMERCE_TOOLS_SPEC.filter((tool) => tool.name === "get_order"),
        },
        { id: "inventory", name: "inventory-fake", tools: INVENTORY_TOOLS_SPEC },
      ],
    });
    try {
      await harness.client.listTools();
      const drift = lines.find((line) => line.includes("woocommerce_tool_contract_drift"));
      assert.ok(drift !== undefined, `expected a contract drift warning, got: ${lines.join(" | ")}`);
      assert.match(drift, /create_product/);
      assert.match(drift, /list_orders/);
      assert.match(drift, /update_order_status/);
    } finally {
      await harness.close();
    }
  });

  test("discovery stays quiet when all five contract tools are present", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: { write: (line) => lines.push(line) } });
    const harness = await startGatewayHarness({
      logger,
      upstreams: [
        { id: "woocommerce", name: "woocommerce-full", tools: WOOCOMMERCE_TOOLS_SPEC },
        { id: "inventory", name: "inventory-fake", tools: INVENTORY_TOOLS_SPEC },
      ],
    });
    try {
      const { tools } = await harness.client.listTools();
      assert.equal(tools.filter((tool) => tool.name.startsWith("woocommerce_")).length, 5);
      assert.ok(!lines.some((line) => line.includes("woocommerce_tool_contract_drift")));
    } finally {
      await harness.close();
    }
  });
});
