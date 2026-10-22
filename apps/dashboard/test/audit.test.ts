import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  auditFiltersActive,
  buildAuditQuery,
  emptyAuditFilters,
  formatLocalTime,
  outcomeTone,
  truncate,
  UPSTREAM_FILTER_IDS,
} from "../src/lib/audit.ts";

function filters(overrides: Partial<ReturnType<typeof emptyAuditFilters>> = {}) {
  return { ...emptyAuditFilters(), ...overrides };
}

describe("audit filter query builder", () => {
  test("empty filters produce an empty query", () => {
    assert.deepEqual(buildAuditQuery(emptyAuditFilters()), {});
    assert.equal(auditFiltersActive(emptyAuditFilters()), false);
  });

  test("only set, whitelisted filters are included", () => {
    const query = buildAuditQuery(filters({ action: "tool_call", outcome: "success" }));
    assert.deepEqual(query, { action: "tool_call", outcome: "success" });
    assert.equal(auditFiltersActive(filters({ action: "tool_call" })), true);
  });

  test("non-whitelisted values are dropped (client never knowingly sends a 400)", () => {
    const query = buildAuditQuery(filters({ action: "drop_table", outcome: "maybe", upstreamId: "evil" }));
    assert.deepEqual(query, {});
  });

  test("upstream and user filters pass through when whitelisted/trimmed", () => {
    const query = buildAuditQuery(filters({ upstreamId: "woocommerce", userId: "  u-123  " }));
    assert.deepEqual(query, { upstreamId: "woocommerce", userId: "u-123" });
  });

  test("tool term is trimmed and capped at the server's 64-char bound", () => {
    const long = `  ${"x".repeat(100)}  `;
    const query = buildAuditQuery(filters({ tool: long }));
    assert.equal(query.tool?.length, 64);
    assert.equal(query.tool, "x".repeat(64));
    assert.deepEqual(buildAuditQuery(filters({ tool: "   " })), {}, "blank tool is omitted");
  });

  test("whitelists match the server contract", () => {
    assert.deepEqual(AUDIT_ACTIONS, [
      "tool_call",
      "auth_failed",
      "access_denied",
      "key_created",
      "key_revoked",
      "upstream_enabled",
      "upstream_disabled",
      "user_created",
      "user_updated",
      "upstream_created",
      "upstream_updated",
      "upstream_deleted",
    ]);
    assert.deepEqual(AUDIT_OUTCOMES, ["success", "error", "timeout", "denied"]);
    assert.deepEqual(UPSTREAM_FILTER_IDS, ["woocommerce", "inventory", "support"]);
  });

  test("active detection covers every field including a blank-ish tool", () => {
    assert.equal(auditFiltersActive(filters({ tool: " x " })), true);
    assert.equal(auditFiltersActive(filters({ userId: "u" })), true);
    assert.equal(auditFiltersActive(filters({ upstreamId: "inventory" })), true);
    assert.equal(auditFiltersActive(filters({ outcome: "denied" })), true);
  });

  test("outcomeTone makes failures visually obvious", () => {
    assert.equal(outcomeTone("success"), "success");
    assert.equal(outcomeTone("error"), "error");
    assert.equal(outcomeTone("timeout"), "warn");
    assert.equal(outcomeTone("denied"), "warn");
    assert.equal(outcomeTone("mystery"), "neutral");
  });

  test("formatLocalTime falls back to the raw string for invalid dates", () => {
    assert.equal(formatLocalTime("not-a-date"), "not-a-date");
    const formatted = formatLocalTime("2026-10-21T00:00:00.000Z");
    assert.ok(formatted.length > 0);
  });

  test("truncate appends an ellipsis only when needed", () => {
    assert.equal(truncate("hello", 10), "hello");
    assert.equal(truncate("hello world", 6), "hello…"); // total length ≤ max
  });
});
