import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConfigurationError } from "../src/errors.ts";
import { loadConfig, safeConfigSummary, UPSTREAM_URL_ENV } from "../src/config.ts";

const VALID_URL = "http://127.0.0.1:8081/mcp";
const REQUIRED_ENV = {
  API_KEY_PEPPER: "test-pepper-0123456789abcdef",
  DATABASE_URL: "postgresql://mcp:pw@127.0.0.1:5432/mcp_gateway",
  UPSTREAM_ALLOWED_PRIVATE_HOSTS: "127.0.0.1",
};

describe("gateway configuration", () => {
  test("provides defaults with a single woocommerce upstream", () => {
    const config = loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.apiKeyPepper, REQUIRED_ENV.API_KEY_PEPPER);
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
    assert.deepEqual(config.upstreamAllowedPrivateHosts, ["127.0.0.1"]);
    assert.equal(config.rateLimitPerMinute, 60);
    assert.equal(config.rateLimitBurst, 20);
    assert.equal(config.loginMaxFailuresPerIp, 10);
    assert.equal(config.loginFailureWindowMs, 300_000);
    assert.equal(config.upstreamMaxConcurrentCalls, 8);
    assert.equal(config.upstreamMaxResponseBytes, 10 * 1024 * 1024);
    assert.equal(config.jsonBodyLimit, "100kb");
    assert.equal(config.trustProxy, 0);
  });

  test("requires at least one upstream URL", () => {
    assert.throws(() => loadConfig({}), /at least one upstream URL is required/);
    assert.throws(() => loadConfig({ WOOCOMMERCE_MCP_URL: "  " }), ConfigurationError);
  });

  test("reads all three upstream URLs from their env vars", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
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

  test("fails fast when API_KEY_PEPPER is missing or too short", () => {
    assert.throws(
      () => loadConfig({ ...REQUIRED_ENV, API_KEY_PEPPER: undefined, WOOCOMMERCE_MCP_URL: VALID_URL }),
      /API_KEY_PEPPER is required and must be at least 16 characters/,
    );
    assert.throws(
      () => loadConfig({ ...REQUIRED_ENV, API_KEY_PEPPER: "short", WOOCOMMERCE_MCP_URL: VALID_URL }),
      /API_KEY_PEPPER is required and must be at least 16 characters/,
    );
  });

  test("fails fast when DATABASE_URL is missing or not postgres", () => {
    assert.throws(
      () => loadConfig({ ...REQUIRED_ENV, DATABASE_URL: undefined, WOOCOMMERCE_MCP_URL: VALID_URL }),
      /DATABASE_URL is required/,
    );
    assert.throws(
      () => loadConfig({ ...REQUIRED_ENV, DATABASE_URL: "mysql://localhost/db", WOOCOMMERCE_MCP_URL: VALID_URL }),
      /DATABASE_URL must be a valid postgres:\/\/ or postgresql:\/\/ URL/,
    );
  });

  test("the safe summary exposes origins only, never paths or credentials", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
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

describe("gateway configuration (C4 SSRF + C7 limits)", () => {
  test("refuses a literal non-routable upstream address without an allow-list entry", () => {
    assert.throws(
      () =>
        loadConfig({
          ...REQUIRED_ENV,
          UPSTREAM_ALLOWED_PRIVATE_HOSTS: undefined,
          WOOCOMMERCE_MCP_URL: "http://169.254.169.254/latest/meta-data",
        }),
      /non-routable address '169\.254\.169\.254'/,
    );
  });

  test("permits a non-routable address that is explicitly allow-listed", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      UPSTREAM_ALLOWED_PRIVATE_HOSTS: "169.254.169.254",
      WOOCOMMERCE_MCP_URL: "http://169.254.169.254/mcp",
    });
    assert.equal(config.upstreams.length, 1);
    assert.deepEqual(config.upstreamAllowedPrivateHosts, ["169.254.169.254"]);
  });

  test("the '*' development escape hatch permits any upstream address", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      UPSTREAM_ALLOWED_PRIVATE_HOSTS: "*",
      WOOCOMMERCE_MCP_URL: "http://10.1.2.3:8081/mcp",
    });
    assert.equal(config.upstreams.length, 1);
    assert.deepEqual(config.upstreamAllowedPrivateHosts, ["*"]);
  });

  test("a public hostname is permitted with an empty allow-list", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      UPSTREAM_ALLOWED_PRIVATE_HOSTS: undefined,
      WOOCOMMERCE_MCP_URL: "https://store.example.com/mcp",
    });
    assert.equal(config.upstreams.length, 1);
    assert.deepEqual(config.upstreamAllowedPrivateHosts, []);
  });

  test("parses and validates the C7 limit envs", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      WOOCOMMERCE_MCP_URL: VALID_URL,
      RATE_LIMIT_CALLS_PER_MINUTE: "0",
      RATE_LIMIT_BURST: "5",
      LOGIN_MAX_FAILURES_PER_IP: "0",
      LOGIN_FAILURE_WINDOW_MS: "60000",
      UPSTREAM_MAX_CONCURRENT_CALLS: "2",
      UPSTREAM_MAX_RESPONSE_BYTES: "0",
      JSON_BODY_LIMIT: "10kb",
      TRUST_PROXY: "1",
    });
    assert.equal(config.rateLimitPerMinute, 0);
    assert.equal(config.rateLimitBurst, 5);
    assert.equal(config.loginMaxFailuresPerIp, 0);
    assert.equal(config.loginFailureWindowMs, 60_000);
    assert.equal(config.upstreamMaxConcurrentCalls, 2);
    assert.equal(config.upstreamMaxResponseBytes, 0);
    assert.equal(config.jsonBodyLimit, "10kb");
    assert.equal(config.trustProxy, 1);
  });

  test("rejects malformed C7 limit envs", () => {
    assert.throws(
      () => loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL, JSON_BODY_LIMIT: "lots" }),
      /JSON_BODY_LIMIT must look like/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...REQUIRED_ENV,
          WOOCOMMERCE_MCP_URL: VALID_URL,
          UPSTREAM_MAX_CONCURRENT_CALLS: "0",
        }),
      /UPSTREAM_MAX_CONCURRENT_CALLS must be between 1 and 100/,
    );
    assert.throws(
      () => loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL, TRUST_PROXY: "-1" }),
      /TRUST_PROXY must be between 0 and 10/,
    );
  });
});

