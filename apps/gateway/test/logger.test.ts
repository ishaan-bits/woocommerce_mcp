import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLogger, redactLine } from "../src/logger.ts";

describe("gateway logger", () => {
  test("redacts credential-looking strings", () => {
    const line = JSON.stringify({
      key: "ck_abc123DEF456",
      secret: "cs_zzz999",
      sk: "sk_live_1234567890",
      header: "Bearer ghp_abcdefghijklmno",
      basic: "Basic dXNlcjpwYXNzd29yZA==",
    });
    const redacted = redactLine(line);
    assert.ok(!redacted.includes("ck_abc123DEF456"));
    assert.ok(!redacted.includes("cs_zzz999"));
    assert.ok(!redacted.includes("sk_live_1234567890"));
    assert.ok(!redacted.includes("ghp_abcdefghijklmno"));
    assert.ok(!redacted.includes("dXNlcjpwYXNzd29yZA=="));
    assert.match(redacted, /\[redacted\]/);
  });

  test("filters by level and emits structured JSON", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      sink: { write: (line) => lines.push(line) },
      now: () => "2026-10-21T00:00:00.000Z",
    });
    logger.debug("hidden_event");
    logger.info("shown_event", { tool_name: "woocommerce_list_products" });
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    assert.equal(record.ts, "2026-10-21T00:00:00.000Z");
    assert.equal(record.level, "info");
    assert.equal(record.event, "shown_event");
    assert.equal(record.tool_name, "woocommerce_list_products");
  });

  test("redaction applies to emitted log lines, not just raw strings", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: { write: (line) => lines.push(line) } });
    logger.warn("secret_seen", { detail: "ck_shouldNeverAppear" });
    assert.equal(lines.length, 1);
    assert.ok(!(lines[0] ?? "").includes("ck_shouldNeverAppear"));
  });
});
