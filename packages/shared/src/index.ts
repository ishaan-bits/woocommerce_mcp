export const WOOCOMMERCE_TOOLS = [
  "list_products",
  "create_product",
  "list_orders",
  "get_order",
  "update_order_status",
] as const;

export type WooCommerceToolName = (typeof WOOCOMMERCE_TOOLS)[number];

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];

export type UpstreamId = "woocommerce" | "inventory" | "support";

export const UPSTREAM_IDS: readonly UpstreamId[] = [
  "woocommerce",
  "inventory",
  "support",
];

export type UserRole = "admin" | "reader";

export type ToolPermission = `tools:${string}`;

export interface ToolDescriptor {
  readonly upstreamId: UpstreamId;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface AggregatedTool extends ToolDescriptor {
  readonly qualifiedName: string;
  readonly enabled: boolean;
}

export interface UpstreamConfig {
  readonly id: UpstreamId;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
}

export interface ApiKeyPrincipal {
  readonly userId: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly allowedUpstreams: readonly UpstreamId[];
  readonly allowedTools: readonly string[];
  readonly keyId: string;
}

export type ToolCallOutcome = "success" | "error" | "timeout" | "denied";

export type AuditAction =
  | "tool_call"
  | "auth_failed"
  | "access_denied"
  | "key_created"
  | "key_revoked";

export interface AuditLogEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: AuditAction;
  /** Key UUID when known, non-secret key prefix for unknown-key attempts, null when no credential. */
  readonly keyId: string | null;
  readonly userId: string | null;
  readonly role: UserRole | null;
  readonly upstreamId: UpstreamId | null;
  readonly toolName: string | null;
  readonly qualifiedName: string | null;
  readonly outcome: ToolCallOutcome;
  readonly durationMs: number;
  readonly errorCode: string | null;
}

export interface UpstreamHealth {
  readonly id: UpstreamId;
  readonly enabled: boolean;
  readonly reachable: boolean;
  readonly lastCheckedAt: string;
  readonly lastErrorMessage: string | null;
}

export const DEFAULT_PORT = 8080;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const MCP_ENDPOINT_PATH = "/mcp";
export const API_PREFIX = "/api";
