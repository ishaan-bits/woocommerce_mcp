import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLogger, redactLine, type LogSink } from "../src/logger.ts";

function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string): void {
      lines.push(line);
    },
  };
}

describe("redactLine", () => {
  test("redacts WooCommerce consumer keys and secrets", () => {
    const line = 'key=ck_abc123DEF secret=cs_xyz789GHI other=keep';
    const redacted = redactLine(line);
    assert.ok(!redacted.includes("ck_abc123DEF"));
    assert.ok(!redacted.includes("cs_xyz789GHI"));
    assert.ok(redacted.includes("other=keep"));
  });

  test("redacts HTTP Basic authorization values", () => {
    const redacted = redactLine('authorization: Basic dGVzdDpzZWNyZXQ=');
    assert.ok(!redacted.includes("dGVzdDpzZWNyZXQ="));
    assert.ok(redacted.includes("[redacted]"));
  });

  test("redacts gateway keys, Bearer tokens, postgres URLs and JSON authorization fields (C3 parity)", () => {
    const line = JSON.stringify({
      key: "umk_live_abcdefghijklmnop",
      sk: "sk_live_1234567890",
      auth: "Bearer opaque-token-value",
      db: "postgresql://mcp:pw@db:5432/woo",
      authorization: "Basic dXNlcjpwYXNz",
    });
    const redacted = redactLine(line);
    assert.ok(!redacted.includes("umk_live_abcdefghijklmnop"));
    assert.ok(!redacted.includes("sk_live_1234567890"));
    assert.ok(!redacted.includes("opaque-token-value"));
    assert.ok(!redacted.includes("postgresql://mcp:pw@db:5432/woo"));
    assert.ok(!redacted.includes("dXNlcjpwYXNz"));
  });
});

describe("createLogger", () => {
  test("emits single-line JSON records with ts, level and event", () => {
    const sink = memorySink();
    const logger = createLogger({ level: "info", sink, now: () => "2026-10-21T00:00:00.000Z" });
    logger.info("config_loaded", { port: 8081 });
    assert.equal(sink.lines.length, 1);
    const line = sink.lines[0];
    assert.ok(typeof line === "string");
    const record = JSON.parse(line);
    assert.equal(record.ts, "2026-10-21T00:00:00.000Z");
    assert.equal(record.level, "info");
    assert.equal(record.event, "config_loaded");
    assert.equal(record.port, 8081);
  });

  test("filters records below the configured level", () => {
    const sink = memorySink();
    const logger = createLogger({ level: "warn", sink });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assert.deepEqual(
      sink.lines.map((line) => JSON.parse(line).event),
      ["w", "e"],
    );
  });

  test("redacts credentials that reach the sink", () => {
    const sink = memorySink();
    const logger = createLogger({ level: "debug", sink });
    logger.debug("woo_request_failed", { authorization: "Basic Y2tfYWJjOmNzX2RlZg==", key: "ck_abcdef" });
    const line = sink.lines[0];
    assert.ok(typeof line === "string");
    assert.ok(!line.includes("Y2tfYWJjOmNzX2RlZg=="));
    assert.ok(!line.includes("ck_abcdef"));
  });
});
