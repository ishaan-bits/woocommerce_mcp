import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ArgumentValidationError, isGatewayError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { UpstreamRegistry } from "./upstream-registry.ts";
import { VERSION } from "./version.ts";

export interface GatewayMcpServerOptions {
  registry: UpstreamRegistry;
  logger: Logger;
  name?: string;
  version?: string;
}

export function createGatewayMcpServer(options: GatewayMcpServerOptions): Server {
  const { registry, logger } = options;
  const server = new Server(
    {
      name: options.name ?? "urumi-mcp-gateway",
      version: options.version ?? VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions:
        "This gateway aggregates MCP tools from several independent upstream MCP servers into one list. " +
        "Every tool name is qualified with its upstream id (for example woocommerce_list_products); " +
        "the prefix determines which upstream handles the call. " +
        "Invalid arguments are rejected before any upstream is contacted. " +
        "Upstream failures and timeouts are reported as tool results with isError set to true, and do not affect other upstreams' tools.",
    },
  );

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
    const baseFields = { tool_name: qualifiedName };

    try {
      const result = await registry.callTool(qualifiedName, args);
      logger.info("tool_call", {
        ...baseFields,
        outcome: result.isError === true ? "error" : "success",
        duration_ms: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      if (error instanceof ArgumentValidationError) {
        logger.warn("tool_call", {
          ...baseFields,
          outcome: "error",
          duration_ms: Date.now() - startedAt,
          error_code: "invalid_arguments",
        });
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      if (isGatewayError(error)) {
        if (error.code === "unknown_tool") {
          logger.warn("tool_call", {
            ...baseFields,
            outcome: "error",
            duration_ms: Date.now() - startedAt,
            error_code: "unknown_tool",
          });
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        const outcome = error.code === "timeout" || error.code === "connect_timeout" ? "timeout" : "error";
        logger.warn("tool_call", {
          ...baseFields,
          outcome,
          duration_ms: Date.now() - startedAt,
          error_code: error.code,
          upstream_id: error.upstreamId,
        });
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
      logger.error("tool_call", {
        ...baseFields,
        outcome: "error",
        duration_ms: Date.now() - startedAt,
        error: String(error),
      });
      throw error;
    }
  });

  return server;
}
