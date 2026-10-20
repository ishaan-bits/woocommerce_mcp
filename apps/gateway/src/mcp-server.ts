import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ApiKeyPrincipal } from "@mcp/shared";
import type { AuditWriter } from "./audit.ts";
import type { AuthzDecision } from "./auth/authorization.ts";
import { ArgumentValidationError, isGatewayError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { parseToolName } from "./routing.ts";
import type { UpstreamRegistry } from "./upstream-registry.ts";
import { VERSION } from "./version.ts";

/**
 * JSON-RPC server-error code (implementation-defined range -32000..-32099)
 * for authorization denials — C2 requires a structured MCP error, and MCP has
 * no dedicated "forbidden" code. HTTP-layer denials on /api use 403.
 */
export const PERMISSION_DENIED = -32003;

export interface GatewayMcpServerOptions {
  registry: UpstreamRegistry;
  logger: Logger;
  audit: AuditWriter;
  principal: ApiKeyPrincipal;
  authorize: (qualifiedName: string) => AuthzDecision;
  name?: string;
  version?: string;
}

export function createGatewayMcpServer(options: GatewayMcpServerOptions): Server {
  const { registry, logger, audit, principal, authorize } = options;
  const server = new Server(
    {
      name: options.name ?? "urumi-mcp-gateway",
      version: options.version ?? VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions:
        "This gateway aggregates MCP tools from several independent MCP upstream servers into one list. " +
        "Every tool name is qualified with its upstream id (for example woocommerce_list_products); " +
        "the prefix determines which upstream handles the call. " +
        "Invalid arguments are rejected before any upstream is contacted. " +
        "Calls your API key is not permitted to make fail with error code -32003. " +
        "Upstream failures and timeouts are reported as tool results with isError set to true, and do not affect other upstreams' tools.",
    },
  );

  // Discovery is authenticated but not per-tool authorized: the list shows
  // what exists; authorization is enforced (and audited) at execution time.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const aggregated = await registry.listAggregatedTools();
    const tools: Tool[] = aggregated.map((tool) => ({
      name: tool.qualifiedName,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Tool["inputSchema"],
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const qualifiedName = request.params.name;
    const args = request.params.arguments ?? {};
    const startedAt = Date.now();
    const parsed = parseToolName(qualifiedName);

    // C6 / §5.4: exactly one audit row per tools/call, written (awaited)
    // before the response leaves the handler.
    const record = async (
      outcome: "success" | "error" | "timeout" | "denied",
      errorCode: string | null,
    ): Promise<void> => {
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

    // C5 order: authorization (role → grants) runs before validation and routing.
    const decision = authorize(qualifiedName);
    if (!decision.allowed) {
      await record("denied", decision.errorCode);
      throw new McpError(
        PERMISSION_DENIED,
        decision.reason ?? `tool '${qualifiedName}' is not permitted for this principal`,
      );
    }

    try {
      const result = await registry.callTool(qualifiedName, args);
      await record(result.isError === true ? "error" : "success", null);
      return result;
    } catch (error) {
      if (error instanceof ArgumentValidationError) {
        await record("error", "invalid_arguments");
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      if (isGatewayError(error)) {
        if (error.code === "unknown_tool") {
          await record("error", "unknown_tool");
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        const outcome = error.code === "timeout" || error.code === "connect_timeout" ? "timeout" : "error";
        await record(outcome, error.code);
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
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
  });

  return server;
}
