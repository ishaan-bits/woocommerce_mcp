/**
 * Milestone 9 chat: the browser only ever talks to `POST /api/chat`.
 * The LLM runs server-side inside the gateway; tool calls execute through
 * the gateway's own authorization + audit pipeline with *your* session
 * principal. The provider key never reaches this bundle, and the outcome
 * chips shown under each answer are gateway-computed — model text cannot
 * relabel a failed or denied call as a success.
 */
import { useState, type FormEvent } from "react";
import type { ApiClient, ChatToolCall } from "../api/client.ts";
import { toFailure } from "../state.ts";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
}

/** How many prior turns we send back (the server bounds this too). */
const HISTORY_TURNS = 10;
const MAX_INPUT_CHARS = 4_000;

let nextMessageId = 1;

function toolLabel(call: ChatToolCall): string {
  switch (call.outcome) {
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

export function ChatPage({ api }: { api: ApiClient }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [agentMissing, setAgentMissing] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = input.trim();
    if (text === "" || busy) {
      return;
    }
    setBusy(true);
    setError(null);

    const history = messages.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content }));
    const userMessage: ChatMessage = { id: nextMessageId++, role: "user", content: text };
    setMessages((current) => [...current, userMessage]);
    setInput("");

    try {
      const response = await api.chat(text, history);
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId++,
          role: "assistant",
          content: response.reply,
          toolCalls: response.tool_calls,
        },
      ]);
      setAgentMissing(false);
    } catch (caught) {
      const failure = toFailure(caught);
      if (failure.code === "agent_not_configured") {
        setAgentMissing(true);
      } else {
        setError(failure);
      }
      // The user's message stays in the transcript; nothing is fabricated.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="chat-heading">
      <h1 id="chat-heading">Chat</h1>

      {agentMissing && (
        <div className="banner banner-warn" role="status">
          <strong>Chat agent not configured.</strong> The gateway has no LLM provider set. Configure{" "}
          <code>GROQ_API_KEY</code> (or <code>LLM_BASE_URL</code> for a local OpenAI-compatible server) in the gateway
          environment and restart it — see <code>.env.example</code>. Nothing is generated in the meantime.
        </div>
      )}

      {error !== null && (
        <p className="banner banner-error" role="alert">
          Chat failed: {error.message}
        </p>
      )}

      <div className="card chat-panel">
        <h2 className="sr-only">Conversation</h2>

        <div className="chat-messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-empty">
              <p className="muted">
                Ask about your store — e.g. “list my products” or “how many orders are there?”. Tool calls run through
                the gateway with your permissions and appear under each answer.
              </p>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`chat-msg chat-msg-${message.role}`}>
              <span className="chat-msg-role">{message.role === "user" ? "You" : "Assistant"}</span>
              <p>{message.content}</p>
              {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
                <ul className="chat-tools" aria-label="Tool calls">
                  {message.toolCalls.map((call, index) => (
                    <li key={`${message.id}-${index}`} className={`chat-chip chat-chip-${call.outcome}`}>
                      <code>{call.name}</code> <span>{toolLabel(call)}</span>
                      {call.error !== undefined && <span className="chat-chip-error">{call.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {busy && (
            <p className="muted chat-loading" role="status">
              Thinking…
            </p>
          )}
        </div>

        <form className="chat-composer" onSubmit={onSubmit}>
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <input
            id="chat-input"
            type="text"
            value={input}
            maxLength={MAX_INPUT_CHARS}
            placeholder="Ask about products, orders, inventory…"
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
            aria-disabled={busy}
          />
          <button type="submit" disabled={busy || input.trim() === ""} aria-disabled={busy || input.trim() === ""}>
            {busy ? "Sending…" : "Send"}
          </button>
        </form>
        <p className="muted small">
          Tool calls execute inside the gateway with your role and grants, and each one is audited — the browser never
          routes tools itself.
        </p>
      </div>
    </section>
  );
}
