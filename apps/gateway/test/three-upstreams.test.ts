import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PERMISSION_DENIED } from "../src/mcp-server.ts";
import {
  INVENTORY_TOOLS_SPEC,
  WOOCOMMERCE_TOOLS_SPEC,
  startGatewayHarness,
  type FakeUpstreamSpec,
} from "./helpers/gateway-harness.ts";
import type { FakeToolSpec } from "./helpers/fake-upstream.ts";

/**
 * Registration and routing for all three upstreams (Milestone 5): the
 * Inventory and Support servers are ordinary config-driven upstreams — no
 * gateway core changes. Fakes stand in at the upstream edges so this suite
 * stays fast and offline; the same paths are proven against the real server
 * processes in test/real-upstreams.test.ts.
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

interface ServedByPayload {
  served_by: string;
  tool: string;
  arguments: Record<string, unknown>;
}

const SUPPORT_TOOLS_SPEC: FakeToolSpec[] = [
  { name: "list_tickets", inputSchema: { type: "object", properties: { status: { type: "string" } } } },
  {
    name: "create_ticket",
    inputSchema: {
      type: "object",
      properties: { customer: { type: "string" }, subject: { type: "string" } },
      required: ["customer", "subject"],
    },
  },
];

function threeSpecs(): FakeUpstreamSpec[] {
  return [
    { id: "woocommerce", name: "woocommerce-fake", tools: WOOCOMMERCE_TOOLS_SPEC },
    { id: "inventory", name: "inventory-fake", tools: INVENTORY_TOOLS_SPEC },
    { id: "support", name: "support-fake", tools: SUPPORT_TOOLS_SPEC },
  ];
}

const EXPECTED_QUALIFIED_NAMES = [
  "inventory_adjust_stock",
  "inventory_list_products",
  "support_create_ticket",
  "support_list_tickets",
  "woocommerce_create_product",
  "woocommerce_get_order",
  "woocommerce_list_orders",
  "woocommerce_list_products",
  "woocommerce_update_order_status",
].sort();

async function connectReader(origin: string, readerKey: string): Promise<Client> {
  const client = new Client({ name: "reader-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${readerKey}` } },
  });
  await client.connect(transport);
  return client;
}

describe("all three upstreams through the gateway", () => {
  test("tools/list aggregates every upstream with unique qualified names", async () => {
    const harness = await startGatewayHarness({ upstreams: threeSpecs() });
    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name);
      assert.deepEqual([...names].sort(), EXPECTED_QUALIFIED_NAMES);
      assert.equal(new Set(names).size, names.length, "no duplicate qualified names");
    } finally {
      await harness.close();
    }
  });

  test("identical local names route to different upstreams", async () => {
    const harness = await startGatewayHarness({ upstreams: threeSpecs() });
    try {
      const woo = parsedContent(
        await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} }),
      ) as ServedByPayload;
      assert.equal(woo.served_by, "woocommerce-fake");
      assert.equal(woo.tool, "list_products");

      const inventory = parsedContent(
        await harness.client.callTool({ name: "inventory_list_products", arguments: {} }),
      ) as ServedByPayload;
      assert.equal(inventory.served_by, "inventory-fake");
      assert.equal(inventory.tool, "list_products");

      // Same local name, same arguments, two different servers.
      assert.notEqual(woo.served_by, inventory.served_by);
    } finally {
      await harness.close();
    }
  });

  test("every tool reaches its own server with the right provenance", async () => {
    const harness = await startGatewayHarness({ upstreams: threeSpecs() });
    try {
      const cases = [
        { qualified: "woocommerce_get_order", arguments: { order_id: 512 } },
        { qualified: "inventory_adjust_stock", arguments: { sku: "TEE-BLK-M", delta: -1 } },
        { qualified: "support_list_tickets", arguments: { status: "open" } },
        { qualified: "support_create_ticket", arguments: { customer: "a", subject: "b" } },
      ] as const;
      for (const call of cases) {
        const payload = parsedContent(
          await harness.client.callTool({ name: call.qualified, arguments: call.arguments }),
        ) as ServedByPayload;
        const upstreamId = call.qualified.slice(0, call.qualified.indexOf("_"));
        assert.equal(payload.served_by, `${upstreamId}-fake`, call.qualified);
        assert.equal(payload.tool, call.qualified.slice(call.qualified.indexOf("_") + 1));
      }
    } finally {
      await harness.close();
    }
  });

  test("exactly one audit row per call, each attributed to the right upstream", async () => {
    const harness = await startGatewayHarness({ upstreams: threeSpecs() });
    try {
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
    } finally {
      await harness.close();
    }
  });

  test("disabling one upstream isolates it while the others keep serving", async () => {
    const harness = await startGatewayHarness({ upstreams: threeSpecs() });
    try {
      const supportBefore = await harness.client.callTool({
        name: "support_create_ticket",
        arguments: { customer: "a", subject: "before-disable" },
      });
      assert.ok(supportBefore.isError !== true, textContent(supportBefore));

      assert.equal(harness.registry.setEnabled("support", false), true);

      const disabled = await harness.client.callTool({
        name: "support_create_ticket",
        arguments: { customer: "a", subject: "while-disabled" },
      });
      assert.equal(disabled.isError, true, textContent(disabled));
      assert.match(textContent(disabled), /Upstream 'support' is disabled/);

      const woo = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.ok(woo.isError !== true, textContent(woo));
      const inventory = await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
      assert.ok(inventory.isError !== true, textContent(inventory));

      const disabledRows = harness.auditRepo
        .byAction("tool_call")
        .filter((row) => row.qualifiedName === "support_create_ticket" && row.outcome === "error");
      assert.equal(disabledRows.length, 1);
      assert.equal(disabledRows[0]?.errorCode, "upstream_disabled");
    } finally {
      await harness.close();
    }
  });

  test("reader ceiling applies to support tools: reads allowed, writes denied", async () => {
    const harness = await startGatewayHarness({ upstreams: threeSpecs() });
    const reader = await connectReader(harness.origin, harness.readerKey);
    try {
      const read = await reader.callTool({ name: "support_list_tickets", arguments: {} });
      assert.ok(read.isError !== true, textContent(read));
      assert.equal((parsedContent(read) as ServedByPayload).served_by, "support-fake");

      let denied: unknown = null;
      try {
        await reader.callTool({ name: "support_create_ticket", arguments: { customer: "a", subject: "b" } });
      } catch (error) {
        denied = error;
      }
      assert.ok(denied !== null, "expected the support write call to be rejected");
      assert.ok(denied instanceof Error);
      assert.match(denied.message, /role 'reader' may not call write tool/);
      assert.equal((denied as { code?: number }).code, PERMISSION_DENIED);

      const denials = harness.auditRepo.byAction("tool_call").filter((row) => row.outcome === "denied");
      assert.equal(denials.length, 1, "exactly one audit row for the denied call");
      assert.equal(denials[0]?.errorCode, "role_forbidden");
      assert.equal(denials[0]?.qualifiedName, "support_create_ticket");
      assert.equal(denials[0]?.upstreamId, "support");
    } finally {
      await reader.close();
      await harness.close();
    }
  });
});
