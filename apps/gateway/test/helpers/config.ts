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
    ...overrides,
  };
}