describe("gateway configuration (Milestone 9 chat agent)", () => {
  test("agent is disabled when no LLM env is set — gateway still boots", () => {
    const config = loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL });
    assert.equal(config.llm, null);
  });

  test("GROQ_API_KEY enables the agent with Groq defaults", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      WOOCOMMERCE_MCP_URL: VALID_URL,
      GROQ_API_KEY: "gsk_test_fake_key_config_test",
    });
    assert.ok(config.llm !== null);
    assert.equal(config.llm?.baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(config.llm?.model, "llama-3.3-70b-versatile");
    assert.equal(config.llm?.apiKey, "gsk_test_fake_key_config_test");
    assert.equal(config.llm?.requestTimeoutMs, 45_000);
  });

  test("blank or whitespace GROQ_API_KEY (optional Secret key absent/empty) keeps the agent disabled", () => {
    // Mirrors the Kubernetes optional secretKeyRef: an unset env var, an empty
    // value, or pure whitespace must all behave as 'no provider configured'.
    for (const value of ["", "   ", "\t"]) {
      const config = loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL, GROQ_API_KEY: value });
      assert.equal(config.llm, null, `GROQ_API_KEY=${JSON.stringify(value)} must leave the agent disabled`);
    }
  });

  test("LLM_BASE_URL selects a local provider without any key", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      WOOCOMMERCE_MCP_URL: VALID_URL,
      LLM_BASE_URL: "http://127.0.0.1:11434/v1",
    });
    assert.ok(config.llm !== null);
    assert.equal(config.llm?.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(config.llm?.apiKey, "");
  });

  test("GROQ_MODEL and LLM_REQUEST_TIMEOUT_MS are honored; malformed base URL rejected", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      WOOCOMMERCE_MCP_URL: VALID_URL,
      GROQ_API_KEY: "gsk_test_fake_key",
      GROQ_MODEL: "test-model-1",
      LLM_REQUEST_TIMEOUT_MS: "12000",
    });
    assert.equal(config.llm?.model, "test-model-1");
    assert.equal(config.llm?.requestTimeoutMs, 12_000);

    assert.throws(
      () =>
        loadConfig({
          ...REQUIRED_ENV,
          WOOCOMMERCE_MCP_URL: VALID_URL,
          LLM_BASE_URL: "not a url",
        }),
      /LLM_BASE_URL must be an absolute/,
    );
  });

  test("safeConfigSummary reports presence only — never the key", () => {
    const key = "gsk_test_fake_key_summary";
    const config = loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL, GROQ_API_KEY: key });
    const summary = safeConfigSummary(config);
    assert.equal(summary.llm.configured, true);
    assert.equal(summary.llm.key_present, true);
    assert.equal(summary.llm.model, "llama-3.3-70b-versatile");
    assert.ok(!JSON.stringify(summary).includes(key));

    const off = safeConfigSummary(loadConfig({ ...REQUIRED_ENV, WOOCOMMERCE_MCP_URL: VALID_URL }));
    assert.equal(off.llm.configured, false);
    assert.equal(off.llm.key_present, false);
  });
});
