import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { adjustStockInput, listProductsInput, DELTA_MESSAGE, PAGE_MESSAGE, PER_PAGE_MESSAGE, SKU_MESSAGE } from "../src/tool-schemas.ts";

const listSchema = z.object(listProductsInput);
const adjustSchema = z.object(adjustStockInput);

describe("list_products input", () => {
  test("defaults page and per_page like the other MCP servers", () => {
    const parsed = listSchema.parse({});
    assert.equal(parsed.page, 1);
    assert.equal(parsed.per_page, 10);
    assert.equal(parsed.warehouse, undefined);
  });

  test("accepts a warehouse filter and coerced numeric strings", () => {
    const parsed = listSchema.parse({ warehouse: "north", page: "2", per_page: "5" });
    assert.equal(parsed.warehouse, "north");
    assert.equal(parsed.page, 2);
    assert.equal(parsed.per_page, 5);
  });

  test("rejects out-of-range pages and per_page", () => {
    for (const args of [{ page: 0 }, { page: 1.5 }, { per_page: 0 }, { per_page: 101 }]) {
      const result = listSchema.safeParse(args);
      assert.equal(result.success, false, JSON.stringify(args));
      const issue = result.success ? "" : result.error.issues[0]?.message ?? "";
      assert.ok(issue === PAGE_MESSAGE || issue === PER_PAGE_MESSAGE, issue);
    }
  });

  test("rejects a non-string warehouse", () => {
    assert.equal(listSchema.safeParse({ warehouse: 7 }).success, false);
  });
});

describe("adjust_stock input", () => {
  test("accepts a valid sku and delta", () => {
    const parsed = adjustSchema.parse({ sku: "TEE-BLK-M", delta: -3 });
    assert.equal(parsed.sku, "TEE-BLK-M");
    assert.equal(parsed.delta, -3);
  });

  test("coerces numeric strings", () => {
    assert.equal(adjustSchema.parse({ sku: "X", delta: "5" }).delta, 5);
  });

  test("requires sku and rejects empty strings", () => {
    assert.equal(adjustSchema.safeParse({ delta: 1 }).success, false, "sku is required");
    const empty = adjustSchema.safeParse({ sku: "", delta: 1 });
    assert.equal(empty.success, false);
    if (!empty.success) {
      assert.equal(empty.error.issues[0]?.message, SKU_MESSAGE);
    }
  });

  test("rejects zero, fractional, non-numeric and out-of-range deltas", () => {
    for (const delta of [0, 1.5, "junk", 1001, -1001]) {
      const result = adjustSchema.safeParse({ sku: "TEE-BLK-M", delta });
      assert.equal(result.success, false, `delta ${String(delta)} must be rejected`);
      if (!result.success) {
        assert.equal(result.error.issues[0]?.message, DELTA_MESSAGE);
      }
    }
  });
});
