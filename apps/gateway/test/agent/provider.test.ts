/**
 * Milestone 9 — LLM provider adapter (D29). Pure unit tests with an injected
 * fetch: no network, no credits, no real credentials.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  argumentsWereMalformed,
  OpenAiCompatProvider,
  parseChatCompletion,
  ProviderError,
} from "../../src/agent/provider.ts";
import type { LlmConfig } from "../../src/config.ts";

const FAKE_KEY = "gsk_test_fake_key_never_a_real_credential";

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    baseUrl: "https://llm.example.test/v1",
    apiKey: FAKE_KEY,
    model: "test-model",
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

type FetchCapture = { url: string; init: RequestInit } | undefined;

function fakeFetch(status: number, body: unknown, capture?: { current: FetchCapture }) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (capture !== undefined) {
      capture.current = { url, init };
    }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
}

describe("OpenAiCompatProvider", () => {
  test("posts to the configured base URL with the key in a header only", async () => {
    const capture: { current: FetchCapture } = { current: undefined };
    const provider = new OpenAiCompatProvider(
      config({ baseUrl: "https://llm.example.test/v1/" }),
      fakeFetch(200, { choices: [{ message: { content: "hello" } }] }, capture),
    );
    const response = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      timeoutMs: 1_000,
    });
    assert.equal(response.content, "hello");
    assert.equal(response.toolCalls.length, 0);
    assert.equal(capture.current?.url, "https://llm.example.test/v1/chat/completions");
    const headers = (capture.current?.init.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`);
    // The key is not in the body.
    assert.ok(!String(capture.current?.init.body).includes(FAKE_KEY));
  });

  test("omits the Authorization header when no key is configured (local provider)", async () => {
    const capture: { current: FetchCapture } = { current: undefined };
    const provider = new OpenAiCompatProvider(
      config({ apiKey: "" }),
      fakeFetch(200, { choices: [{ message: { content: "ok" } }] }, capture),
    );
    await provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 1_000 });
    const headers = (capture.current?.init.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, undefined);
  });

  test("parses tool calls with JSON arguments", async () => {
    const provider = new OpenAiCompatProvider(
      config(),
      fakeFetch(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c1", function: { name: "woocommerce_list_products", arguments: '{"page":2}' } },
              ],
            },
          },
        ],
      }),
    );
    const response = await provider.complete({ messages: [], tools: [], timeoutMs: 1_000 });
    assert.equal(response.toolCalls.length, 1);
    assert.equal(response.toolCalls[0]?.name, "woocommerce_list_products");
    assert.deepEqual(response.toolCalls[0]?.arguments, { page: 2 });
    assert.equal(argumentsWereMalformed(response.toolCalls[0]!), false);
  });

  test("keeps unparsable tool arguments as rawArguments flagged malformed", async () => {
    const provider = new OpenAiCompatProvider(
      config(),
      fakeFetch(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "woocommerce_list_products", arguments: "{oops" } }],
            },
          },
        ],
      }),
    );
    const response = await provider.complete({ messages: [], tools: [], timeoutMs: 1_000 });
    assert.equal(argumentsWereMalformed(response.toolCalls[0]!), true);
  });

  test("serializes assistant tool_calls back in the OpenAI wire shape (live Groq round-2 HTTP 400 regression)", async () => {
    const capture: { current: FetchCapture } = { current: undefined };
    const provider = new OpenAiCompatProvider(
      config(),
      fakeFetch(200, { choices: [{ message: { content: "final answer" } }] }, capture),
    );
    await provider.complete({
      messages: [
        { role: "user", content: "list products" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_live_1", name: "woocommerce_list_products", arguments: { page: 1 }, rawArguments: '{"page":1}' },
          ],
        },
        { role: "tool", content: "products: Blue Mug", tool_call_id: "call_live_1" },
      ],
      tools: [],
      timeoutMs: 1_000,
    });
    const body = JSON.parse(String(capture.current?.init.body)) as { messages: Array<Record<string, unknown>> };
    // Exact wire shape: nested function, stringified arguments, no internal
    // fields (flat name / parsed object / rawArguments) — what strict providers
    // validate on every follow-up round.
    assert.deepEqual(body.messages, [
      { role: "user", content: "list products" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_live_1", type: "function", function: { name: "woocommerce_list_products", arguments: '{"page":1}' } },
        ],
      },
      { role: "tool", content: "products: Blue Mug", tool_call_id: "call_live_1" },
    ]);
  });

  test("serializes empty raw arguments as '{}' so the entry stays valid JSON", async () => {
    const capture: { current: FetchCapture } = { current: undefined };
    const provider = new OpenAiCompatProvider(
      config(),
      fakeFetch(200, { choices: [{ message: { content: "ok" } }] }, capture),
    );
    await provider.complete({
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c0", name: "a_tool", arguments: {}, rawArguments: "" }] },
      ],
      tools: [],
      timeoutMs: 1_000,
    });
    const body = JSON.parse(String(capture.current?.init.body)) as {
      messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    };
    assert.equal(body.messages[0]?.tool_calls?.[0]?.function.arguments, "{}");
  });

  test("maps 429 to rate_limited, 401 to rejected, 5xx to unavailable", async () => {
    for (const [status, kind] of [
      [429, "rate_limited"],
      [401, "rejected"],
      [403, "rejected"],
      [503, "unavailable"],
    ] as const) {
      const provider = new OpenAiCompatProvider(config(), fakeFetch(status, { error: "x" }));
      await assert.rejects(
        () => provider.complete({ messages: [], tools: [], timeoutMs: 1_000 }),
        (error: unknown) => error instanceof ProviderError && error.kind === kind,
      );
    }
  });

  test("maps non-JSON bodies to malformed", async () => {
    const provider = new OpenAiCompatProvider(config(), fakeFetch(200, "<html>oops</html>"));
    await assert.rejects(
      () => provider.complete({ messages: [], tools: [], timeoutMs: 1_000 }),
      (error: unknown) => error instanceof ProviderError && error.kind === "malformed",
    );
  });

  test("maps aborts to timeout and network failures to unavailable", async () => {
    const timeoutProvider = new OpenAiCompatProvider(config(), async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    });
    await assert.rejects(
      () => timeoutProvider.complete({ messages: [], tools: [], timeoutMs: 1_000 }),
      (error: unknown) => error instanceof ProviderError && error.kind === "timeout",
    );

    const deadProvider = new OpenAiCompatProvider(config(), async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      () => deadProvider.complete({ messages: [], tools: [], timeoutMs: 1_000 }),
      (error: unknown) => error instanceof ProviderError && error.kind === "unavailable",
    );
  });

  test("error messages never contain the API key", async () => {
    for (const status of [429, 401, 500]) {
      const provider = new OpenAiCompatProvider(config(), fakeFetch(status, { error: `key=${FAKE_KEY}` }));
      try {
        await provider.complete({ messages: [], tools: [], timeoutMs: 1_000 });
        assert.fail("expected ProviderError");
      } catch (error) {
        assert.ok(error instanceof ProviderError);
        assert.ok(!error.message.includes(FAKE_KEY), `ProviderError leaked the key: ${error.message}`);
      }
    }
    const unreachable = new OpenAiCompatProvider(config(), async () => {
      throw new Error(`connect ECONNREFUSED with header Bearer ${FAKE_KEY}`);
    });
    try {
      await unreachable.complete({ messages: [], tools: [], timeoutMs: 1_000 });
      assert.fail("expected ProviderError");
    } catch (error) {
      assert.ok(error instanceof ProviderError);
      // The coarse message may embed a *sanitized* fetch error; the key must
      // not be forwarded even then.
      assert.ok(!error.message.includes(FAKE_KEY));
    }
  });
});

describe("parseChatCompletion", () => {
  test("rejects shapes that are not chat completions", () => {
    for (const payload of [null, 42, {}, { choices: [] }, { choices: [{ message: "nope" }] }]) {
      assert.throws(() => parseChatCompletion(payload), (error: unknown) => error instanceof ProviderError);
    }
  });
});
