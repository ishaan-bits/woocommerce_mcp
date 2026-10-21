import { z } from "zod";
import { ConfigurationError } from "./errors.ts";
import type { LogLevel } from "./logger.ts";

export interface AppConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  logLevel: LogLevel;
}

export const DEFAULT_HOST = "127.0.0.1";
/** Matches the INVENTORY_MCP_URL placeholder in .env.example. */
export const DEFAULT_PORT = 8083;

const envSchema = z.object({
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
    host: trimmed(env, "HOST"),
    port: trimmed(env, "PORT"),
    logLevel: trimmed(env, "LOG_LEVEL"),
    allowedHostsRaw: trimmed(env, "MCP_ALLOWED_HOSTS"),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    throw new ConfigurationError(issues);
  }

  const allowedHosts = (parsed.data.allowedHostsRaw ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return {
    host: parsed.data.host,
    port: parsed.data.port,
    allowedHosts,
    logLevel: parsed.data.logLevel,
  };
}

export interface SafeConfigSummary {
  host: string;
  port: number;
  log_level: LogLevel;
  allowed_hosts: string[];
}

export function safeConfigSummary(config: AppConfig): SafeConfigSummary {
  return {
    host: config.host,
    port: config.port,
    log_level: config.logLevel,
    allowed_hosts: config.allowedHosts,
  };
}
