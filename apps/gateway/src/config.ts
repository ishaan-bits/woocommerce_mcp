import { z } from "zod";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  UPSTREAM_IDS,
  type UpstreamConfig,
  type UpstreamId,
} from "@mcp/shared";
import type { SessionCookieSecureMode } from "./auth/sessions.ts";
import { ConfigurationError } from "./errors.ts";
import type { LogLevel } from "./logger.ts";
import { hostnameOf, isPrivateAddress } from "./ssrf.ts";
import { decodeCredentialKey } from "./upstream-credentials.ts";

export interface AppConfig {
  host: string;
  port: number;
  toolCacheTtlMs: number;
  logLevel: LogLevel;
  upstreams: UpstreamConfig[];
  /** Per-call timeout applied to every upstream (env UPSTREAM_TIMEOUT_MS). */
  upstreamTimeoutMs: number;
  /** Per-connect timeout applied to every upstream (UPSTREAM_CONNECT_TIMEOUT_MS). */
  upstreamConnectTimeoutMs: number;
  apiKeyPepper: string;
  databaseUrl: string;
  /** C4: hosts (or "*") permitted to resolve to non-routable addresses. */
  upstreamAllowedPrivateHosts: string[];
  /** C7: per-API-key tool-call rate limit; 0 disables. */
  rateLimitPerMinute: number;
  rateLimitBurst: number;
  /** C7: failed-login throttle per client IP; 0 disables. */
  loginMaxFailuresPerIp: number;
  loginFailureWindowMs: number;
  /** C7: per-upstream concurrent tool calls. */
  upstreamMaxConcurrentCalls: number;
  /** C4: per-response size cap; 0 disables. */
  upstreamMaxResponseBytes: number;
  /** C7: maximum accepted JSON request body (express limit syntax). */
  jsonBodyLimit: string;
  /** Trusted proxy hops for client-IP extraction (0 = trust none). */
  trustProxy: number;
  /**
   * Session-cookie Secure attribute policy (D33): "auto" sets Secure only
   * when the login request actually arrived over HTTPS (req.secure, which
   * follows TRUST_PROXY and X-Forwarded-Proto), "true"/"false" force it.
   * Auto keeps plain-HTTP local login working in WebKit/Safari, which
   * rejects Secure cookies set over http even on localhost.
   */
  sessionCookieSecure: SessionCookieSecureMode;
  /**
   * Milestone 9 chat agent (D29): null disables the agent entirely (the
   * gateway and dashboard work normally; POST /api/chat returns 503). The
   * API key is server-side only and never appears in logs or responses.
   */
  llm: LlmConfig | null;
  /**
   * Which backing store the WooCommerce upstream points at: "mock" (the
   * in-cluster demo store) or "real" (the in-cluster WordPress/WooCommerce
   * store). Purely a display label for the dashboard — the actual URL is
   * chosen at deploy time and never switches at runtime (no silent fallback).
   * null = not labelled.
   */
  woocommerceStoreMode: "mock" | "real" | null;
  /**
   * Externally reachable base URL of THIS gateway (e.g.
   * "https://mcp.example.com" or "http://127.0.0.1:30081"), used only to
   * render accurate MCP-client connection instructions in the dashboard.
   * null = unknown (local dev) — the Settings page then shows guidance
   * instead of inventing a URL.
   */
  gatewayPublicUrl: string | null;
  /**
   * Milestone 11: TLS requirement for ADMIN-REGISTERED dynamic upstream URLs
   * (D34). "allow-http" is the local default (in-cluster demos are plain
   * http behind ClusterIP); values-prod sets "https-only" so a production
   * admin cannot point the gateway at an unencrypted endpoint. Fixed
   * deploy-time upstream URLs are unaffected — they are operator config.
   */
  dynamicUpstreamTlsPolicy: "allow-http" | "https-only";
  /**
   * Milestone 11 (D34): AES-256-GCM key for dynamic upstream credentials.
   * null = no vault: creating a credential fails closed and the gateway
   * refuses to boot if encrypted rows already exist. Presence only is ever
   * logged; the key itself never appears anywhere.
   */
  dynamicUpstreamCredentialKey: Buffer | null;
}

