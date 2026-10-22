import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, type ApiClient } from "../src/api/client.ts";
import {
  connectionStatus,
  getConnectionState,
  noteApiSuccess,
  resetConnection,
  trackApi,
} from "../src/lib/connection.ts";

describe("connection status pill (derived from real API outcomes)", () => {
  test("no calls yet → unknown", () => {
    const result = connectionStatus({ lastSuccessAt: null, lastFailureAt: null }, 1_000);
    assert.equal(result.tone, "neutral");
    assert.ok(result.label.includes("unknown"));
  });

  test("only successes → connected, includes the last-call time", () => {
    const at = Date.UTC(2026, 0, 1, 12, 30, 45);
    const result = connectionStatus({ lastSuccessAt: at, lastFailureAt: null }, at + 5);
    assert.equal(result.tone, "success");
    assert.ok(result.label.startsWith("Connected"));
    assert.ok(/\d{2}:\d{2}:\d{2}/.test(result.label), `time in label: ${result.label}`);
  });

  test("latest call failed → warn (disconnected), even with earlier successes", () => {
    const result = connectionStatus({ lastSuccessAt: 1_000, lastFailureAt: 2_000 }, 3_000);
    assert.equal(result.tone, "warn");
    assert.ok(result.label.includes("unreachable"));
  });

  test("success after a failure → connected again", () => {
    const result = connectionStatus({ lastSuccessAt: 5_000, lastFailureAt: 2_000 }, 6_000);
    assert.equal(result.tone, "success");
  });

  test("failure with no success → warn", () => {
    const result = connectionStatus({ lastSuccessAt: null, lastFailureAt: 1 }, 2);
    assert.equal(result.tone, "warn");
  });
});

describe("REGRESSION: provider availability is not gateway connectivity", () => {
  function stubClient(fail: () => Promise<unknown>): ApiClient {
    return { chat: () => fail() } as unknown as ApiClient;
  }

  async function expectRejected(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(() => promise);
  }

  test("an LLM provider rate limit (429 provider_rate_limited) keeps the pill Connected", async () => {
    resetConnection();
    const api = trackApi(
      stubClient(async () => {
        throw new ApiError(429, "provider_rate_limited", "The LLM provider is rate limiting requests.");
      }),
    );
    noteApiSuccess(1_000); // the gateway is demonstrably reachable
    await expectRejected(api.chat("hi"));
    assert.equal(getConnectionState().lastFailureAt, null);
    const pill = connectionStatus(getConnectionState(), 2_000);
    assert.equal(pill.tone, "success");
    assert.ok(pill.label.startsWith("Connected"));
  });

  test("provider_timeout / provider_error / agent_not_configured never claim the gateway is unreachable", async () => {
    for (const [status, code] of [
      [504, "provider_timeout"],
      [502, "provider_error"],
      [503, "agent_not_configured"],
    ] as const) {
      resetConnection();
      const api = trackApi(
        stubClient(async () => {
          throw new ApiError(status, code);
        }),
      );
      noteApiSuccess(1_000);
      await expectRejected(api.chat("hi"));
      assert.equal(getConnectionState().lastFailureAt, null, code);
    }
  });

  test("a real network failure DOES mark the gateway unreachable", async () => {
    resetConnection();
    const api = trackApi(
      stubClient(async () => {
        throw new ApiError(0, "gateway_unreachable", "Gateway unreachable");
      }),
    );
    noteApiSuccess(1_000);
    await expectRejected(api.chat("hi"));
    assert.notEqual(getConnectionState().lastFailureAt, null);
    const pill = connectionStatus(getConnectionState(), 2_000);
    assert.equal(pill.tone, "warn");
    assert.ok(pill.label.includes("unreachable"));
  });

  test("a gateway 5xx is genuine gateway trouble and marks it", async () => {
    resetConnection();
    const api = trackApi(
      stubClient(async () => {
        throw new ApiError(500, "internal_error");
      }),
    );
    noteApiSuccess(1_000);
    await expectRejected(api.chat("hi"));
    assert.notEqual(getConnectionState().lastFailureAt, null);
  });
});
