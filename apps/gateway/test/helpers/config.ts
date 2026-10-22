import type { AppConfig } from "../../src/config.ts";

export const TEST_PEPPER = "unit-test-pepper-not-a-secret";
export const TEST_DATABASE_URL = "postgresql://unit_test:no_real_connection@127.0.0.1:1/none";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    toolCacheTtlMs: 60_000,
    logLevel: "error",
    upstreams: [],
    apiKeyPepper: TEST_PEPPER,
    databaseUrl: TEST_DATABASE_URL,
    upstreamAllowedPrivateHosts: [],
    // Rate limiting is off by default in the harness so existing suites are
    // unaffected; dedicated tests enable it explicitly via overrides.
    rateLimitPerMinute: 0,
    rateLimitBurst: 20,
    loginMaxFailuresPerIp: 0,
    loginFailureWindowMs: 300_000,
    upstreamMaxConcurrentCalls: 8,
    upstreamMaxResponseBytes: 10 * 1024 * 1024,
    jsonBodyLimit: "100kb",
    trustProxy: 0,
    // Chat agent disabled by default so existing suites are unaffected;
    // agent/chat tests enable it explicitly via overrides.
    llm: null,
    // Store-mode label off by default; upstreams endpoint tests override it.
    woocommerceStoreMode: null,
    gatewayPublicUrl: null,
    ...overrides,
  };
}