/** Server-side LLM provider settings for the chat agent (Milestone 9). */
export interface LlmConfig {
  /** OpenAI-compatible chat-completions base URL (Groq by default). */
  baseUrl: string;
  /** Provider API key; empty string for local providers that need none (e.g. Ollama). */
  apiKey: string;
  model: string;
  /** Per provider-call timeout. */
  requestTimeoutMs: number;
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

export interface UpstreamUrlPolicy {
  /** C4: hosts (or "*") permitted to resolve to non-routable addresses. */
  allowedPrivateHosts: readonly string[];
  /** D34: when true only https:// URLs are accepted (dynamic TLS policy). */
  requireTls?: boolean;
}

export type UpstreamUrlValidation =
  | { ok: true; /** validated string exactly as supplied */ url: string; /** URL.toString() for storage */ normalized: string }
  | { ok: false; issues: string[] };

/**
 * One validation path for upstream MCP URLs, shared by deploy-time env
 * config (requireTls never set) and admin-registered dynamic servers
 * (requireTls from DYNAMIC_UPSTREAM_TLS_POLICY, D34): scheme, no embedded
 * credentials, no query/fragment, and the C4 non-routable-address guard.
 */
export function validateUpstreamUrlValue(raw: string, policy: UpstreamUrlPolicy): UpstreamUrlValidation {
  const schemaResult = mcpUrlSchema.safeParse(raw);
  if (!schemaResult.success) {
    return { ok: false, issues: schemaResult.error.issues.map((issue) => issue.message) };
  }
  const issues: string[] = [];
  const url = new URL(schemaResult.data);
  if (policy.requireTls === true && url.protocol !== "https:") {
    issues.push('must use https:// (DYNAMIC_UPSTREAM_TLS_POLICY is "https-only")');
  }
  const host = hostnameOf(url);
  const allowAll = policy.allowedPrivateHosts.includes("*");
  if (
    !allowAll &&
    isPrivateAddress(host) &&
    !policy.allowedPrivateHosts.some((entry) => entry.toLowerCase() === host.toLowerCase())
  ) {
    issues.push(
      `points at non-routable address '${host}'; allow-list it via UPSTREAM_ALLOWED_PRIVATE_HOSTS or use a routable address`,
    );
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, url: schemaResult.data, normalized: url.toString() };
}

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
  upstreamAllowedPrivateHosts: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  rateLimitPerMinute: z.coerce
    .number({ error: "RATE_LIMIT_CALLS_PER_MINUTE must be an integer number of calls" })
    .int("RATE_LIMIT_CALLS_PER_MINUTE must be an integer number of calls")
    .min(0, "RATE_LIMIT_CALLS_PER_MINUTE must be between 0 and 100000")
    .max(100_000, "RATE_LIMIT_CALLS_PER_MINUTE must be between 0 and 100000")
    .default(60),
  rateLimitBurst: z.coerce
    .number({ error: "RATE_LIMIT_BURST must be an integer number of calls" })
    .int("RATE_LIMIT_BURST must be an integer number of calls")
    .min(1, "RATE_LIMIT_BURST must be between 1 and 100000")
    .max(100_000, "RATE_LIMIT_BURST must be between 1 and 100000")
    .default(20),
  loginMaxFailuresPerIp: z.coerce
    .number({ error: "LOGIN_MAX_FAILURES_PER_IP must be an integer number of failures" })
    .int("LOGIN_MAX_FAILURES_PER_IP must be an integer number of failures")
    .min(0, "LOGIN_MAX_FAILURES_PER_IP must be between 0 and 1000")
    .max(1_000, "LOGIN_MAX_FAILURES_PER_IP must be between 0 and 1000")
    .default(10),
  loginFailureWindowMs: z.coerce
    .number({ error: "LOGIN_FAILURE_WINDOW_MS must be an integer number of milliseconds" })
    .int("LOGIN_FAILURE_WINDOW_MS must be an integer number of milliseconds")
    .min(1_000, "LOGIN_FAILURE_WINDOW_MS must be between 1000 and 3600000")
    .max(3_600_000, "LOGIN_FAILURE_WINDOW_MS must be between 1000 and 3600000")
    .default(300_000),
  upstreamMaxConcurrentCalls: z.coerce
    .number({ error: "UPSTREAM_MAX_CONCURRENT_CALLS must be an integer" })
    .int("UPSTREAM_MAX_CONCURRENT_CALLS must be an integer")
    .min(1, "UPSTREAM_MAX_CONCURRENT_CALLS must be between 1 and 100")
    .max(100, "UPSTREAM_MAX_CONCURRENT_CALLS must be between 1 and 100")
    .default(8),
  upstreamMaxResponseBytes: z.coerce
    .number({ error: "UPSTREAM_MAX_RESPONSE_BYTES must be an integer number of bytes" })
    .int("UPSTREAM_MAX_RESPONSE_BYTES must be an integer number of bytes")
    .min(0, "UPSTREAM_MAX_RESPONSE_BYTES must be between 0 and 1073741824")
    .max(1_073_741_824, "UPSTREAM_MAX_RESPONSE_BYTES must be between 0 and 1073741824")
    .default(10 * 1024 * 1024),
  jsonBodyLimit: z
    .string({ error: "JSON_BODY_LIMIT must look like 100kb or 1mb" })
    .regex(/^\d+(b|kb|mb|gb)?$/i, "JSON_BODY_LIMIT must look like 100kb or 1mb")
    .default("100kb"),
  trustProxy: z.coerce
    .number({ error: "TRUST_PROXY must be an integer number of hops" })
    .int("TRUST_PROXY must be an integer number of hops")
    .min(0, "TRUST_PROXY must be between 0 and 10")
    .max(10, "TRUST_PROXY must be between 0 and 10")
    .default(0),
  sessionCookieSecure: z
    .string({ error: 'SESSION_COOKIE_SECURE must be "auto", "true" or "false"' })
    .trim()
    .transform((value) => value.toLowerCase())
    .refine(
      (value) => value === "auto" || value === "true" || value === "false",
      'SESSION_COOKIE_SECURE must be "auto", "true" or "false"',
    )
    .default("auto"),
  // Milestone 9 chat agent (optional — absent config disables the agent).
  groqApiKey: z.string().optional(),
  groqModel: z
    .string({ error: "GROQ_MODEL must be a non-empty model name" })
    .min(1, "GROQ_MODEL must be a non-empty model name")
    .default("openai/gpt-oss-120b"),
  llmBaseUrl: z
    .string()
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      "LLM_BASE_URL must be an absolute http:// or https:// URL",
    )
    .optional(),
  llmRequestTimeoutMs: z.coerce
    .number({ error: "LLM_REQUEST_TIMEOUT_MS must be an integer number of milliseconds" })
    .int("LLM_REQUEST_TIMEOUT_MS must be an integer number of milliseconds")
    .min(1_000, "LLM_REQUEST_TIMEOUT_MS must be between 1000 and 120000")
    .max(120_000, "LLM_REQUEST_TIMEOUT_MS must be between 1000 and 120000")
    .default(45_000),
  woocommerceStoreMode: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || value === "mock" || value === "real",
      'WOOCOMMERCE_STORE_MODE must be "mock", "real", or empty',
    )
    .optional(),
  gatewayPublicUrl: z
    .string()
    .trim()
    .refine(
      (value) => {
        if (value === "") {
          return true;
        }
        try {
          const url = new URL(value);
          return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.pathname === "/" &&
            url.search === "" &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      },
      "GATEWAY_PUBLIC_URL must be an absolute http:// or https:// URL without path, query or fragment",
    )
    .optional(),
  // Milestone 11 (D34): TLS policy for admin-registered dynamic upstreams.
  dynamicUpstreamTlsPolicy: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .refine(
      (value) => value === "" || value === "allow-http" || value === "https-only",
      'DYNAMIC_UPSTREAM_TLS_POLICY must be "allow-http" or "https-only"',
    )
    .optional(),
  // Milestone 11 (D34): AES-256-GCM key for dynamic upstream credentials.
  // Validated (base64, 32 bytes) after parse so failures join the issue list.
  upstreamCredentialKey: z.string().optional(),
  apiKeyPepper: z
    .string({
      error: "API_KEY_PEPPER is required and must be at least 16 characters",
    })
    .min(16, "API_KEY_PEPPER is required and must be at least 16 characters"),
  databaseUrl: z
    .string({ error: "DATABASE_URL is required (postgres:// or postgresql:// URL)" })
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === "postgres:" || url.protocol === "postgresql:";
        } catch {
          return false;
        }
      },
      "DATABASE_URL must be a valid postgres:// or postgresql:// URL",
    ),
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
    upstreamAllowedPrivateHosts: trimmed(env, "UPSTREAM_ALLOWED_PRIVATE_HOSTS"),
    rateLimitPerMinute: trimmed(env, "RATE_LIMIT_CALLS_PER_MINUTE"),
    rateLimitBurst: trimmed(env, "RATE_LIMIT_BURST"),
    loginMaxFailuresPerIp: trimmed(env, "LOGIN_MAX_FAILURES_PER_IP"),
    loginFailureWindowMs: trimmed(env, "LOGIN_FAILURE_WINDOW_MS"),
    upstreamMaxConcurrentCalls: trimmed(env, "UPSTREAM_MAX_CONCURRENT_CALLS"),
    upstreamMaxResponseBytes: trimmed(env, "UPSTREAM_MAX_RESPONSE_BYTES"),
    jsonBodyLimit: trimmed(env, "JSON_BODY_LIMIT"),
    trustProxy: trimmed(env, "TRUST_PROXY"),
    sessionCookieSecure: trimmed(env, "SESSION_COOKIE_SECURE"),
    groqApiKey: env.GROQ_API_KEY === undefined ? undefined : env.GROQ_API_KEY.trim(),
    groqModel: trimmed(env, "GROQ_MODEL"),
    llmBaseUrl: trimmed(env, "LLM_BASE_URL"),
    llmRequestTimeoutMs: trimmed(env, "LLM_REQUEST_TIMEOUT_MS"),
    woocommerceStoreMode: trimmed(env, "WOOCOMMERCE_STORE_MODE"),
    gatewayPublicUrl: trimmed(env, "GATEWAY_PUBLIC_URL"),
    dynamicUpstreamTlsPolicy: trimmed(env, "DYNAMIC_UPSTREAM_TLS_POLICY"),
    upstreamCredentialKey:
      env.UPSTREAM_CREDENTIAL_KEY === undefined ? undefined : env.UPSTREAM_CREDENTIAL_KEY.trim(),
    apiKeyPepper: env.API_KEY_PEPPER,
    databaseUrl: env.DATABASE_URL,
  });

  const issues: string[] = [];
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((issue) => issue.message));
  }

  // Milestone 11 (D34): decode the credential-encryption key last so a bad
  // value joins every other configuration issue in one fail-fast report.
  let dynamicUpstreamCredentialKey: Buffer | null = null;
  if (parsed.success && parsed.data.upstreamCredentialKey !== undefined) {
    const decoded = decodeCredentialKey(parsed.data.upstreamCredentialKey);
    if (decoded.ok) {
      dynamicUpstreamCredentialKey = decoded.key;
    } else {
      issues.push(decoded.error);
    }
  }

  const upstreams: UpstreamConfig[] = [];
  const fallback = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    toolCacheTtlMs: DEFAULT_TOOL_CACHE_TTL_MS,
    timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    logLevel: "info" as LogLevel,
    apiKeyPepper: "",
    databaseUrl: "",
    upstreamAllowedPrivateHosts: [] as string[],
    rateLimitPerMinute: 60,
    rateLimitBurst: 20,
    loginMaxFailuresPerIp: 10,
    loginFailureWindowMs: 300_000,
    upstreamMaxConcurrentCalls: 8,
    upstreamMaxResponseBytes: 10 * 1024 * 1024,
    jsonBodyLimit: "100kb",
    trustProxy: 0,
    sessionCookieSecure: "auto" as SessionCookieSecureMode,
    groqModel: "openai/gpt-oss-120b",
    llmRequestTimeoutMs: 45_000,
    groqApiKey: undefined as string | undefined,
    llmBaseUrl: undefined as string | undefined,
    woocommerceStoreMode: undefined as string | undefined,
    gatewayPublicUrl: undefined as string | undefined,
    dynamicUpstreamTlsPolicy: "allow-http" as "allow-http" | "https-only",
    dynamicUpstreamCredentialKey: null as Buffer | null,
  };
  const data = parsed.success ? parsed.data : fallback;
  const allowedPrivateHosts = data.upstreamAllowedPrivateHosts;

  for (const upstreamId of UPSTREAM_IDS) {
    const envKey = UPSTREAM_URL_ENV[upstreamId];
    const raw = trimmed(env, envKey);
    if (raw === undefined) {
      continue;
    }
    const result = validateUpstreamUrlValue(raw, { allowedPrivateHosts });
    if (!result.ok) {
      issues.push(`${envKey} ${result.issues.join("; ")}`);
      continue;
    }
    upstreams.push({
      id: upstreamId,
      baseUrl: result.url,
      enabled: true,
      timeoutMs: data.timeoutMs,
      connectTimeoutMs: data.connectTimeoutMs,
    });
  }

  if (upstreams.length === 0) {
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
    upstreamTimeoutMs: data.timeoutMs,
    upstreamConnectTimeoutMs: data.connectTimeoutMs,
    apiKeyPepper: data.apiKeyPepper,
    databaseUrl: data.databaseUrl,
    upstreamAllowedPrivateHosts: allowedPrivateHosts,
    rateLimitPerMinute: data.rateLimitPerMinute,
    rateLimitBurst: data.rateLimitBurst,
    loginMaxFailuresPerIp: data.loginMaxFailuresPerIp,
    loginFailureWindowMs: data.loginFailureWindowMs,
    upstreamMaxConcurrentCalls: data.upstreamMaxConcurrentCalls,
    upstreamMaxResponseBytes: data.upstreamMaxResponseBytes,
    jsonBodyLimit: data.jsonBodyLimit,
    trustProxy: data.trustProxy,
    sessionCookieSecure: data.sessionCookieSecure,
    llm: buildLlmConfig(data.groqApiKey, data.llmBaseUrl, data.groqModel, data.llmRequestTimeoutMs),
    woocommerceStoreMode: data.woocommerceStoreMode === "mock" || data.woocommerceStoreMode === "real" ? data.woocommerceStoreMode : null,
    gatewayPublicUrl: data.gatewayPublicUrl === undefined || data.gatewayPublicUrl === "" ? null : data.gatewayPublicUrl,
    dynamicUpstreamTlsPolicy: data.dynamicUpstreamTlsPolicy === "https-only" ? "https-only" : "allow-http",
    dynamicUpstreamCredentialKey,
  };
}

