import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
  safeConfigSummary,
} from "../src/config.ts";
import { ConfigurationError } from "../src/errors.ts";

const baseEnv = {
  WOOCOMMERCE_STORE_URL: "https://shop.example.com",
  WOOCOMMERCE_CONSUMER_KEY: "ck_live_key",
  WOOCOMMERCE_CONSUMER_SECRET: "cs_live_secret",
};

describe("loadConfig", () => {
  test("applies defaults for optional settings", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.storeUrl, "https://shop.example.com");
    assert.equal(config.host, DEFAULT_HOST);
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(config.logLevel, "info");
    assert.deepEqual(config.allowedHosts, []);
  });

  test("strips trailing slashes from the store URL", () => {
    const config = loadConfig({ ...baseEnv, WOOCOMMERCE_STORE_URL: "https://shop.example.com///" });
    assert.equal(config.storeUrl, "https://shop.example.com");
  });

  test("coerces port, timeout and trims whitespace", () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: " 9090 ",
      WOOCOMMERCE_TIMEOUT_MS: "2500",
      LOG_LEVEL: "debug",
      HOST: "0.0.0.0",
      MCP_ALLOWED_HOSTS: " shop.example.com , localhost ",
    });
    assert.equal(config.port, 9090);
    assert.equal(config.timeoutMs, 2500);
    assert.equal(config.logLevel, "debug");
    assert.equal(config.host, "0.0.0.0");
    assert.deepEqual(config.allowedHosts, ["shop.example.com", "localhost"]);
  });

  test("rejects missing credentials with one issue per problem", () => {
    assert.throws(
      () => loadConfig({ WOOCOMMERCE_STORE_URL: "https://shop.example.com" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.issues.length, 2);
        assert.match(error.message, /WOOCOMMERCE_CONSUMER_KEY is required/);
        assert.match(error.message, /WOOCOMMERCE_CONSUMER_SECRET is required/);
        return true;
      },
    );
  });

  test("rejects store URLs that are not absolute http(s) without credentials, query or fragment", () => {
    const badUrls = [
      "shop.example.com",
      "ftp://shop.example.com",
      "https://user:pass@shop.example.com",
      "https://shop.example.com?consumer_key=ck",
      "https://shop.example.com#frag",
    ];
    for (const storeUrl of badUrls) {
      assert.throws(
        () => loadConfig({ ...baseEnv, WOOCOMMERCE_STORE_URL: storeUrl }),
        ConfigurationError,
        `expected ${storeUrl} to be rejected`,
      );
    }
  });

  test("rejects out-of-range port, timeout and unknown log levels", () => {
    for (const [key, value] of [
      ["PORT", "0"],
      ["PORT", "70000"],
      ["PORT", "abc"],
      ["WOOCOMMERCE_TIMEOUT_MS", "10"],
      ["WOOCOMMERCE_TIMEOUT_MS", "999999"],
      ["LOG_LEVEL", "verbose"],
    ] as const) {
      assert.throws(
        () => loadConfig({ ...baseEnv, [key]: value }),
        ConfigurationError,
        `expected ${key}=${value} to be rejected`,
      );
    }
  });

  test("accepts an http store URL but does not rewrite it", () => {
    const config = loadConfig({ ...baseEnv, WOOCOMMERCE_STORE_URL: "http://localhost:8080" });
    assert.equal(config.storeUrl, "http://localhost:8080");
  });
});

describe("safeConfigSummary", () => {
  test("never contains credentials", () => {
    const config = loadConfig(baseEnv);
    const summary = safeConfigSummary(config);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("ck_live_key"));
    assert.ok(!serialized.includes("cs_live_secret"));
    assert.ok(!("consumerKey" in summary));
    assert.ok(!("consumerSecret" in summary));
    assert.equal(summary.store_origin, "https://shop.example.com");
  });
});
