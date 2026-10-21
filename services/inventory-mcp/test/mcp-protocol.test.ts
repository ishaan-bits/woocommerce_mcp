import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SEEDED_ITEM_COUNT } from "../src/inventory-store.ts";
import { parsedContent, startHarness, textContent, type TestHarness } from "./helpers/test-server.ts";

const EXPECTED_TOOLS = ["adjust_stock", "list_products"];

interface ListPayload {
  source: string;
  warehouse: string | null;
  products: Array<{ sku: string; name: string; warehouse: string; quantity: number }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

interface AdjustPayload {
  source: string;
  sku: string;
  previous_quantity: number;
  delta: number;
  quantity: number;
}

describe("mcp protocol over Streamable HTTP", () => {
  let harness: TestHarness;

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("initialize and tools/list expose exactly the two tools with schemas", async () => {
    const { tools } = await harness.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools) {
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object input schema`);
    }
    const adjust = tools.find((tool) => tool.name === "adjust_stock");
    assert.deepEqual([...((adjust?.inputSchema as { required?: string[] }).required ?? [])].sort(), ["delta", "sku"]);
    const list = tools.find((tool) => tool.name === "list_products");
    assert.equal((list?.inputSchema as { required?: string[] }).required, undefined);
  });

  test("descriptions are honest about the seeded demo data", async () => {
    const { tools } = await harness.client.listTools();
    const text = tools.map((tool) => tool.description).join(" ");
    assert.match(text, /seeded demo inventory/);
    const instructions = (await harness.client.getServerVersion())?.name;
    assert.equal(instructions, "inventory-mcp");
  });

  test("list_products returns the full seeded dataset with pagination defaults", async () => {
    const result = await harness.client.callTool({ name: "list_products", arguments: {} });
    assert.ok(result.isError !== true, textContent(result));
    const payload = parsedContent(result) as ListPayload;
    assert.equal(payload.source, "seeded-demo");
    assert.equal(payload.products.length, 10, "default page size stays bounded at 10");
    assert.equal(payload.pagination.total, SEEDED_ITEM_COUNT);
    assert.equal(payload.pagination.page, 1);
    assert.equal(payload.pagination.per_page, 10);
    assert.equal(payload.pagination.total_pages, 2);
    assert.equal(payload.warehouse, null);
  });

  test("list_products filters by warehouse and by page", async () => {
    const north = parsedContent(
      await harness.client.callTool({ name: "list_products", arguments: { warehouse: "north" } }),
    ) as ListPayload;
    assert.equal(north.pagination.total, 6);
    assert.ok(north.products.every((product) => product.warehouse === "north"));

    const page2 = parsedContent(
      await harness.client.callTool({ name: "list_products", arguments: { page: 2, per_page: 10 } }),
    ) as ListPayload;
    assert.equal(page2.products.length, 2);
  });

  test("adjust_stock changes the quantity for later reads", async () => {
    const result = await harness.client.callTool({
      name: "adjust_stock",
      arguments: { sku: "TEE-BLK-M", delta: -3 },
    });
    assert.ok(result.isError !== true, textContent(result));
    const payload = parsedContent(result) as AdjustPayload;
    assert.equal(payload.sku, "TEE-BLK-M");
    assert.equal(payload.previous_quantity, 120);
    assert.equal(payload.quantity, 117);
    assert.equal(payload.delta, -3);

    const listed = parsedContent(
      await harness.client.callTool({ name: "list_products", arguments: { warehouse: "north", per_page: 100 } }),
    ) as ListPayload;
    assert.equal(listed.products.find((product) => product.sku === "TEE-BLK-M")?.quantity, 117);
  });

  test("adjust_stock rejects unknown SKUs with a friendly error", async () => {
    const result = await harness.client.callTool({ name: "adjust_stock", arguments: { sku: "NOPE-9", delta: 1 } });
    assert.equal(result.isError, true);
    assert.match(textContent(result), /Unknown SKU 'NOPE-9'/);
  });

  test("adjust_stock refuses to drop stock below zero", async () => {
    const result = await harness.client.callTool({
      name: "adjust_stock",
      arguments: { sku: "TOTE-NAT-01", delta: -100 },
    });
    assert.equal(result.isError, true);
    assert.match(textContent(result), /drop below zero/);
  });

  test("invalid tool arguments produce a validation error result", async () => {
    const missingSku = await harness.client.callTool({ name: "adjust_stock", arguments: { delta: 1 } });
    assert.equal(missingSku.isError, true);
    assert.match(textContent(missingSku), /Input validation error/);

    const badPage = await harness.client.callTool({ name: "list_products", arguments: { per_page: 5000 } });
    assert.equal(badPage.isError, true);
    assert.match(textContent(badPage), /Input validation error/);
  });

  test("results are bounded by per_page even for huge pages", async () => {
    const result = await harness.client.callTool({ name: "list_products", arguments: { per_page: 100 } });
    const payload = parsedContent(result) as ListPayload;
    assert.ok(payload.products.length <= 100);
    assert.ok(payload.pagination.per_page <= 100);
  });
});
