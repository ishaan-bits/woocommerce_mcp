import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createMockStore, type MockStore } from "./helpers/mock-store.ts";
import { parsedContent, startHarness, textContent, type TestHarness } from "./helpers/test-server.ts";

const EXPECTED_TOOLS = ["create_product", "get_order", "list_orders", "list_products", "update_order_status"];

describe("mcp protocol over Streamable HTTP", () => {
  let store: MockStore;
  let harness: TestHarness;

  before(async () => {
    store = createMockStore({
      products: [
        { id: 1, name: "Green Tea", regular_price: "12.50", status: "publish" },
        { id: 2, name: "Black Tea", regular_price: "9.00", status: "draft" },
      ],
      orders: [
        { id: 101, status: "completed", date_created: "2024-01-15T10:00:00Z", total: "12.50" },
        { id: 102, status: "processing", date_created: "2024-03-15T10:00:00Z", total: "9.00" },
        { id: 103, status: "completed", date_created: "2024-05-15T10:00:00Z", total: "20.00" },
      ],
    });
    harness = await startHarness({ fetchImpl: store.fetchImpl });
  });

  after(async () => {
    await harness.close();
  });

  test("initialize and tools/list expose the five tools with schemas", async () => {
    const { tools } = await harness.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      EXPECTED_TOOLS,
    );
    for (const tool of tools) {
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object input schema`);
    }
  });

  test("list_products returns store products with real ids and explicit pagination", async () => {
    const result = await harness.client.callTool({ name: "list_products", arguments: {} });
    assert.ok(result.isError !== true, textContent(result));
    const raw = textContent(result);
    // Pagination is serialized FIRST so size-capping can never hide page facts.
    assert.ok(raw.indexOf('"pagination"') < raw.indexOf('"products"'), "pagination must precede products");
    const payload = parsedContent(result) as {
      products: Array<{ id: number; name: string; price?: string; sku?: string; permalink?: string; status?: string }>;
      pagination: {
        page: number;
        per_page: number;
        returned: number;
        total_products: number | null;
        total_pages: number | null;
        has_more: boolean | null;
      };
    };
    assert.equal(payload.products.length, store.products.length);
    assert.equal(payload.pagination.page, 1);
    assert.equal(payload.pagination.per_page, 10);
    assert.equal(payload.pagination.returned, store.products.length);
    assert.equal(payload.pagination.total_products, store.products.length);
    assert.equal(payload.pagination.has_more, false, "a complete single page must not claim more pages");
    // Every product carries its OWN real id — never a range or merged ids.
    const ids = payload.products.map((product) => product.id);
    assert.equal(new Set(ids).size, ids.length, "each product keeps its own distinct id");
    assert.ok(ids.every((id) => Number.isInteger(id) && id > 0));
    assert.ok(payload.products.every((product) => product.name !== ""), "names preserved");
    assert.ok(payload.products.some((product) => product.name === "Green Tea"));
  });

  test("list_products filters by search and status", async () => {
    const result = await harness.client.callTool({
      name: "list_products",
      arguments: { search: "tea", status: "publish" },
    });
    const payload = parsedContent(result) as { products: Array<{ name: string }> };
    assert.deepEqual(
      payload.products.map((product) => product.name),
      ["Green Tea"],
    );
  });

  test("create_product creates a product on the store", async () => {
    const beforeCount = store.products.length;
    const result = await harness.client.callTool({
      name: "create_product",
      arguments: { name: "Yerba Mate", regular_price: 24.5, sku: "MATE-1" },
    });
    assert.ok(result.isError !== true, textContent(result));
    const payload = parsedContent(result) as { product: { id: number; name: string; regular_price: string } };
    assert.equal(payload.product.name, "Yerba Mate");
    assert.equal(payload.product.regular_price, "24.5");
    assert.equal(store.products.length, beforeCount + 1);
    const created = store.products.at(-1);
    assert.equal(created?.sku, "MATE-1");
    const postCall = store.calls.find((call) => call.method === "POST");
    assert.ok(postCall !== undefined);
    assert.equal(postCall.url, "https://store.test/wp-json/wc/v3/products");
  });

  test("list_orders filters by a single status", async () => {
    const result = await harness.client.callTool({
      name: "list_orders",
      arguments: { status: "completed" },
    });
    const payload = parsedContent(result) as { orders: Array<{ id: number }> };
    assert.deepEqual(
      payload.orders.map((order) => order.id),
      [101, 103],
    );
  });

  test("list_orders filters by an after/before instant window", async () => {
    const result = await harness.client.callTool({
      name: "list_orders",
      arguments: { after: "2024-02-01T00:00:00Z", before: "2024-04-01T00:00:00Z" },
    });
    const payload = parsedContent(result) as { orders: Array<{ id: number }> };
    assert.deepEqual(
      payload.orders.map((order) => order.id),
      [102],
    );
  });

  test("get_order returns a single order", async () => {
    const result = await harness.client.callTool({ name: "get_order", arguments: { order_id: 101 } });
    const payload = parsedContent(result) as { order: { id: number; status: string } };
    assert.equal(payload.order.id, 101);
    assert.equal(payload.order.status, "completed");
  });

  test("get_order reports a friendly error for unknown ids", async () => {
    const result = await harness.client.callTool({ name: "get_order", arguments: { order_id: 999 } });
    assert.equal(result.isError, true);
    assert.match(textContent(result), /Order 999 was not found on the store\./);
  });

  test("update_order_status updates the order on the store", async () => {
    const result = await harness.client.callTool({
      name: "update_order_status",
      arguments: { order_id: 102, status: "completed" },
    });
    assert.ok(result.isError !== true, textContent(result));
    const payload = parsedContent(result) as { order: { id: number; status: string } };
    assert.equal(payload.order.status, "completed");
    assert.equal(store.orders.find((order) => order.id === 102)?.status, "completed");
  });

  test("invalid tool arguments produce a validation error result", async () => {
    const result = await harness.client.callTool({
      name: "update_order_status",
      arguments: { order_id: 102, status: "any" },
    });
    assert.equal(result.isError, true);
    assert.match(textContent(result), /Input validation error/);
  });

  test("create_product without required fields is rejected before reaching the store", async () => {
    const callsBefore = store.calls.length;
    const result = await harness.client.callTool({ name: "create_product", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textContent(result), /Input validation error/);
    assert.equal(store.calls.length, callsBefore);
  });

  test("healthz and readyz respond without MCP session state", async () => {
    const health = await fetch(`${harness.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const ready = await fetch(`${harness.origin}/readyz`);
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as { status: string; sessions: number };
    assert.equal(body.status, "ready");
    assert.ok(body.sessions >= 1);
  });
});
