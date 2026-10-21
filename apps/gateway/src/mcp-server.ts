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
import type { TokenBucketLimiter } from "./limits.ts";
import type { Logger } from "./logger.ts";
import { executeToolCall } from "./tool-executor.ts";
import type { UpstreamRegistry } from "./upstream-registry.ts";
import { VERSION } from "./version.ts";

/**
 * JSON-RPC server-error code (implementation-defined range -32000..-32099)
 * for authorization denials — C2 requires a structured MCP error, and MCP has
 * no dedicated "forbidden" code. HTTP-layer denials on /api use 403.
 */
export const PERMISSION_DENIED = -32003;

/** Distinct from PERMISSION_DENIED so clients can tell throttling from denial. */
export const RATE_LIMIT_EXCEEDED = -32000;

export interface GatewayMcpServerOptions {
  registry: UpstreamRegistry;
  logger: Logger;
  audit: AuditWriter;
  principal: ApiKeyPrincipal;
  authorize: (qualifiedName: string) => AuthzDecision;
  /** C7: per-key token bucket; null/undefined disables the limit. */
  rateLimiter?: TokenBucketLimiter | null;
  name?: string;
  version?: string;
}

export function createGatewayMcpServer(options: GatewayMcpServerOptions): Server {
  const { registry, logger, audit, principal, authorize, rateLimiter } = options;
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

  // Execution is the shared pipeline (D30) — the dashboard agent runs the
  // same function with the same principal, so /mcp behavior is unchanged.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const qualifiedName = request.params.name;
    const args = request.params.arguments ?? {};
    const outcome = await executeToolCall(
      { registry, logger, audit, principal, authorize, rateLimiter },
      qualifiedName,
      args,
    );
    switch (outcome.kind) {
      case "result":
        return outcome.result;
      case "rate_limited":
        throw new McpError(RATE_LIMIT_EXCEEDED, "Rate limit exceeded for this API key; retry shortly");
      case "denied":
        throw new McpError(PERMISSION_DENIED, outcome.reason);
      case "invalid":
        throw new McpError(ErrorCode.InvalidParams, outcome.message);
    }
  });

  return server;
}
