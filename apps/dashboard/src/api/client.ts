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

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  last_error: string | null;
}

export interface ToolsResponse {
  tools: ToolView[];
  upstreams: Array<{ id: string; enabled: boolean; reachable: boolean; last_error: string | null }>;
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
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      code = body.error;
    }
  } catch {
    // Non-JSON error body (proxy/gateway crash): keep the generic code.
  }
  if (response.status === 401) {
    return new UnauthorizedError(code);
  }
  if (response.status === 403) {
    return new ForbiddenError(code);
  }
  return new ApiError(response.status, code);
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
    tools(): Promise<ToolsResponse> {
      return request<ToolsResponse>("GET", "/tools");
    },
    upstreams(): Promise<{ upstreams: UpstreamStatusView[] }> {
      return request<{ upstreams: UpstreamStatusView[] }>("GET", "/upstreams");
    },
    /** Server-enforced, admin-only; ids are validated against the registry upstream. */
    setUpstream(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean; changed: boolean }> {
      return request("POST", `/upstreams/${id}:${enabled ? "enable" : "disable"}`);
    },
    /** Bounded by the server (limit 1–100, keyset cursor) — never unbounded. */
    audit(limit: number, before?: string): Promise<AuditResponse> {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) {
        params.set("before", before);
      }
      return request<AuditResponse>("GET", `/audit?${params.toString()}`);
    },
    /**
     * Milestone 9: chat with the server-side agent. The LLM key never touches
     * the browser; tool calls are executed by the gateway with *your* session
     * principal. 503 `agent_not_configured` means no provider is set up.
     */
    chat(message: string, history: ChatTurn[] = []): Promise<ChatResponse> {
      return request<ChatResponse>("POST", "/chat", { message, history });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
