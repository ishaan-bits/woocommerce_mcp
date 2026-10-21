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
  test("redacts bearer and API-key-looking values", () => {
    const redacted = redactLine("authorization: Bearer abcdef123456 key=umk_abcDEF-123 other=keep");
    assert.ok(!redacted.includes("abcdef123456"));
    assert.ok(!redacted.includes("umk_abcDEF-123"));
    assert.ok(redacted.includes("other=keep"));
  });

  test("redacts Basic auth values too (defence in depth)", () => {
    const redacted = redactLine("authorization: Basic dGVzdDpzZWNyZXQ=");
    assert.ok(!redacted.includes("dGVzdDpzZWNyZXQ="));
    assert.ok(redacted.includes("[redacted]"));
  });
});

describe("createLogger", () => {
  test("emits single-line JSON records with ts, level and event", () => {
    const sink = memorySink();
    const logger = createLogger({ level: "info", sink, now: () => "2026-10-21T00:00:00.000Z" });
    logger.info("config_loaded", { port: 8084 });
    assert.equal(sink.lines.length, 1);
    const record = JSON.parse(sink.lines[0]!);
    assert.equal(record.ts, "2026-10-21T00:00:00.000Z");
    assert.equal(record.level, "info");
    assert.equal(record.event, "config_loaded");
    assert.equal(record.port, 8084);
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
});
