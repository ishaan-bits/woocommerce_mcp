import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { connectionStatus } from "../src/lib/connection.ts";

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