/** Display label for the WooCommerce upstream's backing store (mock | real | null). */
export type WooStoreMode = "mock" | "real";

/** Default OpenAI-compatible endpoint: Groq's free-tier API (D29). */
export const DEFAULT_LLM_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * The chat agent is configured only when a provider credential or an explicit
 * base URL is present. With a key but no base URL we target Groq; a local
 * OpenAI-compatible server (Ollama) is selected via LLM_BASE_URL and needs no
 * key. Returns null (agent disabled) otherwise — the gateway still boots.
 */
function buildLlmConfig(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  model: string,
  requestTimeoutMs: number,
): LlmConfig | null {
  const key = apiKey ?? "";
  if (key === "" && baseUrl === undefined) {
    return null;
  }
  return {
    baseUrl: baseUrl ?? DEFAULT_LLM_BASE_URL,
    apiKey: key,
    model,
    requestTimeoutMs,
  };
}

export interface SafeConfigSummary {
  host: string;
  port: number;
  tool_cache_ttl_ms: number;
  log_level: LogLevel;
  upstreams: Array<{ id: string; origin: string }>;
  /** Milestone 9: presence only — the key itself is never logged (D29). */
  llm: { configured: boolean; model: string | null; key_present: boolean; base_url: string | null };
  woocommerce_store_mode: "mock" | "real" | null;
  /** D33: cookie Secure policy in effect (auto | true | false). */
  session_cookie_secure: SessionCookieSecureMode;
  /** D34: TLS policy applied to admin-registered upstream URLs. */
  dynamic_upstream_tls_policy: "allow-http" | "https-only";
  /** D34: presence only — the credential key itself is never logged. */
  upstream_credential_key_present: boolean;
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
    llm: {
      configured: config.llm !== null,
      model: config.llm?.model ?? null,
      key_present: (config.llm?.apiKey.length ?? 0) > 0,
      base_url: config.llm === null ? null : new URL(config.llm.baseUrl).origin,
    },
    woocommerce_store_mode: config.woocommerceStoreMode,
    session_cookie_secure: config.sessionCookieSecure,
    dynamic_upstream_tls_policy: config.dynamicUpstreamTlsPolicy,
    upstream_credential_key_present: config.dynamicUpstreamCredentialKey !== null,
  };
}
