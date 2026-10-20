import type { AppConfig } from "../../src/config.ts";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    storeUrl: "https://store.test",
    consumerKey: "ck_test_key",
    consumerSecret: "cs_test_secret",
    host: "127.0.0.1",
    port: 8081,
    timeoutMs: 5_000,
    allowedHosts: [],
    logLevel: "error",
    ...overrides,
  };
}
