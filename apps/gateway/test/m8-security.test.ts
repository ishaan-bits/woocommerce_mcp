import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { startGatewayHarness } from "./helpers/gateway-harness.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";
import { createUpstreamRegistry } from "../src/upstream-registry.ts";
import { createLogger } from "../src/logger.ts";
import { GatewayError } from "../src/errors.ts";
import type { FakeToolSpec } from "./helpers/fake-upstream.ts";

describe("M8: C7 per-key tool-call rate limit", () => {
  test("exceeding the burst is rejected with -32000 and audited as rate_limited", async () => {
    const harness = await startGatewayHarness({
      config: { rateLimitPerMinute: 60, rateLimitBurst: 2 },
    });
    try {
      await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      await assert.rejects(
        () => harness.client.callTool({ name: "woocommerce_list_products", arguments: {} }),
        (error: unknown) =>
          error instanceof McpError &&
          error.code === -32000 &&
          /Rate limit exceeded/.test(error.message),
      );
      const rateLimited = harness.auditRepo.entries.filter((entry) => entry.errorCode === "rate_limited");
      assert.equal(rateLimited.length, 1);
      assert.equal(rateLimited[0]?.action, "tool_call");
      assert.equal(rateLimited[0]?.outcome, "denied");
    } finally {
      await harness.close();
    }
  });

  test("the rate limit is per key: another principal is unaffected", async () => {
    const harness = await startGatewayHarness({
      config: { rateLimitPerMinute: 60, rateLimitBurst: 1 },
    });
    try {
      await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      await assert.rejects(
        () => harness.client.callTool({ name: "woocommerce_list_products", arguments: {} }),
        (error: unknown) => error instanceof McpError && /Rate limit exceeded/.test(error.message),
      );
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const reader = new Client({ name: "reader-probe", version: "0.0.0" });
      await reader.connect(
        new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${harness.readerKey}` } },
        }),
      );
      try {
        // Reader holds a read grant in the harness; a successful (or at least
        // non-throttled) call proves the limiter did not apply across keys.
        const readerResult = await reader.callTool({ name: "woocommerce_list_products", arguments: {} });
        assert.ok(readerResult.isError !== true, JSON.stringify(readerResult));
      } finally {
        await reader.close();
      }
    } finally {
      await harness.close();
    }
  });
});

describe("M8: B1/C7 login throttle", () => {
  async function postLogin(origin: string, key: string): Promise<Response> {
    return fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
  }

  test("repeated failed logins from one IP get 429 and an audited rate_limited row", async () => {
    const harness = await startGatewayHarness({
      config: { loginMaxFailuresPerIp: 2, loginFailureWindowMs: 300_000 },
    });
    try {
      const first = await postLogin(harness.origin, "umk_definitely_not_a_valid_key");
      assert.equal(first.status, 401);
      const second = await postLogin(harness.origin, "umk_definitely_not_a_valid_key");
      assert.equal(second.status, 401);
      const third = await postLogin(harness.origin, harness.adminKey);
      assert.equal(third.status, 429);
      const throttled = harness.auditRepo.entries.filter(
        (entry) => entry.action === "auth_failed" && entry.errorCode === "rate_limited",
      );
      assert.equal(throttled.length, 1);
    } finally {
      await harness.close();
    }
  });

  test("a successful login resets the failure bucket", async () => {
    const harness = await startGatewayHarness({
      config: { loginMaxFailuresPerIp: 2, loginFailureWindowMs: 300_000 },
    });
    try {
      assert.equal((await postLogin(harness.origin, "umk_bad_key_one")).status, 401);
      const ok = await postLogin(harness.origin, harness.adminKey);
      assert.equal(ok.status, 200);
      assert.equal((await postLogin(harness.origin, "umk_bad_key_two")).status, 401);
      assert.equal((await postLogin(harness.origin, "umk_bad_key_three")).status, 401);
      assert.equal((await postLogin(harness.origin, "umk_bad_key_four")).status, 429);
    } finally {
      await harness.close();
    }
  });
});

describe("M8: C7 JSON body size limit", () => {
  test("oversized request bodies are refused with 413", async () => {
    const harness = await startGatewayHarness({ config: { jsonBodyLimit: "1kb" } });
    try {
      const oversized = "x".repeat(4_096);
      const response = await fetch(`${harness.origin}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: oversized }),
      });
      assert.equal(response.status, 413);
      const body = (await response.json()) as { error?: { message?: string } };
      assert.match(body.error?.message ?? "", /too large/i);
    } finally {
      await harness.close();
    }
  });

  test("normal-sized bodies still work", async () => {
    const harness = await startGatewayHarness({ config: { jsonBodyLimit: "1kb" } });
    try {
      const response = await fetch(`${harness.origin}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: harness.adminKey }),
      });
      assert.equal(response.status, 200);
    } finally {
      await harness.close();
    }
  });
});

describe("M8: C7 per-upstream concurrency cap", () => {
  test("a second concurrent call to the same upstream fails with busy while the first completes", async () => {
    const spec: FakeToolSpec[] = [
      {
        name: "list_products",
        inputSchema: { type: "object", properties: {} },
        delayMs: 2_500,
      },
    ];
    const fake = await startFakeUpstream({ name: "slow-woo", tools: spec });
    const registry = createUpstreamRegistry({
      configs: [
        {
          id: "woocommerce",
          baseUrl: fake.mcpUrl,
          enabled: true,
          timeoutMs: 10_000,
          connectTimeoutMs: 2_000,
        },
      ],
      toolCacheTtlMs: 60_000,
      logger: createLogger({ level: "error", sink: { write: () => undefined } }),
      ssrf: { allowedPrivateHosts: ["*"] },
      maxConcurrentCallsPerUpstream: 1,
      callQueueWaitMs: 500,
    });
    try {
      await registry.listAggregatedTools();
      const results = await Promise.allSettled([
        registry.callTool("woocommerce_list_products", {}),
        registry.callTool("woocommerce_list_products", {}),
      ]);
      const fulfilled = results.filter((entry) => entry.status === "fulfilled");
      const rejected = results.filter((entry) => entry.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const error = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(error instanceof GatewayError && error.code === "busy", String(error));
    } finally {
      await registry.close();
      await fake.close();
    }
  });
});

describe("M8: C4 SSRF guard through the registry", () => {
  test("a metadata-service upstream is refused with blocked_private_address", async () => {
    const registry = createUpstreamRegistry({
      configs: [
        {
          id: "woocommerce",
          baseUrl: "http://169.254.169.254/latest/meta-data/mcp",
          enabled: true,
          timeoutMs: 1_000,
          connectTimeoutMs: 500,
        },
      ],
      toolCacheTtlMs: 60_000,
      logger: createLogger({ level: "error", sink: { write: () => undefined } }),
      ssrf: { allowedPrivateHosts: [] },
    });
    try {
      await assert.rejects(
        () => registry.callTool("woocommerce_list_products", {}),
        (error: unknown) =>
          error instanceof GatewayError && error.code === "blocked_private_address",
      );
      const health = registry.health().find((entry) => entry.id === "woocommerce");
      assert.match(health?.lastErrorMessage ?? "", /non-routable address/);
    } finally {
      await registry.close();
    }
  });

  test("the same upstream works when the operator allow-lists the host", async () => {
    const fake = await startFakeUpstream({
      name: "loopback-woo",
      tools: [{ name: "list_products", inputSchema: { type: "object", properties: {} } }],
    });
    const host = new URL(fake.mcpUrl).hostname;
    const registry = createUpstreamRegistry({
      configs: [
        {
          id: "woocommerce",
          baseUrl: fake.mcpUrl,
          enabled: true,
          timeoutMs: 5_000,
          connectTimeoutMs: 2_000,
        },
      ],
      toolCacheTtlMs: 60_000,
      logger: createLogger({ level: "error", sink: { write: () => undefined } }),
      ssrf: { allowedPrivateHosts: [host] },
    });
    try {
      const result = await registry.callTool("woocommerce_list_products", {});
      assert.ok(result.isError !== true);
    } finally {
      await registry.close();
      await fake.close();
    }
  });
});

describe("M8: B3 upstream error-message sanitization", () => {
  test("URLs and long messages from an upstream never reach the gateway client", async () => {
    const tools: FakeToolSpec[] = [
      {
        name: "list_products",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          throw new McpError(ErrorCode.InternalError, "boom at http://internal.corp/secret-endpoint?token=abc");
        },
      },
    ];
    const harness = await startGatewayHarness({ upstreams: [{ id: "woocommerce", tools }] });
    try {
      const result = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.equal(result.isError, true);
      const text = JSON.stringify(result);
      assert.ok(!text.includes("http://"), text);
      assert.ok(!text.includes("internal.corp"), text);
      assert.match(text, /returned an MCP error/);
    } finally {
      await harness.close();
    }
  });

  test("short safe upstream error messages are preserved for the operator", async () => {
    const tools: FakeToolSpec[] = [
      {
        name: "list_products",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          throw new McpError(ErrorCode.InternalError, "out of stock");
        },
      },
    ];
    const harness = await startGatewayHarness({ upstreams: [{ id: "woocommerce", tools }] });
    try {
      const result = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.equal(result.isError, true);
      const text = JSON.stringify(result);
      assert.match(text, /out of stock/);
    } finally {
      await harness.close();
    }
  });
});
