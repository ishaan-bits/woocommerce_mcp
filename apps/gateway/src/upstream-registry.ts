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
import { createSemaphore, type Semaphore } from "./limits.ts";
import type { Logger } from "./logger.ts";
import { parseToolName, qualifyToolName } from "./routing.ts";
import { assertUpstreamTargetAllowed, createCappedFetch, type SsrfPolicy } from "./ssrf.ts";
import { createSchemaValidator } from "./validation.ts";
import { credentialHeaders, type UpstreamCredential } from "./upstream-credentials.ts";
import { VERSION } from "./version.ts";

export interface UpstreamRegistryOptions {
  configs: readonly UpstreamConfig[];
  /**
   * Milestone 11 (D34): decrypted static credentials for admin-registered
   * servers, keyed by upstream id. Held in memory only — never logged,
   * never returned by an API. Fixed deploy-time servers have none.
   */
  credentials?: ReadonlyMap<string, UpstreamCredential>;
  toolCacheTtlMs: number;
  logger: Logger;
  /** C4: private-address guard for upstream targets. */
  ssrf: SsrfPolicy;
  /** C7: per-upstream concurrent tool-call cap (default 8). */
  maxConcurrentCallsPerUpstream?: number;
  /** C7: how long a call may wait for a concurrency slot before busy (default 2000). */
  callQueueWaitMs?: number;
  /** C4: per-response size cap in bytes; 0 disables (default 10 MiB). */
  maxResponseBytes?: number;
  now?: () => number;
  clientInfo?: { name: string; version: string };
}

export interface UpstreamRegistry {
  listAggregatedTools(): Promise<AggregatedTool[]>;
  callTool(qualifiedName: string, args: Record<string, unknown>): Promise<CallToolResult>;
  health(): UpstreamHealth[];
  /** Live ids (deploy-time + admin-registered) for tool-name parsing/grants. */
  upstreamIds(): readonly string[];
  /**
   * Milestone 11 (D34): register a new admin-added server or replace an
   * existing one (closing its connection). The credential is held in memory
   * for wire use only. Persistence is the caller's job.
   */
  addOrUpdateServer(config: UpstreamConfig, credential: UpstreamCredential | null): Promise<void>;
  /** Milestone 11: unregister a server (closes connections, drops tools). */
  removeServer(upstreamId: string): Promise<boolean>;
  /**
   * Dashboard toggle (D24): applies an enable/disable override live. Returns
   * false when the id is not part of this registry (not configured via env).
   * The override is process-local; persistence to PostgreSQL is the caller's
   * job (the gateway re-applies stored overrides at startup).
   */
  setEnabled(upstreamId: string, enabled: boolean): boolean;
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/**
 * D24 startup path: re-apply the overrides persisted by the dashboard so a
 * restart does not silently re-enable a disabled upstream. Unknown ids (rows
 * for upstreams whose env URL was removed) are skipped with a warning.
 * Returns the number of overrides applied.
 */
export function applyUpstreamOverrides(
  registry: UpstreamRegistry,
  overrides: Record<string, boolean>,
  logger: Logger,
): number {
  let applied = 0;
  for (const [upstreamId, enabled] of Object.entries(overrides)) {
    if (registry.setEnabled(upstreamId, enabled)) {
      applied += 1;
    } else {
      logger.warn("upstream_override_not_configured", { upstream_id: upstreamId, enabled });
    }
  }
  return applied;
}

interface CachedTools {
  tools: ToolDescriptor[];
  fetchedAt: number;
}

/** SDK transport options (requestInit carries the D34 credential headers). */
type TransportOptions = NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>;

interface UpstreamState {
  config: UpstreamConfig;
  /**
   * Milestone 11 (D34): decrypted static credential for admin-registered
   * servers (null for fixed servers or none configured). In-memory only.
   */
  credential: UpstreamCredential | null;
  /** Runtime toggle from the dashboard (D24); null = follow config.enabled. */
  enabledOverride: boolean | null;
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
  const maxConcurrentCalls = options.maxConcurrentCallsPerUpstream ?? 8;
  const callQueueWaitMs = options.callQueueWaitMs ?? 2_000;
  const maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;

  const states: UpstreamState[] = options.configs.map((config) => ({
    config,
    credential: options.credentials?.get(config.id) ?? null,
    enabledOverride: null,
    client: null,
    cached: null,
    reachable: false,
    lastCheckedAt: new Date(now()).toISOString(),
    lastErrorMessage: null,
    connectPromise: null,
  }));

  /** C7: bounded concurrency per upstream so bulk jobs cannot exhaust sockets. */
  const semaphores = new Map<string, Semaphore>(
    states.map((state) => [state.config.id, createSemaphore(maxConcurrentCalls)]),
  );

  function stateFor(upstreamId: string): UpstreamState | undefined {
    return states.find((state) => state.config.id === upstreamId);
  }

