/**
 * Milestone 9 — POST /api/chat HTTP surface. Uses the full gateway harness
 * (fake upstreams, ScriptedProvider TEST DOUBLE, Bearer session keys):
 * verifies auth, missing configuration, bounds, provider error mapping, the
 * shared C7 rate-limit bucket, and exactly-one audit per executed call.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProviderError } from "../src/agent/provider.ts";
import { ScriptedProvider } from "./helpers/fake-provider.ts";
import { startGatewayHarness } from "./helpers/gateway-harness.ts";

const LLM_CONFIG = {
  llm: {
    baseUrl: "https://llm.example.test/v1",
    apiKey: "gsk_test_fake_key_route_tests",
    model: "test-model",
    requestTimeoutMs: 5_000,
  },
};

async function chatJson(
  origin: string,
  key: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("POST /api/chat", () => {
  test("requires authentication (401 without credentials)", async () => {
    const harness = await startGatewayHarness();
    try {
      const { status, json } = await chatJson(harness.origin, null, { message: "hi" });
      assert.equal(status, 401);
      assert.equal(json.error, "unauthorized");
    } finally {
      await harness.close();
    }
  });

  test("answers 503 agent_not_configured when no LLM provider is set (gateway still serves everything else)", async () => {
    const harness = await startGatewayHarness();
    try {
      const { status, json } = await chatJson(harness.origin, harness.adminKey, { message: "hi" });
      assert.equal(status, 503);
      assert.equal(json.error, "agent_not_configured");
      assert.match(String(json.message), /GROQ_API_KEY/);

      // The rest of the gateway is unaffected: tools discovery still works.
      const tools = await fetch(`${harness.origin}/api/tools`, {
        headers: { authorization: `Bearer ${harness.adminKey}` },
      });
      assert.equal(tools.status, 200);
    } finally {
      await harness.close();
    }
  });

  test("happy path: 200 with grounded reply and gateway-computed tool outcomes", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "woocommerce_list_products", arguments: { page: 1 } }] },
      { content: "You have products in the catalog." },
    ]);
    const harness = await startGatewayHarness({ provider, config: LLM_CONFIG });
    try {
      const { status, json } = await chatJson(harness.origin, harness.adminKey, {
        message: "list products",
        history: [],
      });
      assert.equal(status, 200);
      assert.equal(json.reply, "You have products in the catalog.");
      assert.deepEqual(json.tool_calls, [{ name: "woocommerce_list_products", outcome: "success" }]);

      // Exactly one tool_call audit row for the executed call.
      const rows = harness.auditRepo.entries.filter((entry) => entry.action === "tool_call");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.outcome, "success");
    } finally {
      await harness.close();
    }
  });

  test("rejects oversized messages and non-string messages with 400", async () => {
    const provider = new ScriptedProvider([{ content: "unused" }]);
    const harness = await startGatewayHarness({ provider, config: LLM_CONFIG });
    try {
      const long = await chatJson(harness.origin, harness.adminKey, { message: "x".repeat(4_001) });
      assert.equal(long.status, 400);
      assert.equal(long.json.error, "too_long");

      const wrongType = await chatJson(harness.origin, harness.adminKey, { message: 42 });
      assert.equal(wrongType.status, 400);
      assert.equal(wrongType.json.error, "invalid_request");
    } finally {
      await harness.close();
    }
  });

  test("maps provider rate limits to 429 and timeouts to 504 with generic messages", async () => {
    {
      const harness = await startGatewayHarness({
        provider: new ScriptedProvider([{ error: new ProviderError("rate_limited", "rate limited", 429) }]),
        config: LLM_CONFIG,
      });
      try {
        const { status, json } = await chatJson(harness.origin, harness.adminKey, { message: "hi" });
        assert.equal(status, 429);
        assert.equal(json.error, "provider_rate_limited");
        assert.ok(!JSON.stringify(json).includes("llm.example.test"));
      } finally {
        await harness.close();
      }
    }
    {
      const harness = await startGatewayHarness({
        provider: new ScriptedProvider([{ error: new ProviderError("timeout", "took too long") }]),
        config: LLM_CONFIG,
      });
      try {
        const { status, json } = await chatJson(harness.origin, harness.adminKey, { message: "hi" });
        assert.equal(status, 504);
        assert.equal(json.error, "provider_timeout");
      } finally {
        await harness.close();
      }
    }
  });

  test("agent tool calls share the C7 per-key bucket with /mcp", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "woocommerce_list_products", arguments: {} }], content: "" },
      { content: "first" },
      { toolCalls: [{ name: "woocommerce_list_products", arguments: {} }], content: "" },
      { content: "second" },
    ]);
    const harness = await startGatewayHarness({
      provider,
      config: { ...LLM_CONFIG, rateLimitPerMinute: 1, rateLimitBurst: 1 },
    });
    try {
      const first = await chatJson(harness.origin, harness.adminKey, { message: "one" });
      assert.equal(first.status, 200);
      assert.deepEqual(first.json.tool_calls, [{ name: "woocommerce_list_products", outcome: "success" }]);

      // Bucket is now empty (burst 1, refill 1/min): the second chat's tool
      // call is denied by the SAME limiter that guards /mcp.
      const second = await chatJson(harness.origin, harness.adminKey, { message: "two" });
      assert.equal(second.status, 200);
      const calls = second.json.tool_calls as Array<{ outcome: string; error?: string }>;
      assert.equal(calls[0]?.outcome, "denied");
      assert.match(calls[0]?.error ?? "", /rate limit/);

      const denied = harness.auditRepo.entries.filter(
        (entry) => entry.action === "tool_call" && entry.errorCode === "rate_limited",
      );
      assert.equal(denied.length, 1);
    } finally {
      await harness.close();
    }
  });
});
