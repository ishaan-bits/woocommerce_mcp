import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  WOOCOMMERCE_TOOLS,
  type AggregatedTool,
  type ToolDescriptor,
  type UpstreamConfig,
  type UpstreamHealth,
} from "@mcp/shared";
import { ArgumentValidationError, GatewayError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { parseToolName, qualifyToolName } from "./routing.ts";
import { createSchemaValidator } from "./validation.ts";
import { VERSION } from "./version.ts";

export interface UpstreamRegistryOptions {
  configs: readonly UpstreamConfig[];
  toolCacheTtlMs: number;
  logger: Logger;
  now?: () => number;
  clientInfo?: { name: string; version: string };
}

export interface UpstreamRegistry {
  listAggregatedTools(): Promise<AggregatedTool[]>;
  callTool(qualifiedName: string, args: Record<string, unknown>): Promise<CallToolResult>;
  health(): UpstreamHealth[];
  refresh(): Promise<void>;
  close(): Promise<void>;
}

interface CachedTools {
  tools: ToolDescriptor[];
  fetchedAt: number;
}

interface UpstreamState {
  config: UpstreamConfig;
  client: Client | null;
  cached: CachedTools | null;
  reachable: boolean;
  lastCheckedAt: string;
  lastErrorMessage: string | null;
  connectPromise: Promise<void> | null;
}

function describeError(error: unknown): string {
  if (error instanceof GatewayError) {
    return error.message;
  }
  if (error instanceof McpError) {
    return `MCP error ${error.code}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown error";
}

export function createUpstreamRegistry(options: UpstreamRegistryOptions): UpstreamRegistry {
  const logger = options.logger;
  const now = options.now ?? Date.now;
  const clientInfo = options.clientInfo ?? { name: "urumi-mcp-gateway", version: VERSION };
  const validator = createSchemaValidator();

  const states: UpstreamState[] = options.configs.map((config) => ({
    config,
    client: null,
    cached: null,
    reachable: false,
    lastCheckedAt: new Date(now()).toISOString(),
    lastErrorMessage: null,
    connectPromise: null,
  }));

  function stateFor(upstreamId: string): UpstreamState | undefined {
    return states.find((state) => state.config.id === upstreamId);
  }

  function markReachable(state: UpstreamState): void {
    state.reachable = true;
    state.lastCheckedAt = new Date(now()).toISOString();
    state.lastErrorMessage = null;
  }

  function markUnreachable(state: UpstreamState, error: unknown): void {
    state.reachable = false;
    state.lastCheckedAt = new Date(now()).toISOString();
    state.lastErrorMessage = describeError(error);
  }

  function connectionError(state: UpstreamState, error: unknown): GatewayError {
    if (error instanceof GatewayError) {
      return error;
    }
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      return new GatewayError(
        "connect_timeout",
        `upstream '${state.config.id}' is unreachable (did not connect within ${state.config.connectTimeoutMs} ms)`,
        { upstreamId: state.config.id, cause: error },
      );
    }
    return new GatewayError(
      "connection",
      `upstream '${state.config.id}' is unreachable (could not connect)`,
      { upstreamId: state.config.id, cause: error },
    );
  }

  async function resetConnection(state: UpstreamState): Promise<void> {
    const client = state.client;
    state.client = null;
    if (client !== null) {
      try {
        await client.close();
      } catch {
        return;
      }
    }
  }

  async function ensureConnected(state: UpstreamState): Promise<void> {
    if (state.client !== null) {
      return;
    }
    if (state.connectPromise !== null) {
      await state.connectPromise;
      return;
    }
    const connectPromise = (async () => {
      const client = new Client(clientInfo);
      const transport = new StreamableHTTPClientTransport(new URL(state.config.baseUrl));
      try {
        await client.connect(transport, { timeout: state.config.connectTimeoutMs });
      } catch (error) {
        await client.close().catch(() => undefined);
        throw connectionError(state, error);
      }
      state.client = client;
      markReachable(state);
      logger.info("upstream_connected", { upstream_id: state.config.id });
    })();
    state.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      state.connectPromise = null;
    }
  }

  function checkWooCommerceContract(state: UpstreamState, tools: ToolDescriptor[]): void {
    if (state.config.id !== "woocommerce") {
      return;
    }
    const present = new Set(tools.map((tool) => tool.name));
    const missing = WOOCOMMERCE_TOOLS.filter((name) => !present.has(name));
    if (missing.length > 0) {
      logger.warn("woocommerce_tool_contract_drift", {
        upstream_id: "woocommerce",
        missing_tools: [...missing],
      });
    }
  }

  async function toolsFor(state: UpstreamState): Promise<ToolDescriptor[]> {
    const ttlExpired =
      state.cached !== null && now() - state.cached.fetchedAt >= options.toolCacheTtlMs;
    if (state.cached !== null && !ttlExpired) {
      return state.cached.tools;
    }
    try {
      await ensureConnected(state);
      const client = state.client;
      if (client === null) {
        throw new GatewayError(
          "connection",
          `upstream '${state.config.id}' is unreachable (could not connect)`,
          { upstreamId: state.config.id },
        );
      }
      const response = await client.listTools({}, { timeout: state.config.timeoutMs });
      const tools: ToolDescriptor[] = response.tools.map((tool) => ({
        upstreamId: state.config.id,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      state.cached = { tools, fetchedAt: now() };
      markReachable(state);
      checkWooCommerceContract(state, tools);
      logger.debug("upstream_tools_refreshed", {
        upstream_id: state.config.id,
        tools: tools.length,
      });
      return tools;
    } catch (error) {
      markUnreachable(state, error);
      await resetConnection(state);
      logger.warn("upstream_refresh_failed", {
        upstream_id: state.config.id,
        error: String(error),
      });
      if (state.cached !== null) {
        return state.cached.tools;
      }
      throw connectionError(state, error);
    }
  }

  return {
    async listAggregatedTools(): Promise<AggregatedTool[]> {
      const aggregated: AggregatedTool[] = [];
      for (const state of states) {
        if (!state.config.enabled) {
          continue;
        }
        let tools: ToolDescriptor[];
        try {
          tools = await toolsFor(state);
        } catch {
          continue;
        }
        for (const tool of tools) {
          aggregated.push({
            upstreamId: state.config.id,
            name: tool.name,
            qualifiedName: qualifyToolName(state.config.id, tool.name),
            description: tool.description,
            inputSchema: tool.inputSchema,
            enabled: true,
          });
        }
      }
      return aggregated;
    },

    async callTool(qualifiedName, args): Promise<CallToolResult> {
      const parsed = parseToolName(qualifiedName);
      if (parsed === null) {
        throw new GatewayError("unknown_tool", `Unknown tool: ${qualifiedName}`);
      }
      const state = stateFor(parsed.upstreamId);
      if (state === undefined) {
        throw new GatewayError("unknown_tool", `Unknown tool: ${qualifiedName}`);
      }
      if (!state.config.enabled) {
        throw new GatewayError("upstream_disabled", `Upstream '${state.config.id}' is disabled`, {
          upstreamId: state.config.id,
        });
      }

      const tools = await toolsFor(state);
      const tool = tools.find((candidate) => candidate.name === parsed.localName);
      if (tool === undefined) {
        throw new GatewayError("unknown_tool", `Unknown tool: ${qualifiedName}`);
      }

      const validation = validator.validate(qualifiedName, tool.inputSchema, args);
      if (!validation.ok) {
        throw new ArgumentValidationError(validation.issues);
      }

      await ensureConnected(state);
      const client = state.client;
      if (client === null) {
        throw new GatewayError("connection", `upstream '${state.config.id}' is unreachable (could not connect)`, {
          upstreamId: state.config.id,
        });
      }

      try {
        const result = await client.callTool(
          { name: parsed.localName, arguments: args },
          undefined,
          { timeout: state.config.timeoutMs },
        );
        return result as unknown as CallToolResult;
      } catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          throw new GatewayError(
            "timeout",
            `upstream '${state.config.id}' did not respond within ${state.config.timeoutMs} ms`,
            { upstreamId: state.config.id, cause: error },
          );
        }
        if (error instanceof McpError) {
          throw error;
        }
        markUnreachable(state, error);
        await resetConnection(state);
        throw new GatewayError(
          "connection",
          `upstream '${state.config.id}' is unreachable (the connection failed)`,
          { upstreamId: state.config.id, cause: error },
        );
      }
    },

    health(): UpstreamHealth[] {
      return states.map((state) => ({
        id: state.config.id,
        enabled: state.config.enabled,
        reachable: state.reachable,
        lastCheckedAt: state.lastCheckedAt,
        lastErrorMessage: state.lastErrorMessage,
      }));
    },

    async refresh(): Promise<void> {
      const tools = await this.listAggregatedTools();
      logger.info("tool_registry_refreshed", {
        upstreams: states.filter((state) => state.config.enabled).length,
        tools: tools.length,
      });
    },

    async close(): Promise<void> {
      for (const state of states) {
        await resetConnection(state);
      }
    },
  };
}
