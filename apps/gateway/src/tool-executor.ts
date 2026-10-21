import type { ApiKeyPrincipal } from "@mcp/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditWriter } from "./audit.ts";
import type { AuthzDecision } from "./auth/authorization.ts";
import { ArgumentValidationError, isGatewayError } from "./errors.ts";
import type { TokenBucketLimiter } from "./limits.ts";
import type { Logger } from "./logger.ts";
import { parseToolName } from "./routing.ts";
import type { UpstreamRegistry } from "./upstream-registry.ts";

/**
 * Shared tool-execution pipeline (Milestone 9 refactor of the /mcp
 * CallTool handler, D30). BOTH the MCP transport and the dashboard chat
 * agent call `executeToolCall` — so there is exactly one implementation of:
 *
 *   1. C7 rate limit (per API key, checked before authorization)
 *   2. C5 authorization (role ceiling → upstream grant → tool grant)
 *   3. registry call (schema validation before any upstream contact, SSRF
 *      guard, concurrency cap, response cap)
 *   4. exactly-one audit row per execution attempt (C6)
 *
 * The agent never routes around this path: the model only ever supplies a
 * tool name and JSON arguments, both validated here against the principal.
 */

export type ToolCallAuditOutcome = "success" | "error" | "timeout" | "denied";

/**
 * Transport-agnostic result of one execution attempt. The MCP transport maps
 * this to JSON-RPC errors/results; the agent maps it to tool messages and
 * server-computed chips. No branch fabricates a success.
 */
export type ToolCallOutcome =
  /** Tool executed upstream. `result.isError` may still be true (upstream failure). */
  | { kind: "result"; result: CallToolResult; auditOutcome: "success" | "error" | "timeout" }
  /** C7 bucket empty for this key. Audited as denied/rate_limited. */
  | { kind: "rate_limited" }
  /** C5/C2 denial. Audited as denied/<errorCode>. */
  | { kind: "denied"; errorCode: string; reason: string }
  /** Unknown tool or schema-invalid arguments — never reached an upstream. */
  | { kind: "invalid"; code: "unknown_tool" | "invalid_arguments"; message: string };

export interface ExecuteToolCallOptions {
  registry: UpstreamRegistry;
  logger: Logger;
  audit: AuditWriter;
  principal: ApiKeyPrincipal;
  /** Bound to this principal by the caller (agent and MCP both use authorizeToolCall). */
  authorize: (qualifiedName: string) => AuthzDecision;
  /** C7: shared per-key token bucket; null/undefined disables. */
  rateLimiter?: TokenBucketLimiter | null;
}

/**
 * Execute one tool call for `principal`. Writes exactly one audit row for
 * every attempt (success, upstream error, timeout, invalid arguments, unknown
 * tool, rate-limited or denied), awaited before returning — except truly
 * unexpected errors, which are audited as internal_error and rethrown.
 */
export async function executeToolCall(
  options: ExecuteToolCallOptions,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const { registry, logger, audit, principal, authorize, rateLimiter } = options;
  const startedAt = Date.now();
  const parsed = parseToolName(qualifiedName);

  // C6 / §5.4: exactly one audit row per execution attempt, written
  // (awaited) before the caller sees the outcome.
  const record = async (outcome: ToolCallAuditOutcome, errorCode: string | null): Promise<void> => {
    await audit.recordToolCall({
      principalKey: principal.keyId,
      userId: principal.userId,
      role: principal.role,
      upstreamId: parsed?.upstreamId ?? null,
      toolName: parsed?.localName ?? null,
      qualifiedName,
      outcome,
      durationMs: Date.now() - startedAt,
      errorCode,
    });
    const level = outcome === "success" ? "info" : "warn";
    logger[level]("tool_call", {
      tool_name: qualifiedName,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(errorCode !== null ? { error_code: errorCode } : {}),
      ...(parsed !== null ? { upstream_id: parsed.upstreamId } : {}),
      user_id: principal.userId,
    });
  };

  // C7: per-API-key throttle, checked before authorization so a flood of
  // denied probes is rate-limited too. Audited like any other denial.
  if (rateLimiter != null && !rateLimiter.tryTake(principal.keyId)) {
    await record("denied", "rate_limited");
    return { kind: "rate_limited" };
  }

  // C5 order: authorization (role → grants) runs before validation and routing.
  const decision = authorize(qualifiedName);
  if (!decision.allowed) {
    await record("denied", decision.errorCode);
    return {
      kind: "denied",
      errorCode: decision.errorCode ?? "forbidden",
      reason: decision.reason ?? `tool '${qualifiedName}' is not permitted for this principal`,
    };
  }

  try {
    const result = await registry.callTool(qualifiedName, args);
    const auditOutcome = result.isError === true ? "error" : "success";
    await record(auditOutcome, null);
    return { kind: "result", result, auditOutcome };
  } catch (error) {
    if (error instanceof ArgumentValidationError) {
      await record("error", "invalid_arguments");
      return { kind: "invalid", code: "invalid_arguments", message: error.message };
    }
    if (isGatewayError(error)) {
      if (error.code === "unknown_tool") {
        await record("error", "unknown_tool");
        return { kind: "invalid", code: "unknown_tool", message: error.message };
      }
      const timeout = error.code === "timeout" || error.code === "connect_timeout";
      await record(timeout ? "timeout" : "error", error.code);
      return {
        kind: "result",
        result: { content: [{ type: "text", text: error.message }], isError: true },
        auditOutcome: timeout ? "timeout" : "error",
      };
    }
    await record("error", "internal_error");
    logger.error("tool_call", {
      tool_name: qualifiedName,
      outcome: "error",
      duration_ms: Date.now() - startedAt,
      error: String(error),
    });
    throw error;
  }
}
