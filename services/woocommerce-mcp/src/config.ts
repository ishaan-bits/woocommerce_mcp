import { z } from "zod";
import { ConfigurationError } from "./errors.ts";
import type { LogLevel } from "./logger.ts";

export interface AppConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  host: string;
  port: number;
  timeoutMs: number;
  allowedHosts: string[];
  logLevel: LogLevel;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8081;
export const DEFAULT_TIMEOUT_MS = 10_000;

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const storeUrlSchema = z
  .string()
  .min(1, "WOOCOMMERCE_STORE_URL is required")
  .refine(
    (value) => {
      const url = tryParseUrl(value);
      return url !== null && (url.protocol === "http:" || url.protocol === "https:");
    },
    "WOOCOMMERCE_STORE_URL must be an absolute http:// or https:// URL",
  )
  .refine(
    (value) => {
      const url = tryParseUrl(value);
      return url === null || (url.username === "" && url.password === "");
    },
    "WOOCOMMERCE_STORE_URL must not contain credentials; use WOOCOMMERCE_CONSUMER_KEY and WOOCOMMERCE_CONSUMER_SECRET",
  )
  .refine(
    (value) => {
      const url = tryParseUrl(value);
      return url === null || (url.search === "" && url.hash === "");
    },
    "WOOCOMMERCE_STORE_URL must not contain a query string or fragment",
  );

const envSchema = z.object({
  storeUrl: storeUrlSchema,
  consumerKey: z
    .string({ error: "WOOCOMMERCE_CONSUMER_KEY is required" })
    .min(1, "WOOCOMMERCE_CONSUMER_KEY is required")
    .max(512, "WOOCOMMERCE_CONSUMER_KEY is unexpectedly long"),
  consumerSecret: z
    .string({ error: "WOOCOMMERCE_CONSUMER_SECRET is required" })
    .min(1, "WOOCOMMERCE_CONSUMER_SECRET is required")
    .max(512, "WOOCOMMERCE_CONSUMER_SECRET is unexpectedly long"),
  host: z
    .string()
    .min(1, "HOST must not be empty")
    .default(DEFAULT_HOST),
  port: z.coerce
    .number()
    .int("PORT must be an integer between 1 and 65535")
    .min(1, "PORT must be an integer between 1 and 65535")
    .max(65535, "PORT must be an integer between 1 and 65535")
    .default(DEFAULT_PORT),
  timeoutMs: z.coerce
    .number()
    .int("WOOCOMMERCE_TIMEOUT_MS must be an integer number of milliseconds")
    .min(50, "WOOCOMMERCE_TIMEOUT_MS must be between 50 and 300000")
    .max(300_000, "WOOCOMMERCE_TIMEOUT_MS must be between 50 and 300000")
    .default(DEFAULT_TIMEOUT_MS),
  logLevel: z
    .enum(["debug", "info", "warn", "error"], {
      error: "LOG_LEVEL must be one of debug, info, warn, error",
    })
    .default("info"),
  allowedHostsRaw: z.string().optional(),
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
    storeUrl: trimmed(env, "WOOCOMMERCE_STORE_URL") ?? "",
    consumerKey: trimmed(env, "WOOCOMMERCE_CONSUMER_KEY") ?? "",
    consumerSecret: trimmed(env, "WOOCOMMERCE_CONSUMER_SECRET") ?? "",
    host: trimmed(env, "HOST"),
    port: trimmed(env, "PORT"),
    timeoutMs: trimmed(env, "WOOCOMMERCE_TIMEOUT_MS"),
    logLevel: trimmed(env, "LOG_LEVEL"),
    allowedHostsRaw: trimmed(env, "MCP_ALLOWED_HOSTS"),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    throw new ConfigurationError(issues);
  }

  const storeUrl = parsed.data.storeUrl.replace(/\/+$/, "");
  const allowedHosts = (parsed.data.allowedHostsRaw ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return {
    storeUrl,
    consumerKey: parsed.data.consumerKey,
    consumerSecret: parsed.data.consumerSecret,
    host: parsed.data.host,
    port: parsed.data.port,
    timeoutMs: parsed.data.timeoutMs,
    allowedHosts,
    logLevel: parsed.data.logLevel,
  };
}

export interface SafeConfigSummary {
  store_origin: string;
  host: string;
  port: number;
  timeout_ms: number;
  log_level: LogLevel;
  allowed_hosts: string[];
}

export function safeConfigSummary(config: AppConfig): SafeConfigSummary {
  return {
    store_origin: new URL(config.storeUrl).origin,
    host: config.host,
    port: config.port,
    timeout_ms: config.timeoutMs,
    log_level: config.logLevel,
    allowed_hosts: config.allowedHosts,
  };
}
