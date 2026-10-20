import { z } from "zod";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  UPSTREAM_IDS,
  type UpstreamConfig,
  type UpstreamId,
} from "@mcp/shared";
import { ConfigurationError } from "./errors.ts";
import type { LogLevel } from "./logger.ts";

export interface AppConfig {
  host: string;
  port: number;
  toolCacheTtlMs: number;
  logLevel: LogLevel;
  upstreams: UpstreamConfig[];
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_TOOL_CACHE_TTL_MS = 60_000;

export const UPSTREAM_URL_ENV: Record<UpstreamId, string> = {
  woocommerce: "WOOCOMMERCE_MCP_URL",
  inventory: "INVENTORY_MCP_URL",
  support: "SUPPORT_MCP_URL",
};

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const mcpUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const url = tryParseUrl(value);
      return url !== null && (url.protocol === "http:" || url.protocol === "https:");
    },
    "must be an absolute http:// or https:// URL",
  )
  .refine(
    (value) => {
      const url = tryParseUrl(value);
      return url === null || (url.username === "" && url.password === "");
    },
    "must not contain credentials",
  )
  .refine(
    (value) => {
      const url = tryParseUrl(value);
      return url === null || (url.search === "" && url.hash === "");
    },
    "must not contain a query string or fragment",
  );

const envSchema = z.object({
  host: z
    .string()
    .min(1, "GATEWAY_HOST must not be empty")
    .default(DEFAULT_HOST),
  port: z.coerce
    .number({ error: "GATEWAY_PORT must be an integer between 1 and 65535" })
    .int("GATEWAY_PORT must be an integer between 1 and 65535")
    .min(1, "GATEWAY_PORT must be an integer between 1 and 65535")
    .max(65535, "GATEWAY_PORT must be an integer between 1 and 65535")
    .default(DEFAULT_PORT),
  toolCacheTtlMs: z.coerce
    .number({ error: "TOOL_CACHE_TTL_MS must be an integer number of milliseconds" })
    .int("TOOL_CACHE_TTL_MS must be an integer number of milliseconds")
    .min(1_000, "TOOL_CACHE_TTL_MS must be between 1000 and 3600000")
    .max(3_600_000, "TOOL_CACHE_TTL_MS must be between 1000 and 3600000")
    .default(DEFAULT_TOOL_CACHE_TTL_MS),
  timeoutMs: z.coerce
    .number({ error: "UPSTREAM_TIMEOUT_MS must be an integer number of milliseconds" })
    .int("UPSTREAM_TIMEOUT_MS must be an integer number of milliseconds")
    .min(50, "UPSTREAM_TIMEOUT_MS must be between 50 and 300000")
    .max(300_000, "UPSTREAM_TIMEOUT_MS must be between 50 and 300000")
    .default(DEFAULT_UPSTREAM_TIMEOUT_MS),
  connectTimeoutMs: z.coerce
    .number({ error: "UPSTREAM_CONNECT_TIMEOUT_MS must be an integer number of milliseconds" })
    .int("UPSTREAM_CONNECT_TIMEOUT_MS must be an integer number of milliseconds")
    .min(50, "UPSTREAM_CONNECT_TIMEOUT_MS must be between 50 and 300000")
    .max(300_000, "UPSTREAM_CONNECT_TIMEOUT_MS must be between 50 and 300000")
    .default(DEFAULT_CONNECT_TIMEOUT_MS),
  logLevel: z
    .enum(["debug", "info", "warn", "error"], {
      error: "LOG_LEVEL must be one of debug, info, warn, error",
    })
    .default("info"),
});

function trimmed(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const withoutWhitespace = value.trim();
  return withoutWhitespace === "" ? undefined : withoutWhitespace;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse({
    host: trimmed(env, "GATEWAY_HOST"),
    port: trimmed(env, "GATEWAY_PORT"),
    toolCacheTtlMs: trimmed(env, "TOOL_CACHE_TTL_MS"),
    timeoutMs: trimmed(env, "UPSTREAM_TIMEOUT_MS"),
    connectTimeoutMs: trimmed(env, "UPSTREAM_CONNECT_TIMEOUT_MS"),
    logLevel: trimmed(env, "LOG_LEVEL"),
  });

  const issues: string[] = [];
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((issue) => issue.message));
  }

  const upstreams: UpstreamConfig[] = [];
  const data = parsed.success
    ? parsed.data
    : { host: DEFAULT_HOST, port: DEFAULT_PORT, toolCacheTtlMs: DEFAULT_TOOL_CACHE_TTL_MS, timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS, connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS, logLevel: "info" as LogLevel };

  for (const upstreamId of UPSTREAM_IDS) {
    const envKey = UPSTREAM_URL_ENV[upstreamId];
    const raw = trimmed(env, envKey);
    if (raw === undefined) {
      continue;
    }
    const result = mcpUrlSchema.safeParse(raw);
    if (!result.success) {
      issues.push(`${envKey} ${result.error.issues.map((issue) => issue.message).join("; ")}`);
      continue;
    }
    upstreams.push({
      id: upstreamId,
      baseUrl: result.data,
      enabled: true,
      timeoutMs: data.timeoutMs,
      connectTimeoutMs: data.connectTimeoutMs,
    });
  }

  if (issues.length === 0 && upstreams.length === 0) {
    issues.push(
      `at least one upstream URL is required: set ${UPSTREAM_IDS.map((id) => UPSTREAM_URL_ENV[id]).join(", ")}`,
    );
  }

  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }

  return {
    host: data.host,
    port: data.port,
    toolCacheTtlMs: data.toolCacheTtlMs,
    logLevel: data.logLevel,
    upstreams,
  };
}

export interface SafeConfigSummary {
  host: string;
  port: number;
  tool_cache_ttl_ms: number;
  log_level: LogLevel;
  upstreams: Array<{ id: UpstreamId; origin: string }>;
}

export function safeConfigSummary(config: AppConfig): SafeConfigSummary {
  return {
    host: config.host,
    port: config.port,
    tool_cache_ttl_ms: config.toolCacheTtlMs,
    log_level: config.logLevel,
    upstreams: config.upstreams.map((upstream) => ({
      id: upstream.id,
      origin: new URL(upstream.baseUrl).origin,
    })),
  };
}
