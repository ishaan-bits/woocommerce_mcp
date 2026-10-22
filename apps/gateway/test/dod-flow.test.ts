/**
 * Milestone 11 Phase 4 — definition-of-done walkthrough (deterministic).
 *
 * Mirrors docs/demo-runbook.md steps T1–T7 against the in-process harness with
 * two seeded users (admin-demo = demo user A, reader-demo = demo user B):
 * one member session answering a question that needs two upstreams, key
 * revocation, upstream disable/enable visible to BOTH the external client and
 * the chat agent's offered tools, a killed upstream that fails alone, and
 * audit attribution for every call. Mocked upstreams + a scripted provider —
 * no network, no LLM quota, no flaky timing.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ApiKeyPrincipal } from "@mcp/shared";
import { createChatAgent } from "../src/agent/agent.ts";
import { ScriptedProvider } from "./helpers/fake-provider.ts";
import { createAuditWriter } from "../src/audit.ts";
import { createLogger } from "../src/logger.ts";
import {
  ADMIN_USER_ID,
  READER_USER_ID,
  startGatewayHarness,
  type GatewayHarness,
} from "./helpers/gateway-harness.ts";

function textContent(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

async function connectClient(harness: GatewayHarness, key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "dod-flow", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The reader-demo principal exactly as the harness seeds it (read tools only). */
function memberPrincipal(): ApiKeyPrincipal {
  return {
    userId: READER_USER_ID,
    displayName: "reader-demo",
    role: "reader",
    allowedUpstreams: ["woocommerce", "inventory", "support"],
    allowedTools: [
      "tools:woocommerce_list_products",
      "tools:woocommerce_get_order",
      "tools:inventory_list_products",
      "tools:support_list_tickets",
    ],
    keyId: "key-dod-reader",
  };
}

function toolRows(auditRepo: GatewayHarness["auditRepo"]): Array<{
  userId: string | null;
  upstreamId: string | null;
  toolName: string | null;
  outcome: string;
}> {
  return auditRepo.entries
    .filter((entry) => entry.action === "tool_call")
    .map((entry) => ({
      userId: entry.userId,
      upstreamId: entry.upstreamId,
      toolName: entry.toolName,
      outcome: String(entry.outcome),
    }));
}

