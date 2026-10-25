/**
 * Phase One (2.9) — provider fallback chain: hosted primary → local Ollama
 * fallback. All deterministic (ScriptedProvider doubles; no network, no LLM
 * quota). Covers selection, reporting, bounded retries, duplicate-write
 * protection, and conversation preservation across a provider switch.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApiKeyPrincipal, AggregatedTool } from "@mcp/shared";
import { AgentTurnError, BothProvidersError, createChatAgent } from "../../src/agent/agent.ts";
import { ProviderError } from "../../src/agent/provider.ts";
import { ScriptedProvider } from "../helpers/fake-provider.ts";
import { FakeAuditRepository, FakeUpstreamRegistry } from "../helpers/fake-repos.ts";
import { createAuditWriter } from "../../src/audit.ts";
import { createLogger } from "../../src/logger.ts";

const ADMIN: ApiKeyPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "admin-demo",
  role: "admin",
  allowedUpstreams: ["woocommerce"],
  allowedTools: [
    "tools:woocommerce_list_products",
    "tools:woocommerce_create_product",
    "tools:woocommerce_list_orders",
    "tools:woocommerce_get_order",
  ],
  keyId: "key-admin",
};

const READER: ApiKeyPrincipal = {
  userId: "22222222-2222-4222-8222-222222222222",
  displayName: "reader-demo",
  role: "reader",
  allowedUpstreams: ["woocommerce"],
  allowedTools: ["tools:woocommerce_list_products"],
  keyId: "key-reader",
};

function tool(qualifiedName: string, write = false): AggregatedTool {
  return {
    upstreamId: "woocommerce",
    name: qualifiedName.slice("woocommerce_".length),
    qualifiedName,
    description: "test tool",
    inputSchema: { type: "object", properties: write ? { name: { type: "string" }, regular_price: { type: "string" } } : {} },
    enabled: true,
  } as AggregatedTool;
}

function registryWithTools() {
  const registry = new FakeUpstreamRegistry([
    {
      id: "woocommerce",
      enabled: true,
      reachable: true,
      tools: [tool("woocommerce_list_products"), tool("woocommerce_create_product", true)],
    },
  ]);
  registry.callToolImpl = async (name) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, via: name }) }],
  });
  return registry;
}

function buildAgent(opts: {
  primaryTurns: ConstructorParameters<typeof ScriptedProvider>[0];
  fallbackTurns?: ConstructorParameters<typeof ScriptedProvider>[0];
  principal?: ApiKeyPrincipal;
  registry?: FakeUpstreamRegistry;
  maxProviderAttempts?: number;
  maxToolRounds?: number;
}) {
  const registry = opts.registry ?? registryWithTools();
  const auditRepo = new FakeAuditRepository();
  const logger = createLogger({ level: "error", sink: { write: () => undefined } });
  const primary = new ScriptedProvider(opts.primaryTurns);
  primary.label = "hosted:test-model";
  const fallback =
    opts.fallbackTurns === undefined ? null : new ScriptedProvider(opts.fallbackTurns);
  if (fallback !== null) fallback.label = "ollama:qwen2.5:3b";
  const agent = createChatAgent({
    provider: primary,
    fallbackProvider: fallback,
    registry,
    logger,
    audit: createAuditWriter(auditRepo, logger),
    wait: async () => undefined,
    random: () => 0,
    maxProviderAttempts: opts.maxProviderAttempts ?? 1,
    ...(opts.maxToolRounds !== undefined ? { maxToolRounds: opts.maxToolRounds } : {}),
  });
  return { agent, primary, fallback, registry, auditRepo };
}

describe("chat provider fallback (hosted primary → local Ollama)", () => {
  test("primary success: fallback is never touched and is reported", async () => {
    const { agent, primary, fallback } = buildAgent({
      primaryTurns: [{ content: "primary answered" }],
      fallbackTurns: [{ content: "fallback answered" }],
    });
    const result = await agent.run({ message: "hi" }, ADMIN);
    assert.equal(result.reply, "primary answered");
    assert.equal(result.provider, "hosted:test-model");
    assert.equal(primary.requests.length, 1);
    assert.equal(fallback?.requests.length, 0, "fallback must not run when the primary succeeds");
  });

  test("HTTP 429 on the primary falls back to the local model and reports it", async () => {
    const { agent, fallback } = buildAgent({
      primaryTurns: [{ error: new ProviderError("rate_limited", "rate limited", 429, 30_000) }],
      fallbackTurns: [{ content: "local model answered" }],
    });
    const result = await agent.run({ message: "hi" }, ADMIN);
    assert.equal(result.reply, "local model answered");
    assert.equal(result.provider, "ollama:qwen2.5:3b");
    assert.equal(fallback?.requests.length, 1);
  });

  test("primary timeout falls back (documented policy: timeout may not be billed on a local model)", async () => {
    const { agent } = buildAgent({
      primaryTurns: [{ error: new ProviderError("timeout", "timed out") }],
      fallbackTurns: [{ content: "local answer" }],
    });
    const result = await agent.run({ message: "hi" }, ADMIN);
    assert.equal(result.reply, "local answer");
    assert.equal(result.provider, "ollama:qwen2.5:3b");
  });

  test("invalid primary key: falls back once and never re-asks the primary in the same turn", async () => {
    const { agent, primary, fallback } = buildAgent({
      primaryTurns: [
        { error: new ProviderError("rejected", "bad key", 401) },
        { content: "should never be consumed" },
      ],
      fallbackTurns: [
        { toolCalls: [{ name: "woocommerce_list_products", arguments: {} }] },
        { content: "local final" },
      ],
    });
    const result = await agent.run({ message: "list products" }, ADMIN);
    assert.equal(result.reply, "local final");
    assert.equal(result.provider, "ollama:qwen2.5:3b");
    assert.equal(primary.requests.length, 1, "an invalid key must not be retried");
    assert.equal(fallback?.requests.length, 2, "later rounds go straight to the fallback");
  });

  test("both providers fail: one honest error naming both, conversation preserved", async () => {
    const { agent, primary, fallback } = buildAgent({
      primaryTurns: [{ error: new ProviderError("rate_limited", "rate limited", 429) }],
      fallbackTurns: [{ error: new ProviderError("unavailable", "local down") }],
    });
    await assert.rejects(
      () => agent.run({ message: "hi", history: [{ role: "user", content: "earlier" }] }, ADMIN),
      (error: unknown) => {
        assert.ok(error instanceof BothProvidersError, "expected the combined error");
        assert.match(error.message, /primary provider failed \(rate_limited\)/);
        assert.match(error.message, /local fallback also failed \(unavailable\)/);
        return true;
      },
    );
    // The fallback saw the same conversation (history preserved across the switch).
    assert.equal(fallback?.requests[0]?.messages[1]?.content, "earlier");
  });

  test("malformed primary response falls back instead of failing the turn", async () => {
    const { agent } = buildAgent({
      primaryTurns: [{ error: new ProviderError("malformed", "not a chat completion") }],
      fallbackTurns: [{ content: "local answer" }],
    });
    const result = await agent.run({ message: "hi" }, ADMIN);
    assert.equal(result.reply, "local answer");
  });

  test("tool calls run exactly once across a primary failure + fallback (no duplicate writes)", async () => {
    const registry = registryWithTools();
    const { agent } = buildAgent({
      primaryTurns: [
        { toolCalls: [{ name: "woocommerce_create_product", arguments: { name: "X", regular_price: "1" } }] },
        { error: new ProviderError("rate_limited", "rate limited", 429) },
      ],
      fallbackTurns: [{ content: "created via local fallback summary" }],
      registry,
    });
    const result = await agent.run({ message: "create a product" }, ADMIN);
    assert.equal(result.reply, "created via local fallback summary");
    assert.equal(registry.calls.length, 1, "the write tool must execute exactly once (case G)");
    assert.equal(result.toolCalls[0]?.outcome, "success");
  });

  test("both providers fail AFTER tools ran: partial tool state survives, still exactly one execution", async () => {
    const registry = registryWithTools();
    const { agent } = buildAgent({
      primaryTurns: [
        { toolCalls: [{ name: "woocommerce_create_product", arguments: { name: "X", regular_price: "1" } }] },
        { error: new ProviderError("rate_limited", "rate limited", 429) },
      ],
      fallbackTurns: [{ error: new ProviderError("unavailable", "local down") }],
      registry,
    });
    await assert.rejects(
      () => agent.run({ message: "create a product" }, ADMIN),
      (error: unknown) => {
        // Partial-turn wrapper keeps the combined failure visible (the route
        // turns this into the distinct "both providers" user message).
        assert.ok(error instanceof AgentTurnError);
        assert.equal(error.bothProvidersFailed, true);
        assert.match(error.message, /primary provider failed/);
        assert.match(error.message, /local fallback also failed/);
        assert.equal(error.toolCalls.length, 1, "partial tool state survives");
        return true;
      },
    );
    assert.equal(registry.calls.length, 1, "no duplicate write on the failure path");
  });

  test("local-only mode: the fallback IS the provider when no primary is configured", async () => {
    const { agent, primary } = buildAgent({
      primaryTurns: [{ content: "local-only answer" }],
    });
    // local-only is modelled by passing the local provider as primary (app.ts
    // wires exactly that) — assert the label is reported honestly.
    primary.label = "ollama:qwen2.5:3b";
    const result = await agent.run({ message: "hi" }, ADMIN);
    assert.equal(result.reply, "local-only answer");
    assert.equal(result.provider, "ollama:qwen2.5:3b");
  });

  test("permission denial is unchanged with a fallback configured (no escalation)", async () => {
    const registry = registryWithTools();
    const { agent, fallback } = buildAgent({
      primaryTurns: [{ toolCalls: [{ name: "woocommerce_create_product", arguments: { name: "X", regular_price: "1" } }] }, { content: "done" }],
      fallbackTurns: [{ content: "unused" }],
      principal: READER,
      registry,
    });
    const result = await agent.run({ message: "create a product" }, READER);
    assert.equal(result.toolCalls[0]?.outcome, "denied");
    assert.equal(registry.calls.length, 0, "the write must never reach the upstream");
    assert.equal(fallback?.requests.length, 0, "a denial is not a provider failure");
    assert.equal(result.provider, "hosted:test-model");
  });

  test("upstream failure passes through as a tool error (not a provider failure)", async () => {
    const registry = registryWithTools();
    registry.callToolImpl = async () => ({
      content: [{ type: "text", text: "upstream 'woocommerce' is unreachable" }],
      isError: true,
    });
    const { agent, fallback } = buildAgent({
      primaryTurns: [{ toolCalls: [{ name: "woocommerce_list_products", arguments: {} }] }, { content: "reported" }],
      fallbackTurns: [{ content: "unused" }],
      registry,
    });
    const result = await agent.run({ message: "list products" }, ADMIN);
    assert.equal(result.toolCalls[0]?.outcome, "error");
    assert.equal(result.reply, "reported");
    assert.equal(fallback?.requests.length, 0, "tool errors must not trigger provider fallback");
  });

  test("repeated model tool requests stay bounded (no infinite loop)", async () => {
    const registry = registryWithTools();
    const { agent } = buildAgent({
      primaryTurns: Array.from({ length: 8 }, () => ({
        toolCalls: [{ name: "woocommerce_list_products", arguments: {} }],
      })),
      fallbackTurns: [],
      registry,
      maxToolRounds: 2,
    });
    const result = await agent.run({ message: "loop" }, ADMIN);
    assert.ok(result.reply.includes("tool-call limit"));
    assert.equal(result.rounds, 3, "bounded rounds (maxToolRounds + final)");
  });
});
