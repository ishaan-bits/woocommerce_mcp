/**
 * Chat: the browser only ever talks to `POST /api/chat`. The LLM runs
 * server-side inside the gateway; tool calls execute through the gateway's
 * authorization + audit pipeline with *your* session principal. The history
 * lives in a module-level store so route changes do not wipe the thread.
 * Tool chips are gateway-computed outcomes — model prose cannot relabel a
 * failed call as a success.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { ApiClient } from "../api/client.ts";
import { toFailure } from "../state.ts";
import {
  EXAMPLE_PROMPTS,
  MAX_INPUT_CHARS,
  isAbortError,
  newMessageId,
  retryTarget,
  toolChipLabel,
  toolUpstream,
  type ChatMessage,
} from "../lib/chat.ts";
import {
  appendChatMessage,
  getChatError,
  getChatMessages,
  setChatError,
  subscribeChat,
} from "../lib/chatStore.ts";
import { upstreamLabel } from "../lib/permissions.ts";
import { Badge, Banner } from "../components/ui.tsx";

export function ChatPage({ api }: { api: ApiClient }) {
  const messages = useSyncExternalStore(subscribeChat, () => getChatMessages() as ChatMessage[], () => []);
  const storedError = useSyncExternalStore(subscribeChat, getChatError, () => null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentMissing, setAgentMissing] = useState(false);
  const [rounds, setRounds] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      // Unmount (route change / sign-out): abort any in-flight request.
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(
    async (text: string, history: Array<{ role: "user" | "assistant"; content: string }>) => {
      if (abortRef.current !== null) return; // in-flight guard
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setChatError(null);
      appendChatMessage({ id: newMessageId(), role: "user", content: text });
      try {
        const response = await api.chat(text, history, controller.signal);
        appendChatMessage({
          id: newMessageId(),
          role: "assistant",
          content: response.reply,
          toolCalls: response.tool_calls,
          rounds: response.rounds,
        });
        setRounds(response.rounds);
        setAgentMissing(false);
      } catch (caught) {
        if (isAbortError(caught)) return; // user pressed Stop — no fabrication
        const failure = toFailure(caught);
        if (failure.code === "agent_not_configured") {
          setAgentMissing(true);
        } else {
          setChatError(failure);
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [api],
  );

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const text = input.trim();
    if (text === "" || busy) return;
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    setInput("");
    void send(text, history);
  };

  const onRetry = (): void => {
    if (busy) return;
    const target = retryTarget(messages);
    if (target === null) return;
    void send(target.message, target.history);
  };

  const onExample = (prompt: string): void => {
    if (busy) return;
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    void send(prompt, history);
  };

  return (
    <section aria-labelledby="chat-heading">
      <div className="row space-between page-head">
        <h1 id="chat-heading">Chat</h1>
        {rounds !== null && <span className="muted small">last answer used {rounds} round{rounds === 1 ? "" : "s"}</span>}
      </div>

      {agentMissing && (
        <Banner tone="warn">
          <strong>Chat agent not configured.</strong> The gateway has no LLM provider set. Configure{" "}
          <code>GROQ_API_KEY</code> (or <code>LLM_BASE_URL</code> for a local OpenAI-compatible server) in the gateway
          environment and restart it — see <code>.env.example</code>. Nothing is generated in the meantime.
        </Banner>
      )}

      {storedError !== null && (
        <div className="banner banner-error" role="alert">
          <p>
            Chat failed: {storedError.message}
            {storedError.code === "provider_rate_limited" && " The provider is rate limiting requests — try again shortly."}
            {storedError.code === "provider_timeout" && " The provider timed out — try again."}
            {storedError.code === "provider_error" && " The provider could not complete the request — try again."}
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} disabled={busy}>
            Retry last message
          </button>
        </div>
      )}

      <div className="card chat-panel">
        <h2 className="sr-only">Conversation</h2>

        <div className="chat-messages" aria-live="polite" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              <p className="muted">
                Ask about your store — tool calls run through the gateway with your permissions and appear under each
                answer.
              </p>
              <div className="example-prompts">
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" className="btn btn-ghost btn-sm example-prompt" onClick={() => onExample(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`chat-msg chat-msg-${message.role}`}>
              <span className="chat-msg-role">{message.role === "user" ? "You" : "Assistant"}</span>
              <p>{message.content}</p>
              {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
                <ul className="chat-tools" aria-label="Tool calls">
                  {message.toolCalls.map((call, index) => {
                    const upstream = toolUpstream(call.name);
                    return (
                      <li key={`${message.id}-${index}`} className={`chat-chip chat-chip-${call.outcome}`} title={call.error}>
                        <code>{call.name}</code>
                        {upstream !== null && <span className="muted">{upstreamLabel(upstream)}</span>}
                        <Badge tone={call.outcome === "success" ? "success" : call.outcome === "denied" ? "warn" : "error"}>
                          {toolChipLabel(call.outcome)}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
              {message.role === "assistant" && message.rounds !== undefined && (
                <span className="muted small chat-rounds">{message.rounds} round{message.rounds === 1 ? "" : "s"}</span>
              )}
            </div>
          ))}
          {busy && (
            <div className="chat-status" role="status">
              <span className="spinner" aria-hidden="true" />
              <span className="muted">Thinking…</span>
            </div>
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
          {busy ? (
            <button type="button" className="btn btn-secondary" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={input.trim() === ""}>
              Send
            </button>
          )}
        </form>
        <p className="muted small">
          Tool calls execute inside the gateway with your role and grants, and each one is audited — the browser never
          routes tools itself. Plain text only; nothing is rendered as markdown.
        </p>
      </div>
    </section>
  );
}