describe("definition-of-done walkthrough (two users, deterministic)", () => {
  test("D6: one member session answers a question that needs tools from two upstreams", async () => {
    const harness = await startGatewayHarness();
    const member = await connectClient(harness, harness.readerKey);
    try {
      // User B's prompt: "compare products and orders" → two upstreams in ONE
      // session (same transport, same key), exactly like the demo prompt.
      const products = await member.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.ok(products.isError !== true, textContent(products));
      const stock = await member.callTool({ name: "inventory_list_products", arguments: {} });
      assert.ok(stock.isError !== true, textContent(stock));

      const upstreams = new Set(toolRows(harness.auditRepo).map((row) => row.upstreamId));
      assert.ok(upstreams.has("woocommerce"), `audit names woocommerce: ${JSON.stringify([...upstreams])}`);
      assert.ok(upstreams.has("inventory"), `audit names inventory: ${JSON.stringify([...upstreams])}`);
    } finally {
      await member.close();
      await harness.close();
    }
  });

  test("D7: revoking user B's key rejects their very next call", async () => {
    const harness = await startGatewayHarness();
    try {
      const { key, keyId } = harness.authRepo.issueKey(READER_USER_ID, harness.pepper);
      const member = await connectClient(harness, key);
      try {
        const before = await member.callTool({ name: "inventory_list_products", arguments: {} });
        assert.ok(before.isError !== true, textContent(before));

        // Revoking through the dashboard's own API — the way the demo does it.
        const revoke = await fetch(`${harness.origin}/api/keys/${keyId}/revoke`, {
          method: "POST",
          headers: harness.authHeaders(),
        });
        assert.equal(revoke.status, 200);

        await assert.rejects(
          () => member.callTool({ name: "inventory_list_products", arguments: {} }),
          (error: unknown) => {
            const message = String(error);
            assert.match(message, /401|unauthorized/i, message);
            assert.ok(!message.includes(key), "the rejection never echoes the key");
            return true;
          },
        );

        // The REST surface rejects the same key identically.
        const me = await fetch(`${harness.origin}/api/me`, { headers: harness.authHeaders(key) });
        assert.equal(me.status, 401);
      } finally {
        await member.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("D8: disabling an upstream removes its tools from the external client AND the chat agent", async () => {
    const harness = await startGatewayHarness();
    const provider = new ScriptedProvider([{ content: "done" }]);
    const logger = createLogger({ level: "error", sink: { write: () => undefined } });
    const agent = createChatAgent({
      provider,
      registry: harness.registry,
      logger,
      audit: createAuditWriter(harness.auditRepo, logger),
    });
    try {
      const before = await harness.client.listTools();
      assert.ok(before.tools.some((tool) => tool.name === "inventory_list_products"));

      const off = await fetch(`${harness.origin}/api/upstreams/inventory:disable`, {
        method: "POST",
        headers: harness.authHeaders(),
      });
      assert.equal(off.status, 200);

      const after = await harness.client.listTools();
      assert.ok(!after.tools.some((tool) => tool.name.startsWith("inventory_")), "external client loses the tools");
      assert.ok(after.tools.some((tool) => tool.name === "woocommerce_list_products"), "siblings unaffected");

      // Chat agent side: the model is no longer OFFERED the disabled tools.
      await agent.run({ message: "anything" }, memberPrincipal());
      const offered = provider.requests[0]?.tools.map((tool) => tool.name) ?? [];
      assert.ok(!offered.some((name) => name.startsWith("inventory_")), `agent still offered: ${offered.join(",")}`);
      assert.ok(offered.includes("woocommerce_list_products"));

      const on = await fetch(`${harness.origin}/api/upstreams/inventory:enable`, {
        method: "POST",
        headers: harness.authHeaders(),
      });
      assert.equal(on.status, 200);
      const restored = await harness.client.listTools();
      assert.ok(restored.tools.some((tool) => tool.name === "inventory_list_products"), "re-enable restores the tools");
    } finally {
      await harness.close();
    }
  });

  test("D9: a killed upstream fails alone, and the dashboard state shows it unreachable", async () => {
    const harness = await startGatewayHarness();
    try {
      const okStock = await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
      assert.ok(okStock.isError !== true, textContent(okStock));

      await harness.stopFake("inventory");

      const dead = await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
      assert.equal(dead.isError, true, textContent(dead));
      assert.match(textContent(dead), /unreachable/);

      const sibling = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.ok(sibling.isError !== true, "the sibling upstream keeps working");

      const status = await fetch(`${harness.origin}/api/upstreams`, { headers: harness.authHeaders() });
      assert.equal(status.status, 200);
      const body = (await status.json()) as {
        upstreams: Array<{ id: string; reachable: boolean; last_error: string | null }>;
      };
      const inventory = body.upstreams.find((entry) => entry.id === "inventory");
      assert.ok(inventory, JSON.stringify(body.upstreams));
      assert.equal(inventory.reachable, false);
      assert.ok(typeof inventory.last_error === "string" && inventory.last_error.length > 0);
    } finally {
      await harness.close();
    }
  });

  test("D10: every call in the walkthrough is in the audit log under the right user", async () => {
    const harness = await startGatewayHarness();
    try {
      const { key, keyId } = harness.authRepo.issueKey(READER_USER_ID, harness.pepper);
      const member = await connectClient(harness, key);
      try {
        await member.callTool({ name: "woocommerce_list_products", arguments: {} });
        await member.callTool({ name: "inventory_list_products", arguments: {} });
      } finally {
        await member.close();
      }
      // Revoking through the dashboard's own API — the way the demo does it.
      const revoke = await fetch(`${harness.origin}/api/keys/${keyId}/revoke`, {
        method: "POST",
        headers: harness.authHeaders(),
      });
      assert.equal(revoke.status, 200);

      const readerRows = toolRows(harness.auditRepo).filter((row) => row.userId === READER_USER_ID);
      assert.deepEqual(
        readerRows.map((row) => [row.upstreamId, row.toolName, row.outcome]).sort(),
        (
          [
            ["inventory", "list_products", "success"],
            ["woocommerce", "list_products", "success"],
          ] as Array<[string, string, string]>
        ).sort(),
        `member's calls attributed: ${JSON.stringify(readerRows)}`,
      );

      const audit = await fetch(`${harness.origin}/api/audit?limit=50`, { headers: harness.authHeaders() });
      assert.equal(audit.status, 200);
      const body = (await audit.json()) as {
        entries: Array<{ action: string; userId: string | null; keyId?: string | null }>;
      };
      const revoked = body.entries.find((entry) => entry.action === "key_revoked");
      assert.ok(revoked, "revocation itself is audited");
      // The action is attributed to WHO performed it (user A, the admin)…
      assert.equal(revoked.userId, ADMIN_USER_ID);
      // …and names WHICH key was revoked.
      assert.equal(revoked.keyId, keyId);
    } finally {
      await harness.close();
    }
  });
});
