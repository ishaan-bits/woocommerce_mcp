import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAuditWriter, sanitizeAuditText } from "../src/audit.ts";
import { createLogger } from "../src/logger.ts";
import { FakeAuditRepository } from "./helpers/fake-repos.ts";

function captureLogger(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: { write: (line) => lines.push(line) } });
  return { lines, logger };
}

describe("audit field sanitization (C6)", () => {
  test("control characters are stripped and fields are capped at 200 characters", () => {
    assert.equal(sanitizeAuditText("plain"), "plain");
    assert.equal(sanitizeAuditText("inject\u0000ion\u001b[31m"), "injection[31m");
    assert.equal(sanitizeAuditText("line\nbreak\ttab"), "linebreaktab");
    assert.equal(sanitizeAuditText("x".repeat(500))?.length, 200);
    assert.equal(sanitizeAuditText(""), null);
    assert.equal(sanitizeAuditText("\u0000\u0001"), null);
    assert.equal(sanitizeAuditText(null), null);
  });

  test("the writer stores only structured safe fields, never secrets", async () => {
    const repo = new FakeAuditRepository();
    const { lines, logger } = captureLogger();
    const writer = createAuditWriter(repo, logger);

    await writer.recordToolCall({
      principalKey: "umk_prefix_value_should_not_be_here_as_full_key_but_prefix_is_fine",
      userId: "user-1",
      role: "admin",
      upstreamId: "woocommerce",
      toolName: "list_products",
      qualifiedName: "woocommerce_list_products",
      outcome: "success",
      durationMs: 12.7,
      errorCode: null,
    });

    assert.equal(repo.entries.length, 1);
    const stored = repo.entries[0];
    assert.ok(stored);
    assert.equal(stored.action, "tool_call");
    assert.equal(stored.durationMs, 12);
    assert.ok(!lines.join("\n").includes("umk_"));
    const serialized = JSON.stringify(stored);
    assert.ok(!/Bearer|pepper/i.test(serialized));
  });

  test("error codes are reduced to a conservative token charset", async () => {
    const repo = new FakeAuditRepository();
    const { logger } = captureLogger();
    const writer = createAuditWriter(repo, logger);

    await writer.record({
      action: "tool_call",
      keyId: null,
      userId: null,
      role: null,
      upstreamId: null,
      toolName: "list\u0000_products",
      qualifiedName: "woocommerce_list_products".repeat(20),
      outcome: "error",
      durationMs: -5,
      errorCode: "Upstream Timeout!!",
    });

    const stored = repo.entries[0];
    assert.ok(stored);
    assert.equal(stored.raw.errorCode, "upstream_timeout__");
    assert.equal(stored.toolName, "list_products");
    assert.equal(stored.qualifiedName?.length, 200);
    assert.equal(stored.durationMs, 0);
  });

  test("overlong key/user ids are dropped rather than stored", async () => {
    const repo = new FakeAuditRepository();
    const { logger } = captureLogger();
    const writer = createAuditWriter(repo, logger);

    await writer.record({
      action: "auth_failed",
      keyId: "x".repeat(65),
      userId: "y".repeat(65),
      role: null,
      upstreamId: null,
      toolName: null,
      qualifiedName: null,
      outcome: "denied",
      durationMs: 1,
      errorCode: "missing_credentials",
    });

    const stored = repo.entries[0];
    assert.ok(stored);
    assert.equal(stored.raw.keyId, null);
    assert.equal(stored.raw.userId, null);
  });

  test("a failing audit store degrades forensics but never breaks the request path", async () => {
    const repo = new FakeAuditRepository();
    repo.down = true;
    const { lines, logger } = captureLogger();
    const writer = createAuditWriter(repo, logger);

    await assert.doesNotReject(() =>
      writer.recordToolCall({
        principalKey: "key",
        userId: "user",
        role: "admin",
        upstreamId: "woocommerce",
        toolName: "list_products",
        qualifiedName: "woocommerce_list_products",
        outcome: "success",
        durationMs: 5,
        errorCode: null,
      }),
    );

    const logged = lines.join("\n");
    assert.ok(logged.includes("audit_write_failed"));
    assert.ok(!/umk_/.test(logged));
  });

  test("audit ids advance so keyset pagination always moves backwards", async () => {
    const repo = new FakeAuditRepository();
    const { logger } = captureLogger();
    const writer = createAuditWriter(repo, logger);

    for (let i = 0; i < 5; i += 1) {
      await writer.record({
        action: "tool_call",
        keyId: null,
        userId: null,
        role: null,
        upstreamId: null,
        toolName: null,
        qualifiedName: `woocommerce_tool_${i}`,
        outcome: "success",
        durationMs: i,
        errorCode: null,
      });
    }

    const recent = await repo.recent(3);
    assert.deepEqual(
      recent.map((entry) => entry.qualifiedName),
      ["woocommerce_tool_4", "woocommerce_tool_3", "woocommerce_tool_2"],
    );
    const older = await repo.recent(3, "4");
    assert.deepEqual(
      older.map((entry) => entry.qualifiedName),
      ["woocommerce_tool_2", "woocommerce_tool_1", "woocommerce_tool_0"],
    );
  });
});
