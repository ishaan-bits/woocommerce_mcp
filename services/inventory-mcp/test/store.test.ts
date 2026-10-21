import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InventoryError } from "../src/errors.ts";
import { createInventoryStore, SEED_ITEMS, SEEDED_ITEM_COUNT } from "../src/inventory-store.ts";

describe("seeded inventory store", () => {
  test("seed is deterministic: 12 items, 6 per warehouse, unique SKUs", () => {
    const store = createInventoryStore();
    const all = store.listProducts({}, 1, 100);
    assert.equal(all.total, SEEDED_ITEM_COUNT);
    assert.equal(SEED_ITEMS.length, SEEDED_ITEM_COUNT);
    assert.equal(new Set(SEED_ITEMS.map((item) => item.sku)).size, SEEDED_ITEM_COUNT);
    const north = store.listProducts({ warehouse: "north" }, 1, 100);
    const south = store.listProducts({ warehouse: "south" }, 1, 100);
    assert.equal(north.total, 6);
    assert.equal(south.total, 6);
    assert.ok(all.items.some((item) => item.sku === "TEE-BLK-M" && item.quantity === 120));
  });

  test("unknown warehouse yields an empty page, not an error", () => {
    const page = createInventoryStore().listProducts({ warehouse: "east" }, 1, 10);
    assert.equal(page.total, 0);
    assert.deepEqual(page.items, []);
  });

  test("pagination slices the seeded order deterministically", () => {
    const store = createInventoryStore();
    const page1 = store.listProducts({}, 1, 5);
    const page3 = store.listProducts({}, 3, 5);
    assert.equal(page1.items.length, 5);
    assert.equal(page3.items.length, 2);
    assert.equal(page1.items[0]?.sku, SEED_ITEMS[0]?.sku);
    assert.equal(page3.items[0]?.sku, SEED_ITEMS[10]?.sku);
    const beyond = store.listProducts({}, 9, 5);
    assert.deepEqual(beyond.items, []);
  });

  test("adjust_stock applies the delta and reports the previous quantity", () => {
    const store = createInventoryStore();
    const result = store.adjustStock("TEE-BLK-M", -3);
    assert.equal(result.previousQuantity, 120);
    assert.equal(result.item.quantity, 117);
    const again = store.adjustStock("tee-blk-m", 2);
    assert.equal(again.previousQuantity, 117);
    assert.equal(again.item.quantity, 119);
  });

  test("unknown SKUs are rejected without changing anything", () => {
    const store = createInventoryStore();
    assert.throws(() => store.adjustStock("NOPE-1", 1), (error: unknown) => {
      assert.ok(error instanceof InventoryError);
      assert.match(error.message, /Unknown SKU 'NOPE-1'/);
      return true;
    });
    assert.equal(store.listProducts({}, 1, 100).items.find((i) => i.sku === "TEE-BLK-M")?.quantity, 120);
  });

  test("adjustments that would drop below zero are rejected", () => {
    const store = createInventoryStore();
    assert.throws(() => store.adjustStock("TOTE-NAT-01", -100), (error: unknown) => {
      assert.ok(error instanceof InventoryError);
      assert.match(error.message, /drop below zero/);
      return true;
    });
    assert.equal(store.listProducts({}, 1, 100).items.find((i) => i.sku === "TOTE-NAT-01")?.quantity, 27);
  });

  test("pages return copies, so callers cannot mutate the store by reference", () => {
    const store = createInventoryStore();
    const page = store.listProducts({}, 1, 100);
    page.items[0]!.quantity = 99_999;
    const fresh = store.listProducts({}, 1, 100);
    assert.notEqual(fresh.items[0]?.quantity, 99_999);
  });
});
