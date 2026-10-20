import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PERMISSION_DENIED } from "../src/mcp-server.ts";
import { startGatewayHarness } from "./helpers/gateway-harness.ts";

/**
 * End-to-end authorization over the real gateway (fakes only at the
 * upstream/database edges): reader ceiling, one-audit-row-per-call, and
 * principal/session binding. The PostgreSQL-backed path is proven separately
 * by test/integration/postgres.test.ts when TEST_DATABASE_URL is set.
 */

async function connectReader(origin: string, readerKey: string): Promise<Client> {
  const client = new Client({ name: "reader-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${readerKey}` } },
  });
  await client.connect(transport);
  return client;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("end-to-end authorization over MCP", () => {
  test("reader may list and call read tools but is denied write tools with -32003", async () => {
    const harness = await startGatewayHarness();
    const reader = await connectReader(harness.origin, harness.readerKey);
    try {
      const { tools } = await reader.listTools();
      assert.ok(tools.length > 0);
      assert.ok(tools.some((tool) => tool.name === "woocommerce_list_products"));

      const read = await reader.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.ok(read.isError !== true);

      let denied: unknown = null;
      try {
        await reader.callTool({ name: "inventory_adjust_stock", arguments: { sku: "ABC", delta: 1 } });
      } catch (error) {
        denied = error;
      }
      assert.ok(denied !== null, "expected the write call to be rejected");
      assert.ok(denied instanceof Error);
      assert.match(errorMessage(denied), /role 'reader' may not call write tool/);
      assert.equal((denied as { code?: number }).code, PERMISSION_DENIED);

      const denials = harness.auditRepo.byAction("tool_call").filter((row) => row.outcome === "denied");
      assert.equal(denials.length, 1, "exactly one audit row for the denied call");
      const denial = denials[0];
      assert.ok(denial);
      assert.equal(denial.errorCode, "role_forbidden");
      assert.equal(denial.qualifiedName, "inventory_adjust_stock");
      assert.equal(denial.role, "reader");

      // The authorized read produced its own single success row.
      const successes = harness.auditRepo.byAction("tool_call").filter((row) => row.outcome === "success");
      assert.equal(successes.length, 1);
      const success = successes[0];
      assert.ok(success);
      assert.equal(success.qualifiedName, "woocommerce_list_products");
    } finally {
      await reader.close();
      await harness.close();
    }
  });

  test("a non-write tool outside the grant list is denied before any validation or routing", async () => {
    const harness = await startGatewayHarness();
    const reader = await connectReader(harness.origin, harness.readerKey);
    try {
      let denied: unknown = null;
      try {
        // Passes the reader write-ceiling (not a write verb), upstream 'support'
        // is granted, but the exact tool grant is absent — and the tool need
        // not exist anywhere: authorization runs before validation/routing.
        await reader.callTool({ name: "support_list_tickets", arguments: {} });
      } catch (error) {
        denied = error;
      }
      assert.ok(denied !== null);
      assert.equal((denied as { code?: number }).code, PERMISSION_DENIED);

      const denials = harness.auditRepo.byAction("tool_call").filter((row) => row.outcome === "denied");
      assert.equal(denials.length, 1);
      const denial = denials[0];
      assert.ok(denial);
      assert.equal(denial.errorCode, "grant_forbidden");
      assert.equal(denial.qualifiedName, "support_list_tickets");
    } finally {
      await reader.close();
      await harness.close();
    }
  });

  test("connecting with an unknown or revoked key is rejected before any session exists", async () => {
    const harness = await startGatewayHarness();
    try {
      for (const badKey of [`umk_${"A".repeat(43)}`, "not-a-key"]) {
        const client = new Client({ name: "bad-client", version: "0.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${badKey}` } },
        });
        let failed = false;
        try {
          await client.connect(transport);
        } catch {
          failed = true;
        }
        assert.equal(failed, true, `expected connect to fail for ${badKey.slice(0, 8)}`);
        await client.close().catch(() => undefined);
      }

      const failures = harness.auditRepo.byAction("auth_failed");
      assert.ok(failures.length >= 2);
      assert.ok(!JSON.stringify(failures).includes(`umk_${"A".repeat(43)}`));
    } finally {
      await harness.close();
    }
  });
});
