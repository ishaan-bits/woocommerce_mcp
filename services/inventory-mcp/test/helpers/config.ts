import type { AppConfig } from "../../src/config.ts";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8083,
    allowedHosts: [],
    logLevel: "error",
    ...overrides,
  };
}
