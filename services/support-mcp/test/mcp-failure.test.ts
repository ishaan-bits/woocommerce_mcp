import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SupportDataSource, TicketPage, Ticket } from "../src/support-store.ts";
import { createSupportStore } from "../src/support-store.ts";
import { LIST_UNAVAILABLE_MESSAGE, CREATE_UNAVAILABLE_MESSAGE } from "../src/tool-handlers.ts";
import { INITIALIZE_BODY, parsedContent, startHarness, startRawServer, textContent } from "./helpers/test-server.ts";

/** A data source whose backing store is down for the selected method only. */
function flakyStore(failing: "list" | "create" | null): SupportDataSource {
  const healthy = createSupportStore();
  return {
    listTickets(filter, page, perPage): TicketPage {
      if (failing === "list") {
        throw new Error("ECONNRESET: connection reset by peer (internal detail)");
      }
      return healthy.listTickets(filter, page, perPage);
    },
    createTicket(input): Ticket {
      if (failing === "create") {
        throw new Error("ECONNRESET: connection reset by peer (internal detail)");
      }
      return healthy.createTicket(input);
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
      const result = await harness.client.callTool({ name: "list_tickets", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(textContent(result), LIST_UNAVAILABLE_MESSAGE);
      assert.ok(!textContent(result).includes("ECONNRESET"));
      assert.ok(!textContent(result).includes("127.0.0.1"));
    } finally {
      await harness.close();
    }
  });

  test("list keeps working while create fails, and vice versa", async () => {
    const harness = await startHarness({ store: flakyStore("create") });
    try {
      const listed = await harness.client.callTool({ name: "list_tickets", arguments: { per_page: 100 } });
      assert.ok(listed.isError !== true, textContent(listed));
      assert.equal((parsedContent(listed) as { tickets: unknown[] }).tickets.length, 8);

      const created = await harness.client.callTool({
        name: "create_ticket",
        arguments: { customer: "a", subject: "b" },
      });
      assert.equal(created.isError, true);
      assert.equal(textContent(created), CREATE_UNAVAILABLE_MESSAGE);
      assert.ok(!textContent(created).includes("ECONNRESET"));
    } finally {
      await harness.close();
    }
  });

  test("a failing create reports no ticket was created", async () => {
    const harness = await startHarness({ store: flakyStore("create") });
    try {
      const before = parsedContent(
        await harness.client.callTool({ name: "list_tickets", arguments: { per_page: 100 } }),
      ) as { pagination: { total: number } };
      const failed = await harness.client.callTool({
        name: "create_ticket",
        arguments: { customer: "a", subject: "should not appear" },
      });
      assert.equal(failed.isError, true);
      const after = parsedContent(
        await harness.client.callTool({ name: "list_tickets", arguments: { per_page: 100 } }),
      ) as { pagination: { total: number } };
      assert.equal(after.pagination.total, before.pagination.total, "no ticket was appended");
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
