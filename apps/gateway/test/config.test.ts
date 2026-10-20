import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConfigurationError } from "../src/errors.ts";
import { loadConfig, safeConfigSummary, UPSTREAM_URL_ENV } from "../src/config.ts";

const VALID_URL = "http://127.0.0.1:8081/mcp";

describe("gateway configuration", () => {
  test("provides defaults with a single woocommerce upstream", () => {
    const config = loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8080);
    assert.equal(config.toolCacheTtlMs, 60_000);
    assert.equal(config.logLevel, "info");
    assert.equal(config.upstreams.length, 1);
    assert.deepEqual(config.upstreams[0], {
      id: "woocommerce",
      baseUrl: VALID_URL,
      enabled: true,
      timeoutMs: 10_000,
      connectTimeoutMs: 3_000,
    });
  });

  test("requires at least one upstream URL", () => {
    assert.throws(() => loadConfig({}), /at least one upstream URL is required/);
    assert.throws(() => loadConfig({ WOOCOMMERCE_MCP_URL: "  " }), ConfigurationError);
  });

  test("reads all three upstream URLs from their env vars", () => {
    const config = loadConfig({
      WOOCOMMERCE_MCP_URL: VALID_URL,
      INVENTORY_MCP_URL: "http://127.0.0.1:8082/mcp",
      SUPPORT_MCP_URL: "http://127.0.0.1:8083/mcp",
    });
    assert.deepEqual(
      config.upstreams.map((upstream) => upstream.id),
      ["woocommerce", "inventory", "support"],
    );
    assert.equal(UPSTREAM_URL_ENV.inventory, "INVENTORY_MCP_URL");
  });

  test("rejects malformed upstream URLs", () => {
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: "ftp://store.example/mcp" }),
      /absolute http:\/\/ or https:\/\//,
    );
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: "http://user:secret@store.example/mcp" }),
      /must not contain credentials/,
    );
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: "http://store.example/mcp?token=abc" }),
      /query string/,
    );
  });

  test("bounds timeouts and the tool cache TTL", () => {
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL, UPSTREAM_TIMEOUT_MS: "10" }),
      /UPSTREAM_TIMEOUT_MS must be between 50 and 300000/,
    );
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL, UPSTREAM_TIMEOUT_MS: "400000" }),
      /UPSTREAM_TIMEOUT_MS must be between 50 and 300000/,
    );
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL, UPSTREAM_CONNECT_TIMEOUT_MS: "abc" }),
      /UPSTREAM_CONNECT_TIMEOUT_MS must be an integer/,
    );
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL, TOOL_CACHE_TTL_MS: "500" }),
      /TOOL_CACHE_TTL_MS must be between 1000 and 3600000/,
    );
  });

  test("bounds the gateway port and validates the log level", () => {
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL, GATEWAY_PORT: "70000" }),
      /GATEWAY_PORT must be an integer between 1 and 65535/,
    );
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_MCP_URL: VALID_URL, LOG_LEVEL: "verbose" }),
      /LOG_LEVEL must be one of debug, info, warn, error/,
    );
  });

  test("reports several configuration problems in one error", () => {
    try {
      loadConfig({
        WOOCOMMERCE_MCP_URL: "not-a-url",
        INVENTORY_MCP_URL: "http://user@host/mcp",
        GATEWAY_PORT: "0",
      });
      assert.fail("expected loadConfig to throw");
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /WOOCOMMERCE_MCP_URL/);
      assert.match(error.message, /INVENTORY_MCP_URL/);
      assert.match(error.message, /GATEWAY_PORT/);
    }
  });

  test("the safe summary exposes origins only, never paths or credentials", () => {
    const config = loadConfig({
      WOOCOMMERCE_MCP_URL: "https://store.example/mcp",
      INVENTORY_MCP_URL: "http://127.0.0.1:8082/mcp",
    });
    const summary = safeConfigSummary(config);
    assert.deepEqual(summary.upstreams, [
      { id: "woocommerce", origin: "https://store.example" },
      { id: "inventory", origin: "http://127.0.0.1:8082" },
    ]);
    assert.equal(summary.port, 8080);
    assert.equal(summary.log_level, "info");
  });
});
