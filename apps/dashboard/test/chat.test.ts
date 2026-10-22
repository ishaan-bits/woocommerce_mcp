import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EXAMPLE_PROMPTS,
  HISTORY_TURNS,
  historySlice,
  isAbortError,
  MAX_INPUT_CHARS,
  newMessageId,
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
