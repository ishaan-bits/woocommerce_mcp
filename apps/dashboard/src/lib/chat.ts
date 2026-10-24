/**
 * Pure chat helpers (test/chat.test.ts): message id generation, the history
 * slice we send back, the retry target (last user turn), and tool-chip labels.
 * No DOM and no network, so all the non-trivial chat state logic is testable.
 */

import { parseToolName } from "./permissions.ts";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; outcome: string; error?: string }>;
  /** Assistant turns produced by a failed request can be retried. */
  rounds?: number;
}

/** How many prior turns we send back (the server bounds this too). */
export const HISTORY_TURNS = 10;
export const MAX_INPUT_CHARS = 4_000;

let nextId = 1;

/** Monotonic id generator for messages (module-scoped, collision-free). */
export function newMessageId(): number {
  return nextId++;
}

/** Reset the id counter — test-only helper, never called by the UI. */
export function resetMessageIds(): void {
  nextId = 1;
}

/** Send the most recent turns only, as `{role, content}` wire shape. */
export function historySlice(
  messages: readonly ChatMessage[],
  limit: number = HISTORY_TURNS,
): Array<{ role: "user" | "assistant"; content: string }> {
  const bounded = Math.max(0, Math.floor(limit));
  if (bounded === 0) {
    return [];
  }
  return messages.slice(-bounded).map((m) => ({ role: m.role, content: m.content }));
}

/**
 * The turn to retry after an error: the last user message. Retry re-sends
 * that message with the history that preceded it (so the model keeps context
 * but does not see the failed turn twice).
 */
export function retryTarget(
  messages: readonly ChatMessage[],
): { message: string; history: Array<{ role: "user" | "assistant"; content: string }> } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") {
      const preceding = messages.slice(0, i);
      return { message: message.content, history: historySlice(preceding) };
    }
  }
  return null;
}

export function toolChipLabel(outcome: string): string {
  switch (outcome) {
    case "success":
      return "✓";
    case "denied":
      return "denied";
    case "invalid":
      return "invalid";
    default:
      return "failed";
  }
}

/** Shown when a turn dies after tools already ran — never fabricates a reply. */
export const PARTIAL_TURN_TEXT =
  "This turn stopped before the model replied — the tool calls below already ran.";

/**
 * The assistant message that preserves partial tool state when a chat turn
 * fails partway through: the chips stay visible in the thread, and because
 * it is an *assistant* message the retry target still resolves to the failed
 * user turn (with history that precedes it — nothing is re-sent twice).
 */
export function partialTurnMessage(
  toolCalls: NonNullable<ChatMessage["toolCalls"]>,
  rounds?: number,
): ChatMessage {
  return {
    id: newMessageId(),
    role: "assistant",
    content: PARTIAL_TURN_TEXT,
    toolCalls,
    ...(rounds !== undefined ? { rounds } : {}),
  };
}

/** Upstream id parsed from a qualified tool name, or null when unparseable. */
export function toolUpstream(name: string): string | null {
  return parseToolName(name)?.upstreamId ?? null;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError"
  );
}

/** Four real example prompts (backend contract only — never fake data). */
export const EXAMPLE_PROMPTS: readonly string[] = [
  "List my products",
  "How many open orders are there?",
  "Check inventory levels for a product",
  "What is the status of the latest order?",
];

/**
 * Safe "markdown-lite" segmentation of an assistant message: fenced code
 * blocks and inline `code` spans become typed segments; everything else
 * stays plain text (rendered with white-space preservation). No HTML is ever
 * produced or injected — React renders each segment as elements, so tool
 * output or model text can never smuggle markup into the DOM.
 */
export type MessageSegment =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "codeblock"; value: string };

export function messageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fence = /```([\w-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (match.index > last) {
      pushInline(segments, content.slice(last, match.index));
    }
    segments.push({ type: "codeblock", value: match[2] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < content.length) {
    pushInline(segments, content.slice(last));
  }
  return segments.length > 0 ? segments : [{ type: "text", value: content }];
}

function pushInline(segments: MessageSegment[], chunk: string): void {
  const span = /`([^`\n]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = span.exec(chunk)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", value: chunk.slice(last, match.index) });
    }
    segments.push({ type: "code", value: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < chunk.length) {
    segments.push({ type: "text", value: chunk.slice(last) });
  }
}
