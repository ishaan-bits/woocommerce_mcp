/**
 * Chat foundation (M4 scope): the gateway has **no** agent/LLM endpoint yet —
 * that is Milestone 9 (per the roadmap), and this project never fabricates
 * responses. The composer is intentionally disabled and every capability that
 * depends on the future agent is labelled as deferred.
 *
 * What stays true here: no paid LLM, no key in the browser, and when the
 * agent arrives its tool calls will go through the gateway's own MCP path
 * with the signed-in principal's permissions (never a second router in the
 * browser).
 */
export function ChatPage() {
  return (
    <section aria-labelledby="chat-heading">
      <h1 id="chat-heading">Chat</h1>

      <div className="banner banner-warn" role="note">
        <strong>Foundation only.</strong> The agent (LLM-backed tool calling) ships in{" "}
        <strong>Milestone 9</strong>. Until the gateway exposes its authenticated chat endpoint, this screen sends
        nothing and generates no responses.
      </div>

      <div className="card chat-panel">
        <h2>Conversation</h2>
        <div className="chat-empty">
          <p className="muted">
            No messages — and none will be invented. The roadmap order matters: gateway auth, audit and tool routing are
            proven first; an optional free-tier LLM (Groq) or local Ollama model plugs in later.
          </p>
        </div>

        <form className="chat-composer" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <input
            id="chat-input"
            type="text"
            placeholder="Chat arrives in Milestone 9 — nothing is sent from here"
            disabled
            aria-disabled="true"
          />
          <button type="submit" disabled aria-disabled="true">
            Send
          </button>
        </form>
        <p className="muted small">
          When it ships, the agent runs <em>inside the gateway</em> as an MCP client: every tool call re-checks your
          role and grants exactly like a direct <code>tools/call</code> — the browser never routes tools itself.
        </p>
      </div>
    </section>
  );
}
