import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import { createMockStore } from "./helpers/mock-store.ts";
import { INITIALIZE_BODY, parsedContent, startHarness, startRawServer, textContent } from "./helpers/test-server.ts";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function rpcError(response: Response): Promise<{ status: number; code: unknown; message: unknown }> {
  const body = (await readJson(response)) as { error?: { code?: unknown; message?: unknown } };
  return { status: response.status, code: body.error?.code, message: body.error?.message };
}

describe("store failures surface as tool errors", () => {
  test("connection failures explain that the store is unreachable", async () => {
    const harness = await startHarness({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    try {
      const result = await harness.client.callTool({ name: "list_products", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /Could not reach the store/);
    } finally {
      await harness.close();
    }
  });

  test("timeouts mention the configured budget", async () => {
    const harness = await startHarness({
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      }) as typeof fetch,
    });
    try {
      const result = await harness.client.callTool({ name: "list_orders", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /did not respond within 5000 ms/);
    } finally {
      await harness.close();
    }
  });

  test("HTTP 401 explains the HTTPS Basic auth requirement", async () => {
    const store = createMockStore();
    store.setFail({
      kind: "status",
      status: 401,
      body: { code: "woocommerce_rest_authentication_error", message: "Consumer secret is invalid." },
    });
    const harness = await startHarness({ fetchImpl: store.fetchImpl });
    try {
      const result = await harness.client.callTool({ name: "get_order", arguments: { order_id: 1 } });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /HTTP 401/);
      assert.match(textContent(result), /HTTPS/);
    } finally {
      await harness.close();
    }
  });

  test("non-JSON store responses are reported as unexpected", async () => {
    const store = createMockStore();
    store.setFail({ kind: "malformed" });
    const harness = await startHarness({ fetchImpl: store.fetchImpl });
    try {
      const result = await harness.client.callTool({ name: "list_products", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /unexpected/);
    } finally {
      await harness.close();
    }
  });

  test("a healthy result is not marked as an error", async () => {
    const store = createMockStore({ products: [{ id: 1, name: "Tea", regular_price: "1.00" }] });
    const harness = await startHarness({ fetchImpl: store.fetchImpl });
    try {
      const result = await harness.client.callTool({ name: "list_products", arguments: {} });
      assert.ok(result.isError !== true);
      const payload = parsedContent(result) as { products: unknown[] };
      assert.equal(payload.products.length, 1);
    } finally {
      await harness.close();
    }
  });
});

describe("raw HTTP protocol behavior", () => {
  test("POST without a session and not an initialize request returns 400", async () => {
    const server = await startRawServer();
    try {
      const response = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const error = await rpcError(response);
      assert.equal(error.status, 400);
      assert.equal(error.code, -32000);
    } finally {
      await server.close();
    }
  });

  test("POST with an unknown session id returns 404", async () => {
    const server = await startRawServer();
    try {
      const response = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": "does-not-exist" },
        body: JSON.stringify(INITIALIZE_BODY),
      });
      const error = await rpcError(response);
      assert.equal(error.status, 404);
      assert.equal(error.code, -32001);
    } finally {
      await server.close();
    }
  });

  test("GET and DELETE without a session id return 400", async () => {
    const server = await startRawServer();
    try {
      for (const method of ["GET", "DELETE"] as const) {
        const response = await fetch(`${server.origin}/mcp`, { method });
        assert.equal(response.status, 400, `${method} should require a session id`);
      }
    } finally {
      await server.close();
    }
  });

  test("invalid JSON bodies return a JSON-RPC parse error", async () => {
    const server = await startRawServer();
    try {
      const response = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not json",
      });
      const error = await rpcError(response);
      assert.equal(error.status, 400);
      assert.equal(error.code, -32700);
    } finally {
      await server.close();
    }
  });

  test("DELETE terminates a session and later requests get 404", async () => {
    const server = await startRawServer();
    try {
      const initialize = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      });
      assert.equal(initialize.status, 200);
      const sessionId = initialize.headers.get("mcp-session-id");
      assert.ok(sessionId !== null && sessionId.length > 0);

      const terminate = await fetch(`${server.origin}/mcp`, {
        method: "DELETE",
        headers: { accept: MCP_HEADERS.accept, "mcp-session-id": sessionId },
      });
      assert.ok(terminate.status === 200 || terminate.status === 204, `unexpected DELETE status ${terminate.status}`);

      const afterDelete = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      const error = await rpcError(afterDelete);
      assert.equal(error.status, 404);
      assert.equal(error.code, -32001);
    } finally {
      await server.close();
    }
  });

  test("session capacity is enforced with 503", async () => {
    const server = await startRawServer({ maxSessions: 1 });
    try {
      const first = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      });
      assert.equal(first.status, 200);

      const second = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      });
      const error = await rpcError(second);
      assert.equal(error.status, 503);
      assert.equal(error.code, -32000);
      assert.equal(error.message, "Too many open sessions");
    } finally {
      await server.close();
    }
  });

  test("idle sessions are swept and readyz reflects the count", async () => {
    const server = await startRawServer({ sessionIdleMs: 40, sweepIntervalMs: 20 });
    try {
      const initialize = await fetch(`${server.origin}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE_BODY),
      });
      assert.equal(initialize.status, 200);

      let sessions = -1;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(20);
        const ready = await fetch(`${server.origin}/readyz`);
        const body = (await ready.json()) as { sessions: number };
        sessions = body.sessions;
        if (sessions === 0) break;
      }
      assert.equal(sessions, 0, "expected the idle session to be swept");
    } finally {
      await server.close();
    }
  });

  test("draining after close rejects new sessions and reports not-ready", async () => {
    const server = await startRawServer();
    await server.mcpApp.close();

    const ready = await fetch(`${server.origin}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await readJson(ready), { status: "draining" });

    const initialize = await fetch(`${server.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    const error = await rpcError(initialize);
    assert.equal(error.status, 503);
    assert.equal(error.message, "Server is shutting down");

    await server.close();
  });
});
