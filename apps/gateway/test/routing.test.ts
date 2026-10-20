import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UPSTREAM_IDS } from "@mcp/shared";
import { parseToolName, qualifyToolName } from "../src/routing.ts";

describe("qualified tool name routing", () => {
  test("qualify and parse round-trip for every known upstream", () => {
    for (const upstreamId of UPSTREAM_IDS) {
      const qualified = qualifyToolName(upstreamId, "list_products");
      assert.equal(qualified, `${upstreamId}_list_products`);
      assert.deepEqual(parseToolName(qualified), { upstreamId, localName: "list_products" });
    }
  });

  test("splits on the first known prefix so local names may contain underscores", () => {
    assert.deepEqual(parseToolName("woocommerce_update_order_status"), {
      upstreamId: "woocommerce",
      localName: "update_order_status",
    });
    assert.deepEqual(parseToolName("woocommerce_list_products"), {
      upstreamId: "woocommerce",
      localName: "list_products",
    });
    assert.deepEqual(parseToolName("support_create_ticket"), {
      upstreamId: "support",
      localName: "create_ticket",
    });
  });

  test("bare local names do not parse", () => {
    assert.equal(parseToolName("list_products"), null);
  });

  test("a prefix with an empty local name does not parse", () => {
    assert.equal(parseToolName("woocommerce_"), null);
  });

  test("unknown prefixes do not parse", () => {
    assert.equal(parseToolName("mystery_list_products"), null);
    assert.equal(parseToolName(""), null);
  });

  test("the same local name under two upstreams produces two distinct qualified names", () => {
    const woo = qualifyToolName("woocommerce", "list_products");
    const inventory = qualifyToolName("inventory", "list_products");
    assert.notEqual(woo, inventory);
    assert.equal(parseToolName(woo)?.upstreamId, "woocommerce");
    assert.equal(parseToolName(inventory)?.upstreamId, "inventory");
  });
});
