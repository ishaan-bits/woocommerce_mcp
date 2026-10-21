import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConfigurationError } from "../src/errors.ts";
import { loadConfig, safeConfigSummary } from "../src/config.ts";

describe("support config", () => {
  test("defaults to port 8084 on localhost with info logging", () => {
    const config = loadConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8084);
    assert.equal(config.logLevel, "info");
    assert.deepEqual(config.allowedHosts, []);
  });

  test("reads HOST, PORT, LOG_LEVEL and MCP_ALLOWED_HOSTS from the environment", () => {
    const config = loadConfig({
      HOST: "0.0.0.0",
      PORT: "9100",
      LOG_LEVEL: "debug",
      MCP_ALLOWED_HOSTS: "gateway.local, dashboard.local",
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 9100);
    assert.equal(config.logLevel, "debug");
    assert.deepEqual(config.allowedHosts, ["gateway.local", "dashboard.local"]);
  });

  test("rejects invalid values with errors naming the variable", () => {
    assert.throws(() => loadConfig({ PORT: "0" }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /PORT/);
      return true;
    });
    assert.throws(() => loadConfig({ PORT: "nope" }), ConfigurationError);
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /LOG_LEVEL/);
      return true;
    });
    // Whitespace-only values are treated as unset and fall back to defaults
    // (same trimming helper as the WooCommerce server).
    assert.equal(loadConfig({ HOST: "   " }).host, "127.0.0.1");
  });

  test("safe summary never contains anything sensitive", () => {
    const summary = safeConfigSummary(loadConfig({ PORT: "8084" }));
    assert.deepEqual(Object.keys(summary).sort(), ["allowed_hosts", "host", "log_level", "port"]);
    assert.equal(summary.port, 8084);
  });
});
