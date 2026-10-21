import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InventoryDataSource } from "../src/inventory-store.ts";
import { createInventoryStore, type AdjustResult, type StockPage } from "../src/inventory-store.ts";
import { UNAVAILABLE_MESSAGE } from "../src/tool-handlers.ts";
import { INITIALIZE_BODY, parsedContent, startHarness, startRawServer, textContent } from "./helpers/test-server.ts";

/** A data source whose backing store is down for the selected method only. */
function flakyStore(failing: "list" | "adjust" | null): InventoryDataSource {
  const healthy = createInventoryStore();
  return {
    listProducts(filter, page, perPage): StockPage {
      if (failing === "list") {
        throw new Error("ECONNRESET: connection reset by peer (internal detail)");
      }
      return healthy.listProducts(filter, page, perPage);
    },
    adjustStock(sku, delta): AdjustResult {
      if (failing === "adjust") {
        throw new Error("ECONNRESET: connection reset by peer (internal detail)");
      }
      return healthy.adjustStock(sku, delta);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("unavailable data surfaces as safe tool errors", () => {
  test("a down list source returns the fixed sentence, never internals", async () => {
    const harness = await startHarness({ store: flakyStore("list") });
    try {
      const result = await harness.client.callTool({ name: "list_products", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(textContent(result), UNAVAILABLE_MESSAGE);
      assert.ok(!textContent(result).includes("ECONNRESET"));
      assert.ok(!textContent(result).includes("127.0.0.1"));
    } finally {
      await harness.close();
    }
  });

  test("list keeps working while adjust fails, and vice versa", async () => {
    const harness = await startHarness({ store: flakyStore("adjust") });
    try {
      const listed = await harness.client.callTool({ name: "list_products", arguments: { per_page: 100 } });
      assert.ok(listed.isError !== true, textContent(listed));
      assert.equal((parsedContent(listed) as { products: unknown[] }).products.length, 12);

      const adjusted = await harness.client.callTool({
        name: "adjust_stock",
        arguments: { sku: "TEE-BLK-M", delta: 1 },
      });
      assert.equal(adjusted.isError, true);
      assert.equal(textContent(adjusted), UNAVAILABLE_MESSAGE);
    } finally {
      await harness.close();
    }
  });
});

describe("raw HTTP surface", () => {
  test("health and readiness answer without a session", async () => {
    const raw = await startRawServer();
    try {
      const health = await fetch(`${raw.origin}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await readJson(health), { status: "ok" });

      const ready = await fetch(`${raw.origin}/readyz`);
      assert.equal(ready.status, 200);
      assert.equal((await readJson(ready)).status, "ready");
    } finally {
      await raw.close();
    }
  });

  test("GET /mcp without a session is 400; unknown session is 404", async () => {
    const raw = await startRawServer();
    try {
      const missing = await fetch(`${raw.origin}/mcp`);
      assert.equal(missing.status, 400);

      const unknown = await fetch(`${raw.origin}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": "does-not-exist" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      assert.equal(unknown.status, 404);
      const body = await readJson(unknown);
      assert.equal((body.error as { code?: number }).code, -32001);
    } finally {
      await raw.close();
    }
  });

  test("a non-JSON body is a JSON-RPC parse error", async () => {
    const raw = await startRawServer();
    try {
      const response = await fetch(`${raw.origin}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": "whatever" },
        body: "{not json",
      });
      assert.equal(response.status, 400);
      const body = await readJson(response);
      assert.equal((body.error as { code?: number }).code, -32700);
    } finally {
      await raw.close();
    }
  });

  test("session capacity is enforced with 503", async () => {
    const raw = await startRawServer({ maxSessions: 1 });
    try {
      const first = await fetch(`${raw.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      });
      assert.equal(first.status, 200);
      await first.text();

      const second = await fetch(`${raw.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ ...INITIALIZE_BODY, id: 99 }),
      });
      assert.equal(second.status, 503);
      const body = await readJson(second);
      assert.equal((body.error as { code?: number }).code, -32000);
    } finally {
      await raw.close();
    }
  });

  test("after close the server drains: readyz 503 and /mcp refuses new work", async () => {
    const raw = await startRawServer();
    try {
      await raw.mcpApp.close();
      const ready = await fetch(`${raw.origin}/readyz`);
      assert.equal(ready.status, 503);
      assert.equal((await readJson(ready)).status, "draining");

      const post = await fetch(`${raw.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      });
      assert.equal(post.status, 503);
      const body = await readJson(post);
      assert.equal((body.error as { code?: number }).code, -32000);
      assert.match((body.error as { message?: string }).message ?? "", /shutting down/);
    } finally {
      await raw.close();
    }
  });
});
