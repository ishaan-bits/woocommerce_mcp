import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  createProductInput,
  getOrderInput,
  listOrdersInput,
  listProductsInput,
  PRICE_MESSAGE,
  updateOrderStatusInput,
} from "../src/tool-schemas.ts";

function parseShape(shape: Parameters<typeof z.object>[0], value: unknown) {
  return z.object(shape).safeParse(value);
}

describe("list_products input", () => {
  test("defaults page and per_page", () => {
    const result = parseShape(listProductsInput, {});
    assert.ok(result.success);
    assert.deepEqual(result.data, { page: 1, per_page: 10 });
  });

  test("coerces numeric strings and passes filters through", () => {
    const result = parseShape(listProductsInput, { page: "2", per_page: "5", search: "Tea", status: "publish" });
    assert.ok(result.success);
    assert.deepEqual(result.data, { page: 2, per_page: 5, search: "Tea", status: "publish" });
  });

  test("rejects out-of-range page, per_page and unknown statuses", () => {
    for (const args of [{ page: 0 }, { page: 1.5 }, { per_page: 0 }, { per_page: 101 }, { status: "archived" }]) {
      const result = parseShape(listProductsInput, args);
      assert.ok(!result.success, `expected ${JSON.stringify(args)} to be rejected`);
    }
  });
});

describe("create_product input", () => {
  test("accepts a decimal string price", () => {
    const result = parseShape(createProductInput, { name: "Green Tea", regular_price: "19.99" });
    assert.ok(result.success);
    assert.equal(result.data?.regular_price, "19.99");
  });

  test("coerces finite numbers to decimal strings", () => {
    const result = parseShape(createProductInput, { name: "Green Tea", regular_price: 19.99 });
    assert.ok(result.success);
    assert.equal(result.data?.regular_price, "19.99");
  });

  test("rejects prices with too many fractions, signs or junk", () => {
    for (const regular_price of ["19.999", "-1", "€19.99", "1e2", "", "abc"]) {
      const result = parseShape(createProductInput, { name: "Green Tea", regular_price });
      assert.ok(!result.success, `expected price ${JSON.stringify(regular_price)} to be rejected`);
      if (!result.success) {
        assert.equal(result.error.issues[0]?.path[0], "regular_price");
        assert.equal(result.error.issues[0]?.message, PRICE_MESSAGE);
      }
    }
  });

  test("requires name and regular_price", () => {
    assert.ok(!parseShape(createProductInput, {}).success);
    assert.ok(!parseShape(createProductInput, { name: "Tea" }).success);
    assert.ok(!parseShape(createProductInput, { regular_price: "1.00" }).success);
  });

  test("validates optional fields when present", () => {
    const result = parseShape(createProductInput, {
      name: "Tea",
      regular_price: "1.00",
      stock_quantity: -1,
      status: "live",
    });
    assert.ok(!result.success);
  });
});

describe("list_orders input", () => {
  test("defaults dates_are_gmt to true and pagination defaults", () => {
    const result = listOrdersInput.safeParse({});
    assert.ok(result.success);
    assert.deepEqual(result.data, { page: 1, per_page: 10, dates_are_gmt: true });
  });

  test("accepts ISO-8601 instants with offset and string booleans", () => {
    const result = listOrdersInput.safeParse({
      after: "2024-01-01T00:00:00Z",
      before: "2024-02-01T00:00:00+05:30",
      dates_are_gmt: "false",
      status: "completed",
    });
    assert.ok(result.success);
    assert.equal(result.data?.dates_are_gmt, false);
    assert.equal(result.data?.status, "completed");
  });

  test("rejects dates without an explicit offset", () => {
    const result = listOrdersInput.safeParse({ after: "2024-01-01T00:00:00" });
    assert.ok(!result.success);
  });

  test("rejects a window where after is not earlier than before", () => {
    const result = listOrdersInput.safeParse({
      after: "2024-02-01T00:00:00Z",
      before: "2024-01-01T00:00:00Z",
    });
    assert.ok(!result.success);
    assert.match(result.error.issues[0]?.message ?? "", /after must be a valid instant earlier than before/);
  });

  test("rejects garbage dates and multi-status strings", () => {
    assert.ok(!listOrdersInput.safeParse({ after: "not-a-date", before: "2024-01-01T00:00:00Z" }).success);
    assert.ok(!listOrdersInput.safeParse({ status: "completed,refunded" }).success);
  });
});

describe("get_order and update_order_status input", () => {
  test("coerces order_id from strings and rejects non-positive ids", () => {
    const ok = parseShape(getOrderInput, { order_id: "15" });
    assert.ok(ok.success);
    assert.equal(ok.data?.order_id, 15);
    assert.ok(!parseShape(getOrderInput, { order_id: 0 }).success);
    assert.ok(!parseShape(getOrderInput, { order_id: "abc" }).success);
    assert.ok(!parseShape(getOrderInput, {}).success);
  });

  test("accepts every write status and rejects read-only pseudo statuses", () => {
    for (const status of ["pending", "processing", "completed", "on-hold", "cancelled", "refunded", "failed"]) {
      const result = parseShape(updateOrderStatusInput, { order_id: 1, status });
      assert.ok(result.success, `expected ${status} to be accepted`);
    }
    for (const status of ["any", "trash", "archived", ""]) {
      const result = parseShape(updateOrderStatusInput, { order_id: 1, status });
      assert.ok(!result.success, `expected ${status} to be rejected`);
    }
  });
});
