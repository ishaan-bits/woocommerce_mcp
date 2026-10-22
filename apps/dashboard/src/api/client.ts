/**
 * The dashboard's API client (D6): every request goes to *relative* `/api`
 * paths with same-origin credentials, so the browser sends the HttpOnly
 * session cookie automatically after login. The API key is only ever sent in
 * the login request body — it is never stored, never placed in a URL, and
 * never read back (there is no code path that could read it).
 *
 * Pure module on purpose: `fetch` is injected so unit tests can exercise
 * success/error handling without a DOM or a network (see test/client.test.ts).
 */

/** Whitelisted extra fields a chat error body may carry (partial tool state). */
export interface ChatErrorDetails {
  tool_calls?: ChatToolCall[];
  rounds?: number;
  retry_after_seconds?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Whitelisted error-body extras (e.g. partial tool state from a failed chat turn). */
  readonly details: ChatErrorDetails | undefined;

  constructor(status: number, code: string, message?: string, details?: ChatErrorDetails) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 401: no (valid) session — show the login screen. */
export class UnauthorizedError extends ApiError {
  constructor(code = "unauthorized") {
    super(401, code, "Not signed in");
    this.name = "UnauthorizedError";
  }
}

/** 403: authenticated but not allowed (server-enforced, not hidden buttons). */
export class ForbiddenError extends ApiError {
  constructor(code = "forbidden") {
    super(403, code, "Not permitted");
    this.name = "ForbiddenError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MeResponse {
  user_id: string;
  display_name: string;
  role: "admin" | "reader";
  allowed_upstreams: string[];
  allowed_tools: string[];
  key_id: string;
}

export interface ToolView {
  qualified_name: string;
  name: string;
  upstream_id: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface UpstreamStatusView {
  id: string;
  /** Human name (admin-registered servers); fixed env servers use the id. */
  name?: string;
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  last_error: string | null;
  /** Display label for the woocommerce backing store: "mock" | "real" | null. */
  mode?: "mock" | "real" | null;
  /** "env" = deploy-time fixed server; "admin" = registered at runtime (M11). */
  source?: "env" | "admin";
  /** Admin-only: the stored upstream URL (C4 — members never receive it). */
  url?: string;
  /** Admin-only: whether a static credential is stored (the value never leaves the gateway). */
  has_credential?: boolean;
  credential_mode?: "bearer" | "header" | null;
}

export interface ToolsResponse {
  tools: ToolView[];
  upstreams: Array<{
    id: string;
    display_name?: string;
    enabled: boolean;
    reachable: boolean;
    last_error: string | null;
  }>;
}

export interface UpstreamsResponse {
  upstreams: UpstreamStatusView[];
}

export interface SettingsResponse {
  mcp_endpoint: string | null;
  mcp_path: string;
  transport: string;
  auth: string;
  session_header: string;
  chat_enabled: boolean;
}

/** Raw audit row as the gateway returns it (before view-model projection). */
export interface AuditEntryRaw {
  id: string;
  occurredAt: string;
  action: string;
  keyId?: string | null;
  userId?: string | null;
  role?: string | null;
  upstreamId?: string | null;
  toolName?: string | null;
  qualifiedName?: string | null;
  outcome: string;
  durationMs: number;
  errorCode?: string | null;
}

export interface AuditResponse {
  entries: AuditEntryRaw[];
}

export interface UserRecord {
  id: string;
  displayName: string;
  role: "admin" | "reader";
  // Mirrors the gateway's /api/users RESPONSE shape (camelCase) — request
  // bodies stay snake_case (see CreateUserInput/UpdateUserInput below). The
  // live API returns allowedUpstreams/allowedTools; reading snake_case here
  // produced undefined at runtime and crashed the members table.
  allowedUpstreams: string[];
  allowedTools: string[];
  createdAt: string;
  activeKeys: number;
  totalKeys: number;
}

export interface UsersResponse {
  users: UserRecord[];
}

export interface CreateUserInput {
  display_name: string;
  role: "admin" | "reader";
  allowed_upstreams?: string[];
  allowed_tools?: string[];
}

export interface UpdateUserInput {
  display_name?: string;
  role?: "admin" | "reader";
  allowed_upstreams?: string[];
  allowed_tools?: string[];
}

export interface KeyRecord {
  id: string;
  keyPrefix: string;
  userId: string;
  displayName: string;
  role: "admin" | "reader";
  createdAt: string;
  revokedAt: string | null;
}

export interface KeysResponse {
  keys: KeyRecord[];
}

export interface IssuedKey {
  id: string;
  user_id: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  /** Plaintext key — shown EXACTLY ONCE in the UI, never persisted. */
  key: string;
}

/** One of the caller's own keys (self-serve list; no other user's data). */
export interface OwnKeyRecord {
  id: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
}

export interface OwnKeysResponse {
  keys: OwnKeyRecord[];
}

export interface RevokeKeyResult {
  id: string;
  revoked_at: string | null;
  already_revoked: boolean;
}

export interface AuditFiltersInput {
  action?: string;
  outcome?: string;
  userId?: string;
  upstreamId?: string;
  tool?: string;
}

/** Milestone 9: gateway-computed tool outcomes — the model cannot override them. */
export interface ChatToolCall {
  name: string;
  outcome: "success" | "error" | "denied" | "invalid";
  error?: string;
}

export interface ChatResponse {
  reply: string;
  tool_calls: ChatToolCall[];
  rounds: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = "error";
  let message: string | undefined;
  let details: ChatErrorDetails | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown } & Record<string, unknown>;
    if (typeof body.error === "string" && body.error.length > 0) {
      code = body.error;
    }
    if (typeof body.message === "string" && body.message.length > 0) {
      message = body.message;
    }
    details = parseChatErrorDetails(body);
  } catch {
    // Non-JSON error body (proxy/gateway crash): keep the generic code.
  }
  if (response.status === 401) {
    return new UnauthorizedError(code);
  }
  if (response.status === 403) {
    return new ForbiddenError(code);
  }
  return new ApiError(response.status, code, message, details);
}

/**
 * Whitelist the chat error-body extras: gateway-computed partial tool state
 * and the provider's wait hint. Unknown/shaped-wrong fields are dropped.
 */
function parseChatErrorDetails(body: Record<string, unknown>): ChatErrorDetails | undefined {
  const details: ChatErrorDetails = {};
  if (Array.isArray(body.tool_calls)) {
    const calls: ChatToolCall[] = [];
    for (const entry of body.tool_calls) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.outcome !== "string") continue;
      calls.push({
        name: record.name,
        outcome: record.outcome as ChatToolCall["outcome"],
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      });
    }
    if (calls.length > 0) details.tool_calls = calls;
  }
  if (typeof body.rounds === "number" && Number.isFinite(body.rounds)) {
    details.rounds = body.rounds;
  }
  if (typeof body.retry_after_seconds === "number" && Number.isFinite(body.retry_after_seconds)) {
    details.retry_after_seconds = body.retry_after_seconds;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function createApiClient(fetchImpl: FetchLike = (...args) => fetch(...args)) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("/api") ? path : `/api${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // The gateway is unreachable (not started, network down, proxy broken).
      throw new ApiError(0, "gateway_unreachable", "Gateway unreachable");
    }
    if (!response.ok) {
      throw await parseError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  return {
    /** Exchange the pasted API key for the HttpOnly session cookie. */
    login(key: string): Promise<MeResponse> {
      return request<MeResponse>("POST", "/auth/login", { key });
    },
    logout(): Promise<{ ok: boolean }> {
      return request<{ ok: boolean }>("POST", "/auth/logout");
    },
    me(): Promise<MeResponse> {
      return request<MeResponse>("GET", "/me");
    },
    settings(): Promise<SettingsResponse> {
      return request<SettingsResponse>("GET", "/settings");
    },
    tools(): Promise<ToolsResponse> {
      return request<ToolsResponse>("GET", "/tools");
    },
    upstreams(): Promise<UpstreamsResponse> {
      return request<UpstreamsResponse>("GET", "/upstreams");
    },
    /** Server-enforced, admin-only; ids are validated against the registry upstream. */
    setUpstream(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean; changed: boolean }> {
      return request("POST", `/upstreams/${id}:${enabled ? "enable" : "disable"}`);
    },
    /**
     * M11/D34 admin CRUD. The credential is sent once, over TLS, to be
     * encrypted server-side; responses only ever carry `has_credential`.
     * `credential: null` on update clears the stored credential; omitting the
     * field keeps it unchanged.
     */
    createUpstream(input: {
      name: string;
      url: string;
      enabled?: boolean;
      credential?: { mode: "bearer" | "header"; value: string; header?: string };
    }): Promise<UpstreamStatusView> {
      return request("POST", "/upstreams", input);
    },
    updateUpstream(
      id: string,
      input: {
        name?: string;
        url?: string;
        enabled?: boolean;
        credential?: { mode: "bearer" | "header"; value: string; header?: string } | null;
      },
    ): Promise<UpstreamStatusView> {
      return request("PUT", `/upstreams/${encodeURIComponent(id)}`, input);
    },
    deleteUpstream(id: string): Promise<{ id: string; deleted: boolean }> {
      return request("DELETE", `/upstreams/${encodeURIComponent(id)}`);
    },
    /**
     * Bounded by the server (limit 1–100, keyset cursor) — never unbounded.
     * `filters` are the optional action/outcome/upstreamId/tool/userId query params.
     */
    audit(limit: number, before?: string, filters?: AuditFiltersInput): Promise<AuditResponse> {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined && before !== "") {
        params.set("before", before);
      }
      if (filters?.action !== undefined && filters.action !== "") {
        params.set("action", filters.action);
      }
      if (filters?.outcome !== undefined && filters.outcome !== "") {
        params.set("outcome", filters.outcome);
      }
      const userId = filters?.userId?.trim();
      if (userId !== undefined && userId !== "") {
        params.set("userId", userId);
      }
      if (filters?.upstreamId !== undefined && filters.upstreamId !== "") {
        params.set("upstreamId", filters.upstreamId);
      }
      const tool = filters?.tool?.trim();
      if (tool !== undefined && tool !== "") {
        params.set("tool", tool);
      }
      return request<AuditResponse>("GET", `/audit?${params.toString()}`);
    },
    users(): Promise<UsersResponse> {
      return request<UsersResponse>("GET", "/users");
    },
    createUser(input: CreateUserInput): Promise<UserRecord> {
      return request<UserRecord>("POST", "/users", input);
    },
    updateUser(id: string, patch: UpdateUserInput): Promise<UserRecord> {
      return request<UserRecord>("PATCH", `/users/${id}`, patch);
    },
    keys(): Promise<KeysResponse> {
      return request<KeysResponse>("GET", "/keys");
    },
    /** Returns the plaintext key EXACTLY ONCE — never persist or log it. */
    issueKey(userId: string): Promise<IssuedKey> {
      return request<IssuedKey>("POST", "/keys", { user_id: userId });
    },
    revokeKey(id: string): Promise<RevokeKeyResult> {
      return request<RevokeKeyResult>("POST", `/keys/${id}/revoke`);
    },
    /** Self-serve keys: the caller's OWN keys only (M1/X4). */
    myKeys(): Promise<OwnKeysResponse> {
      return request<OwnKeysResponse>("GET", "/me/keys");
    },
    /** Self-serve key issuance for the caller; plaintext returned EXACTLY ONCE. */
    issueMyKey(): Promise<IssuedKey> {
      return request<IssuedKey>("POST", "/me/keys");
    },
    /**
     * Milestone 9: chat with the server-side agent. The LLM key never touches
     * the browser; tool calls are executed by the gateway with *your* session
     * principal. 503 `agent_not_configured` means no provider is set up.
     */
    chat(message: string, history: ChatTurn[] = [], signal?: AbortSignal): Promise<ChatResponse> {
      const url = "/api/chat";
      const init: RequestInit = {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history }),
        ...(signal !== undefined ? { signal } : {}),
      };
      return (async (): Promise<ChatResponse> => {
        let response: Response;
        try {
          response = await fetchImpl(url, init);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw error;
          }
          throw new ApiError(0, "gateway_unreachable", "Gateway unreachable");
        }
        if (!response.ok) {
          throw await parseError(response);
        }
        return (await response.json()) as ChatResponse;
      })();
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
