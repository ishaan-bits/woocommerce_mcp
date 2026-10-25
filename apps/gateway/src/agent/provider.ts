import type { LlmConfig } from "../config.ts";

/**
 * Chat provider adapter (Milestone 9, D29). A thin, testable interface over
 * an OpenAI-compatible chat-completions API — Groq's free tier by default
 * (`GROQ_API_KEY`), or any local OpenAI-compatible server via `LLM_BASE_URL`
 * (e.g. Ollama, key optional).
 *
 * Security notes:
 * - The API key is attached to the outbound Authorization header only. It is
 *   never included in thrown errors, returned content, or logs.
 * - Provider responses are treated as untrusted structured data: tool
 *   arguments must still parse as JSON and then pass the gateway's own
 *   schema + authorization checks (the agent loop never executes model
 *   output directly).
 * - All failures surface as ProviderError with a coarse `kind`; the HTTP
 *   status and body are logged by the caller at most, never shown to users.
 */

export type ProviderErrorKind =
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "rejected"
  | "malformed";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** Provider HTTP status if any — for server-side logs only. */
  readonly status: number | undefined;
  /**
   * Provider-requested wait before retrying (from `Retry-After` or reset
   * metadata), in milliseconds. Absent when the provider said nothing.
   * For server-side retry policy and user-facing "try again in ~N s"
   * hints — never a credential or provider body.
   */
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Largest provider-requested wait we will even consider honouring. */
export const MAX_PROVIDER_WAIT_MS = 3_000;

/**
 * Parse a provider's "how long until I will accept requests again" metadata
 * into milliseconds. Sources, in order:
 *   1. `Retry-After` — delta-seconds or an HTTP-date (RFC 7231)
 *   2. `x-ratelimit-reset-seconds` — plain seconds (fractional allowed)
 *   3. `x-ratelimit-reset` — unix-epoch seconds (> 1e9) or delta seconds
 * Anything unparseable is ignored: callers fall back to their own backoff.
 */
export function parseRetryAfterMs(headers: Pick<Headers, "get">, nowMs: number = Date.now()): number | undefined {
  const rawRetryAfter = headers.get("retry-after");
  if (rawRetryAfter !== null) {
    const trimmed = rawRetryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      return clampWaitMs(Number(trimmed) * 1_000);
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      return clampWaitMs(dateMs - nowMs);
    }
  }
  const rawResetSeconds = headers.get("x-ratelimit-reset-seconds");
  if (rawResetSeconds !== null && Number.isFinite(Number(rawResetSeconds))) {
    return clampWaitMs(Number(rawResetSeconds) * 1_000);
  }
  const rawReset = headers.get("x-ratelimit-reset");
  if (rawReset !== null && Number.isFinite(Number(rawReset))) {
    const value = Number(rawReset);
    const deltaMs = value > 1e9 ? value * 1_000 - nowMs : value * 1_000;
    return clampWaitMs(deltaMs);
  }
  return undefined;
}

function clampWaitMs(ms: number): number | undefined {
  // No upper clamp here on purpose: the caller must see the provider's real
  // window (e.g. "come back in 60 s") to decide NOT to retry before it —
  // only a sanity ceiling against nonsense values.
  if (!Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  return Math.min(Math.round(ms), 3_600_000);
}

export interface ProviderToolCall {
  id: string;
  name: string;
  /** Parsed arguments; malformed JSON is rejected before execution. */
  arguments: Record<string, unknown>;
  /** Raw argument string from the model (for diagnostics when parsing fails). */
  rawArguments: string;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  timeoutMs: number;
}

export interface ProviderResponse {
  content: string | null;
  toolCalls: ProviderToolCall[];
}

export interface ChatProvider {
  readonly model: string;
  /** Human-readable provider identity for reporting (e.g. "groq:openai/gpt-oss-120b"). */
  readonly label: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Groq (default) or other OpenAI-compatible chat-completions client.
 * `fetchImpl` is injectable for deterministic tests.
 */
export class OpenAiCompatProvider implements ChatProvider {
  readonly model: string;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: LlmConfig, fetchImpl: FetchLike = (...args) => fetch(...args), label?: string) {
    // Trailing-slash tolerant: `${base}/chat/completions`.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.label = label ?? config.model;
    this.fetchImpl = fetchImpl;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== "") {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: request.messages.map(toWireMessage),
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: "auto",
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ProviderError("timeout", "LLM provider request timed out");
      }
      // Coarse, fixed message: fetch errors can embed URLs (and whatever a
      // proxy echoes) — the cause stays in the exception chain for server
      // logs, never in user-visible text.
      throw new ProviderError("unavailable", "LLM provider unreachable");
    }

    if (response.status === 429) {
      throw new ProviderError(
        "rate_limited",
        "LLM provider rate limit hit",
        429,
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError("rejected", "LLM provider rejected the configured credentials", response.status);
    }
    if (!response.ok) {
      throw new ProviderError("unavailable", `LLM provider returned HTTP ${response.status}`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("malformed", "LLM provider returned a non-JSON body", response.status);
    }

    return parseChatCompletion(payload);
  }
}

/**
 * Outbound message wire shape. The internal parsed tool-call (`ProviderToolCall`)
 * must be re-encoded as the OpenAI chat-completions assistant entry —
 * `{id, type:"function", function:{name, arguments:"<json string>"}}` — before
 * it is sent back as conversation history. The internal shape (flat name/
 * parsed arguments) makes strict providers reject the second round with
 * HTTP 400. The provider's original id, function name and JSON-encoded
 * arguments are preserved verbatim (empty arguments serialize as "{}").
 */
function toWireMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.tool_calls === undefined) {
    return { ...message };
  }
  return {
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.rawArguments === "" ? "{}" : call.rawArguments,
      },
    })),
  };
}

interface RawToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** Tolerant parser: rejects only what cannot be safely interpreted. */
export function parseChatCompletion(payload: unknown): ProviderResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new ProviderError("malformed", "LLM provider response is not an object");
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError("malformed", "LLM provider response has no choices");
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    throw new ProviderError("malformed", "LLM provider response has no message");
  }
  const raw = message as { content?: unknown; tool_calls?: unknown };
  const content = typeof raw.content === "string" ? raw.content : null;

  const toolCalls: ProviderToolCall[] = [];
  if (raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls)) {
      throw new ProviderError("malformed", "LLM provider tool_calls is not an array");
    }
    for (const entry of raw.tool_calls as RawToolCall[]) {
      const fn = entry?.function;
      if (typeof entry?.id !== "string" || typeof fn?.name !== "string" || typeof fn?.arguments !== "string") {
        throw new ProviderError("malformed", "LLM provider tool_call has an unexpected shape");
      }
      // Malformed JSON arguments are kept as rawArguments; the agent loop
      // rejects them as invalid WITHOUT executing anything.
      let parsedArgs: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(fn.arguments === "" ? "{}" : fn.arguments);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          parsedArgs = {};
        } else {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        parsedArgs = {};
      }
      toolCalls.push({ id: entry.id, name: fn.name, arguments: parsedArgs, rawArguments: fn.arguments });
    }
  }

  return { content, toolCalls };
}

/** True when the model's argument string was not valid JSON. */
export function argumentsWereMalformed(call: ProviderToolCall): boolean {
  if (call.rawArguments === "" || call.rawArguments === "{}") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(call.rawArguments);
    return typeof parsed !== "object" || parsed === null || Array.isArray(parsed);
  } catch {
    return true;
  }
}