  /** Effective state: dashboard override (D24) wins over the env config. */
  function enabledOf(state: UpstreamState): boolean {
    return state.enabledOverride ?? state.config.enabled;
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

  /**
   * B3: upstreams are semi-trusted. Protocol-level error messages are logged
   * locally but replaced with a bounded, fixed-shape message before they can
   * reach the gateway's clients (a compromised upstream could otherwise echo
   * URLs, headers or stack text through the gateway).
   */
  function sanitizeUpstreamMcpError(error: McpError, upstreamId: string): GatewayError {
    const message = error.message ?? "";
    const unsafe =
      message.length > 200 || /https?:\/\/|[<>]|\r|\n/.test(message);
    const safe = unsafe
      ? `upstream '${upstreamId}' returned an MCP error ${error.code}`
      : `upstream '${upstreamId}' returned an MCP error ${error.code}: ${message}`;
    return new GatewayError("upstream_error", safe, { upstreamId, cause: error });
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
      const target = new URL(state.config.baseUrl);
      // C4: refuse non-routable targets unless the operator allow-listed them.
      await assertUpstreamTargetAllowed(target, options.ssrf);
      const client = new Client(clientInfo);
      const transportOptions: TransportOptions = {};
      if (maxResponseBytes > 0) {
        transportOptions.fetch = createCappedFetch(maxResponseBytes, state.config.id);
      }
      // D34: static credential for admin-registered servers — attached here,
      // and only here; it never travels in a URL, log line or response.
      if (state.credential !== null) {
        transportOptions.requestInit = { headers: credentialHeaders(state.credential) };
      }
      const transport = new StreamableHTTPClientTransport(target, transportOptions);
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
        if (!enabledOf(state)) {
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
      const parsed = parseToolName(qualifiedName, states.map((state) => state.config.id));
      if (parsed === null) {
        throw new GatewayError("unknown_tool", `Unknown tool: ${qualifiedName}`);
      }
      const state = stateFor(parsed.upstreamId);
      if (state === undefined) {
        throw new GatewayError("unknown_tool", `Unknown tool: ${qualifiedName}`);
      }
      if (!enabledOf(state)) {
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

      const semaphore = semaphores.get(state.config.id);
      const release =
        semaphore !== undefined
          ? await semaphore.acquire(Math.min(state.config.timeoutMs, callQueueWaitMs))
          : () => {};
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
          throw sanitizeUpstreamMcpError(error, state.config.id);
        }
        markUnreachable(state, error);
        await resetConnection(state);
        throw new GatewayError(
          "connection",
          `upstream '${state.config.id}' is unreachable (the connection failed)`,
          { upstreamId: state.config.id, cause: error },
        );
      } finally {
        release();
      }
    },

    health(): UpstreamHealth[] {
      return states.map((state) => ({
        id: state.config.id,
        enabled: enabledOf(state),
        reachable: state.reachable,
        lastCheckedAt: state.lastCheckedAt,
        lastErrorMessage: state.lastErrorMessage,
      }));
    },

    upstreamIds(): readonly string[] {
      return states.map((state) => state.config.id);
    },

    async addOrUpdateServer(config, credential): Promise<void> {
      const existing = stateFor(config.id);
      if (existing !== undefined) {
        // Close the old connection so URL/credential changes take effect on
        // the next call, and drop the tool cache (the server may differ).
        await resetConnection(existing);
        existing.config = config;
        existing.credential = credential;
        existing.enabledOverride = null;
        existing.cached = null;
        existing.reachable = false;
        existing.lastCheckedAt = new Date(now()).toISOString();
        existing.lastErrorMessage = null;
        if (!semaphores.has(config.id)) {
          semaphores.set(config.id, createSemaphore(maxConcurrentCalls));
        }
        logger.info("upstream_server_updated", { upstream_id: config.id });
        return;
      }
      states.push({
        config,
        credential,
        enabledOverride: null,
        client: null,
        cached: null,
        reachable: false,
        lastCheckedAt: new Date(now()).toISOString(),
        lastErrorMessage: null,
        connectPromise: null,
      });
      semaphores.set(config.id, createSemaphore(maxConcurrentCalls));
      logger.info("upstream_server_registered", { upstream_id: config.id });
    },

    async removeServer(upstreamId): Promise<boolean> {
      const index = states.findIndex((state) => state.config.id === upstreamId);
      if (index === -1) {
        return false;
      }
      const [state] = states.splice(index, 1);
      semaphores.delete(upstreamId);
      if (state !== undefined) {
        await resetConnection(state);
      }
      logger.info("upstream_server_removed", { upstream_id: upstreamId });
      return true;
    },

    setEnabled(upstreamId, enabled): boolean {
      const state = stateFor(upstreamId);
      if (state === undefined) {
        return false;
      }
      state.enabledOverride = enabled;
      logger.info("upstream_toggled", { upstream_id: upstreamId, enabled });
      return true;
    },

    async refresh(): Promise<void> {
      const tools = await this.listAggregatedTools();
      logger.info("tool_registry_refreshed", {
        upstreams: states.filter((state) => enabledOf(state)).length,
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
