import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INVENTORY_TOOLS_SPEC,
  startGatewayHarness,
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

const INVENTORY_SPEC = [{ id: "inventory", name: "inventory-fake", tools: INVENTORY_TOOLS_SPEC }] as const;

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-test-client", version: "0.0.0" },
  },
};

describe("upstream failures are isolated and structural", () => {
  test("a slow upstream times out with a structured error while other upstreams keep working", async () => {
    const harness = await startGatewayHarness({
      timeoutMs: 250,
      upstreams: [
        {
          id: "woocommerce",
          name: "woocommerce-slow",
          tools: [{ name: "list_products", delayMs: 1500 }],
        },
        { id: "inventory", name: "inventory-fake", tools: INVENTORY_TOOLS_SPEC },
      ],
    });
    try {
      const slow = await harness.client.callTool({
        name: "woocommerce_list_products",
        arguments: {},
      });
      assert.equal(slow.isError, true, textContent(slow));
      assert.match(textContent(slow), /did not respond within 250 ms/);

      const healthy = await harness.client.callTool({
        name: "inventory_list_products",
        arguments: {},
      });
      assert.ok(healthy.isError !== true, textContent(healthy));
      assert.match(textContent(healthy), /inventory-fake/);
    } finally {
      await harness.close();
    }
  });

  test("an upstream that stops after discovery keeps its tools listed and fails calls structurally", async () => {
    const harness = await startGatewayHarness();
    try {
      const before = await harness.client.listTools();
      assert.ok(before.tools.some((tool) => tool.name === "woocommerce_list_products"));

      await harness.stopFake("woocommerce");

      const after = await harness.client.listTools();
      assert.ok(
        after.tools.some((tool) => tool.name === "woocommerce_list_products"),
        "cached tools stay listed while an upstream is temporarily down",
      );

      const wooResult = await harness.client.callTool({
        name: "woocommerce_list_products",
        arguments: {},
      });
      assert.equal(wooResult.isError, true, textContent(wooResult));
      assert.match(textContent(wooResult), /unreachable/);

      const inventoryResult = await harness.client.callTool({
        name: "inventory_list_products",
        arguments: {},
      });
      assert.ok(inventoryResult.isError !== true, textContent(inventoryResult));
    } finally {
      await harness.close();
    }
  });

  test("an upstream that was never reachable is omitted from tools/list but fails structurally on call", async () => {
    const harness = await startGatewayHarness({
      upstreams: [...INVENTORY_SPEC],
      deadUpstreams: ["woocommerce"],
    });
    try {
      const { tools } = await harness.client.listTools();
      assert.ok(tools.length > 0);
      assert.ok(!tools.some((tool) => tool.name.startsWith("woocommerce_")));
      assert.ok(tools.every((tool) => tool.name.startsWith("inventory_")));

      const result = await harness.client.callTool({
        name: "woocommerce_list_products",
        arguments: {},
      });
      assert.equal(result.isError, true, textContent(result));
      assert.match(textContent(result), /unreachable/);

      const healthy = await harness.client.callTool({
        name: "inventory_list_products",
        arguments: {},
      });
      assert.ok(healthy.isError !== true, textContent(healthy));
    } finally {
      await harness.close();
    }
  });

  test("a TCP-accepting but silent upstream hits the connect timeout", async () => {
    const harness = await startGatewayHarness({
      upstreams: [...INVENTORY_SPEC],
      hangingUpstreams: ["woocommerce"],
      connectTimeoutMs: 200,
    });
    try {
      const result = await harness.client.callTool({
        name: "woocommerce_list_products",
        arguments: {},
      });
      assert.equal(result.isError, true, textContent(result));
      assert.match(textContent(result), /did not connect within 200 ms/);
    } finally {
      await harness.close();
    }
  });

  test("upstream tool errors pass through as isError results", async () => {
    const harness = await startGatewayHarness({
      upstreams: [
        {
          id: "woocommerce",
          name: "woocommerce-erroring",
          tools: [
            {
              name: "get_order",
              inputSchema: {
                type: "object",
                properties: { order_id: { type: "integer" } },
                required: ["order_id"],
              },
              handler: () => ({
                content: [{ type: "text", text: "Quota exceeded" }],
                isError: true,
              }),
            },
          ],
        },
      ],
    });
    try {
      const result = await harness.client.callTool({
        name: "woocommerce_get_order",
        arguments: { order_id: 7 },
      });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /Quota exceeded/);
    } finally {
      await harness.close();
    }
  });

  test("POST without a session and not an initialize request returns 400", async () => {
    const harness = await startGatewayHarness();
    try {
      const response = await fetch(`${harness.origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", ...harness.authHeaders() },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: { code?: number } };
      assert.equal(body.error?.code, -32000);
    } finally {
      await harness.close();
    }
  });

  test("after close, readyz reports draining and new sessions are rejected", async () => {
    const harness = await startGatewayHarness();
    await harness.mcpApp.close();

    const ready = await fetch(`${harness.origin}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: "draining" });

    const initialize = await fetch(`${harness.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...harness.authHeaders() },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    assert.equal(initialize.status, 503);
    const body = (await initialize.json()) as { error?: { code?: number; message?: string } };
    assert.equal(body.error?.code, -32000);
    assert.equal(body.error?.message, "Server is shutting down");

    await harness.close();
  });
});
