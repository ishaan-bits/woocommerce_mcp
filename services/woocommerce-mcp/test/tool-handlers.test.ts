/**
 * Regression tests for the product-listing accuracy bug (screenshot report):
 * models saw truncated 17 KB product dumps and invented ID ranges
 * ("ProductId: 20 to 21") and pagination claims. The handlers must return one
 * real id per product (never ranges/merges), explicit pagination built only
 * from real API metadata, and compact results that survive size caps.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createToolHandlers } from "../src/tool-handlers.ts";
import type { WooCommerceClient } from "../src/woocommerce-client.ts";

function parsed(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = result.content[0];
  if (block === undefined || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

function stubClient(overrides: Partial<Record<keyof WooCommerceClient, unknown>> = {}): WooCommerceClient {
  const products = [
    { id: 21, name: "Local LLM Demo Product", price: "5.99", regular_price: "5.99", status: "publish", sku: "LLM-DEMO-001", permalink: "http://shop.urumi.test:18080/product/local-llm-demo-product/" },
    { id: 20, name: "DoD Drill Product", price: "9.99", regular_price: "9.99", status: "publish", sku: "DOD-DRILL-001", permalink: "http://shop.urumi.test:18080/product/dod-drill-product/" },
    { id: 13, name: "Stoneware Mug 350ml", price: "12.00", regular_price: "12.00", status: "publish", sku: "URUMI-MUG-001", permalink: "http://shop.urumi.test:18080/product/stoneware-mug-350ml/" },
  ];
  return {
    listProducts: async () => ({
      items: products,
      pagination: { page: 1, per_page: 10, total: 6, total_pages: 1 },
    }),
    createProduct: async () => products[0],
    listOrders: async () => ({
      items: [{ id: 22, status: "processing", total: "5.99", currency: "USD", date_created: "2026-10-25T12:00:00", date_created_gmt: "2026-10-25T12:00:00" }],
      pagination: { page: 1, per_page: 10, total: 6, total_pages: 1 },
    }),
    getOrder: async () => ({ id: 22, status: "processing", total: "5.99", currency: "USD", date_created: "2026-10-25T12:00:00", date_created_gmt: "2026-10-25T12:00:00" }),
    updateOrderStatus: async () => ({ id: 22, status: "completed", total: "5.99" }),
    ...overrides,
  } as unknown as WooCommerceClient;
}

describe("list_products accuracy (screenshot regression)", () => {
  test("every product keeps its own real id — never a range, never merged ids", async () => {
    const handlers = createToolHandlers(stubClient());
    const payload = parsed(await handlers.listProducts({ page: 1, per_page: 10 })) as {
      products: Array<Record<string, unknown>>;
    };
    const ids = payload.products.map((product) => product.id);
    assert.deepEqual(ids, [21, 20, 13], "ids stay separate and accurate");
    assert.equal(new Set(ids).size, ids.length);
    const raw = JSON.stringify(payload);
    assert.ok(!/\d+\s+to\s+\d+/.test(raw), "no 'NN to NN' id ranges anywhere");
  });

  test("product fields are preserved accurately (id, name, price, status, sku, permalink)", async () => {
    const handlers = createToolHandlers(stubClient());
    const payload = parsed(await handlers.listProducts({ page: 1, per_page: 10 })) as {
      products: Array<Record<string, unknown>>;
    };
    const first = payload.products[0];
    assert.equal(first?.id, 21);
    assert.equal(first?.name, "Local LLM Demo Product");
    assert.equal(first?.price, "5.99");
    assert.equal(first?.regular_price, "5.99");
    assert.equal(first?.status, "publish");
    assert.equal(first?.sku, "LLM-DEMO-001");
    assert.equal(first?.permalink, "http://shop.urumi.test:18080/product/local-llm-demo-product/");
  });

  test("result stays compact: 3 products fit far below the 6000-char model cap", async () => {
    const handlers = createToolHandlers(stubClient());
    const rawBlock = (await handlers.listProducts({ page: 1, per_page: 10 })).content[0];
    const raw = rawBlock !== undefined && rawBlock.type === "text" ? rawBlock.text : "";
    assert.ok(raw.length < 2_000, `expected a compact result, got ${raw.length} chars`);
    assert.ok(raw.indexOf('"pagination"') < raw.indexOf('"products"'), "pagination serialized first");
  });

  test("empty product page is represented correctly", async () => {
    const handlers = createToolHandlers(
      stubClient({
        listProducts: async () => ({ items: [], pagination: { page: 1, per_page: 10, total: 0, total_pages: 0 } }),
      }),
    );
    const payload = parsed(await handlers.listProducts({ page: 1, per_page: 10 })) as {
      products: unknown[];
      pagination: Record<string, unknown>;
    };
    assert.deepEqual(payload.products, []);
    assert.equal(payload.pagination.returned, 0);
    assert.equal(payload.pagination.total_products, 0);
    assert.equal(payload.pagination.has_more, false);
  });

  test("a complete single page is never presented as multi-page", async () => {
    const handlers = createToolHandlers(stubClient());
    const payload = parsed(await handlers.listProducts({ page: 1, per_page: 10 })) as { pagination: Record<string, unknown> };
    assert.equal(payload.pagination.total_pages, 1);
    assert.equal(payload.pagination.has_more, false);
  });

  test("a genuine multi-page result follows the real metadata", async () => {
    const handlers = createToolHandlers(
      stubClient({
        listProducts: async () => ({
          items: [{ id: 1, name: "A" }],
          pagination: { page: 1, per_page: 1, total: 3, total_pages: 3 },
        }),
      }),
    );
    const firstPage = parsed(await handlers.listProducts({ page: 1, per_page: 1 })) as { pagination: Record<string, unknown> };
    assert.equal(firstPage.pagination.has_more, true);
    assert.equal(firstPage.pagination.total_products, 3);
    assert.equal(firstPage.pagination.total_pages, 3);

    const handlersLast = createToolHandlers(
      stubClient({
        listProducts: async () => ({
          items: [{ id: 3, name: "C" }],
          pagination: { page: 3, per_page: 1, total: 3, total_pages: 3 },
        }),
      }),
    );
    const lastPage = parsed(await handlersLast.listProducts({ page: 3, per_page: 1 })) as { pagination: Record<string, unknown> };
    assert.equal(lastPage.pagination.has_more, false);
  });

  test("missing pagination headers produce null totals — never fabricated numbers", async () => {
    const handlers = createToolHandlers(
      stubClient({
        listProducts: async () => ({
          items: [{ id: 1, name: "A" }],
          pagination: { page: 1, per_page: 10, total: null, total_pages: null },
        }),
      }),
    );
    const payload = parsed(await handlers.listProducts({ page: 1, per_page: 10 })) as { pagination: Record<string, unknown> };
    assert.equal(payload.pagination.total_products, null);
    assert.equal(payload.pagination.total_pages, null);
    assert.equal(payload.pagination.has_more, null, "unknown metadata must not claim 'no more pages'");
  });
});

describe("order projections stay factual", () => {
  test("list_orders keeps real ids, status, total and timestamps per order", async () => {
    const handlers = createToolHandlers(stubClient());
    const payload = parsed(await handlers.listOrders({ page: 1, per_page: 10, dates_are_gmt: true })) as {
      orders: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    assert.equal(payload.orders[0]?.id, 22);
    assert.equal(payload.orders[0]?.status, "processing");
    assert.equal(payload.orders[0]?.total, "5.99");
    assert.equal(payload.orders[0]?.date_created, "2026-10-25T12:00:00");
    assert.equal(payload.pagination.total_orders, 6);
    assert.equal(payload.pagination.has_more, false);
  });

  test("get_order / update_order_status return the single real order", async () => {
    const handlers = createToolHandlers(stubClient());
    const got = parsed(await handlers.getOrder({ order_id: 22 })) as { order: Record<string, unknown> };
    assert.equal(got.order.id, 22);
    const updated = parsed(await handlers.updateOrderStatus({ order_id: 22, status: "completed" })) as {
      order: Record<string, unknown>;
    };
    assert.equal(updated.order.status, "completed");
    assert.equal(updated.order.id, 22);
  });
});