import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EXAMPLE_PROMPTS,
  HISTORY_TURNS,
  historySlice,
  isAbortError,
  MAX_INPUT_CHARS,
  newMessageId,
  PARTIAL_TURN_TEXT,
  partialTurnMessage,
  resetMessageIds,
  retryTarget,
  toolChipLabel,
  toolUpstream,
  type ChatMessage,
} from "../src/lib/chat.ts";

function msg(id: number, role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, ...extra };
}

describe("chat helpers", () => {
  test("newMessageId is monotonic and collision-free", () => {
    resetMessageIds();
    const ids = [newMessageId(), newMessageId(), newMessageId()];
    assert.deepEqual(ids, [1, 2, 3]);
    assert.equal(new Set(ids).size, 3);
    resetMessageIds();
    assert.equal(newMessageId(), 1, "reset restores the counter for tests only");
  });

  test("historySlice sends at most `limit` most-recent turns as wire shape", () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      msg(i, i % 2 === 0 ? "user" : "assistant", `m${i}`),
    );
    const slice = historySlice(messages, HISTORY_TURNS);
    assert.equal(slice.length, HISTORY_TURNS);
    assert.equal(slice[0]?.content, "m5", "keeps the newest 10 of 15");
    assert.equal(slice[slice.length - 1]?.content, "m14");
    assert.deepEqual(Object.keys(slice[0] ?? {}), ["role", "content"], "wire shape only");
    assert.deepEqual(historySlice(messages, 0), []);
    assert.equal(historySlice(messages, 999).length, 15);
  });

  test("retryTarget re-sends the last user turn with only preceding history", () => {
    const messages = [
      msg(1, "user", "first"),
      msg(2, "assistant", "answer 1"),
      msg(3, "user", "second"),
    ];
    const target = retryTarget(messages);
    assert.ok(target !== null);
    assert.equal(target.message, "second");
    assert.deepEqual(target.history, [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer 1" },
    ]);
  });

  test("retryTarget ignores a trailing assistant turn (failed reply is not re-sent)", () => {
    const messages = [msg(1, "user", "only")];
    const target = retryTarget(messages);
    assert.ok(target !== null);
    assert.equal(target.message, "only");
    assert.deepEqual(target.history, []);
    assert.equal(retryTarget([]), null);
    assert.equal(retryTarget([msg(1, "assistant", "orphan")]), null);
  });

  test("REGRESSION: a retry re-sends only the failed user turn — never prior tool state or conversation copies", () => {
    const messages = [
      msg(1, "user", "list products"),
      msg(2, "assistant", "here they are", {
        toolCalls: [{ name: "woocommerce_list_products", outcome: "success" }],
      }),
      msg(3, "user", "now the orders"),
    ];
    const target = retryTarget(messages);
    assert.ok(target !== null);
    // The failed turn itself is not duplicated into the history…
    assert.equal(target.message, "now the orders");
    assert.deepEqual(target.history, [
      { role: "user", content: "list products" },
      { role: "assistant", content: "here they are" },
    ]);
    // …and prior tool calls are content-only on the wire: a retry cannot
    // re-execute them (no tool entries, no tool_calls in history).
    for (const turn of target.history) {
      assert.deepEqual(Object.keys(turn).sort(), ["content", "role"]);
    }
    const wire = JSON.stringify(target);
    assert.ok(!wire.includes("tool_calls"), "history never carries tool-call state");
    assert.ok(!wire.includes("woocommerce_list_products"), "history never carries tool names");
  });

  test("partialTurnMessage preserves chips for a turn that failed after tools ran", () => {
    resetMessageIds();
    const message = partialTurnMessage(
      [{ name: "woocommerce_list_orders", outcome: "success" }],
      2,
    );
    assert.equal(message.role, "assistant");
    assert.equal(message.content, PARTIAL_TURN_TEXT);
    assert.deepEqual(message.toolCalls, [{ name: "woocommerce_list_orders", outcome: "success" }]);
    assert.equal(message.rounds, 2);
    // An assistant message: retryTarget still resolves to the user turn above it.
    const thread = [msg(9, "user", "do it"), message];
    const target = retryTarget(thread);
    assert.ok(target !== null);
    assert.equal(target.message, "do it");
    assert.deepEqual(target.history, []);
    resetMessageIds();
  });

  test("toolChipLabel maps gateway outcomes", () => {
    assert.equal(toolChipLabel("success"), "✓");
    assert.equal(toolChipLabel("denied"), "denied");
    assert.equal(toolChipLabel("invalid"), "invalid");
    assert.equal(toolChipLabel("error"), "failed");
    assert.equal(toolChipLabel("weird"), "failed");
  });

  test("toolUpstream parses the qualified-name prefix via shared logic", () => {
    assert.equal(toolUpstream("woocommerce_list_products"), "woocommerce");
    assert.equal(toolUpstream("inventory_check_stock"), "inventory");
    assert.equal(toolUpstream("mystery_tool"), null);
  });

  test("isAbortError recognises DOMException AbortError and name-shaped errors", () => {
    assert.ok(isAbortError(new DOMException("aborted", "AbortError")));
    assert.ok(isAbortError({ name: "AbortError" }));
    assert.ok(!isAbortError(new Error("boom")));
    assert.ok(!isAbortError(null));
  });

  test("example prompts are real and bounded by the input cap", () => {
    assert.ok(EXAMPLE_PROMPTS.length >= 3 && EXAMPLE_PROMPTS.length <= 4);
    for (const prompt of EXAMPLE_PROMPTS) {
      assert.ok(prompt.length > 0 && prompt.length <= MAX_INPUT_CHARS);
    }
  });
});
