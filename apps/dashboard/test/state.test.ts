import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AUDIT_LIMIT_DEFAULT,
  auditCursor,
  clampAuditLimit,
  failed,
  loaded,
  loading,
  makeToast,
  nextAuditLimit,
  projectAuditRow,
  projectAuditRows,
  pushToast,
  removeToast,
  resolveTheme,
  sessionExpiryShouldNotify,
  toFailure,
} from "../src/state.ts";

describe("dashboard state model", () => {
  test("loading / loaded / empty / error transitions are explicit states", () => {
    assert.deepEqual(loading(), { status: "loading" });
    assert.deepEqual(loaded([1]), { status: "loaded", data: [1] });
    assert.deepEqual(loaded([], false), { status: "loaded", data: [] });
    assert.deepEqual(loaded([], true), { status: "empty" });
    assert.deepEqual(failed("gateway_unreachable", "Gateway unreachable"), {
      status: "error",
      code: "gateway_unreachable",
      message: "Gateway unreachable",
    });
  });

  test("toFailure renders any thrown value into a display-safe code/message", () => {
    const apiLike = Object.assign(new Error("Not permitted"), { code: "forbidden", status: 403 });
    assert.deepEqual(toFailure(apiLike), { code: "forbidden", message: "Not permitted" });
    assert.deepEqual(toFailure(new Error("boom")), { code: "error", message: "boom" });
    assert.deepEqual(toFailure("weird"), { code: "error", message: "weird" });
    assert.deepEqual(toFailure({ code: "unauthorized" }), { code: "unauthorized", message: "unauthorized" });
  });

  test("audit limits are clamped to the server contract (1–100)", () => {
    assert.equal(clampAuditLimit(0), 1);
    assert.equal(clampAuditLimit(-5), 1);
    assert.equal(clampAuditLimit(101), 100);
    assert.equal(clampAuditLimit(10_000), 100);
    assert.equal(clampAuditLimit(37), 37);
    assert.equal(clampAuditLimit(3.9), 3);
    assert.equal(clampAuditLimit(Number.NaN), AUDIT_LIMIT_DEFAULT);
  });

  test("nextAuditLimit cycles through bounded page sizes only", () => {
    assert.equal(nextAuditLimit(10), 25);
    assert.equal(nextAuditLimit(25), 50);
    assert.equal(nextAuditLimit(50), 100);
    assert.equal(nextAuditLimit(100), 10);
    assert.equal(nextAuditLimit(999), nextAuditLimit(100));
  });

  test("projectAuditRow keeps only whitelisted display fields (redaction)", () => {
    const raw = {
      id: "42",
      occurredAt: "2026-10-21T00:00:00.000Z",
      action: "tool_call",
      outcome: "success",
      userId: "11111111-1111-4111-8111-111111111111",
      role: "admin",
      upstreamId: "woocommerce",
      toolName: "list_products",
      qualifiedName: "woocommerce_list_products",
      durationMs: 12,
      errorCode: null,
      // Fields that must never reach the render layer:
      keyId: "umk_should_not_show",
      key_hash: "deadbeef",
      authorization: "Bearer umk_secret",
      cookie: "urumi_session=secret",
      pepper: "super-secret-pepper",
      password: "hunter2",
      token: "abc",
      unexpected: { nested: "value" },
    };

    const view = projectAuditRow(raw);
    assert.deepEqual(Object.keys(view).sort(), [
      "action",
      "actor",
      "duration_ms",
      "error_code",
      "id",
      "occurred_at",
      "outcome",
      "tool",
      "upstream",
    ]);
    const rendered = JSON.stringify(view);
    assert.ok(!rendered.includes("umk_"), "no key material");
    assert.ok(!rendered.includes("deadbeef"), "no hashes");
    assert.ok(!rendered.includes("Bearer"), "no auth headers");
    assert.ok(!rendered.includes("pepper"), "no pepper");
    assert.ok(!rendered.includes("hunter2"), "no passwords");
    assert.equal(view.actor, "11111111-1111-4111-8111-111111111111 (admin)");
    assert.equal(view.tool, "woocommerce_list_products");
    assert.equal(view.duration_ms, 12);
  });

  test("projectAuditRow degrades gracefully on partial rows", () => {
    const view = projectAuditRow({ id: "7", action: "auth_failed", outcome: "denied" });
    assert.equal(view.actor, "system");
    assert.equal(view.upstream, null);
    assert.equal(view.tool, null);
    assert.equal(view.error_code, null);
    assert.equal(view.duration_ms, 0);

    const negative = projectAuditRow({ id: "8", outcome: "error", durationMs: -1 });
    assert.equal(negative.duration_ms, 0);
  });

  test("projectAuditRows preserves order and length", () => {
    const rows = projectAuditRows([
      { id: "3", action: "a", outcome: "success" },
      { id: "2", action: "b", outcome: "success" },
      { id: "1", action: "c", outcome: "error" },
    ]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["3", "2", "1"],
    );
  });

  test("auditCursor is the oldest visible id (keyset), undefined when empty", () => {
    assert.equal(auditCursor([]), undefined);
    assert.equal(
      auditCursor([
        { id: "30" },
        { id: "29" },
        { id: "28" },
      ]),
      "28",
    );
  });
});

describe("toasts (bounded list)", () => {
  test("makeToast assigns increasing ids and stores tone/message", () => {
    const a = makeToast("success", "saved");
    const b = makeToast("error", "nope");
    assert.equal(a.tone, "success");
    assert.equal(a.message, "saved");
    assert.ok(b.id > a.id, "ids increase so React keys stay unique");
  });

  test("pushToast appends and drops the oldest beyond max", () => {
    let toasts: ReturnType<typeof makeToast>[] = [];
    for (let i = 0; i < 6; i++) {
      toasts = pushToast(toasts, makeToast("info", `t${i}`), 4);
    }
    assert.equal(toasts.length, 4);
    assert.deepEqual(toasts.map((t) => t.message), ["t2", "t3", "t4", "t5"]);
  });

  test("removeToast removes by id and ignores unknown ids", () => {
    const a = makeToast("info", "a");
    const b = makeToast("info", "b");
    assert.deepEqual(removeToast([a, b], a.id), [b]);
    assert.deepEqual(removeToast([a, b], 9999), [a, b]);
  });
});

describe("session expiry notification (D33)", () => {
  test("only a connected session notifies on 401 — fresh checks and repeats stay silent", () => {
    // Mid-flight first check: no toast, no bounce.
    assert.equal(sessionExpiryShouldNotify("checking"), false);
    // The state checkSession lands on when there is no cookie: silent.
    assert.equal(sessionExpiryShouldNotify("anonymous"), false);
    // Gateway down: a distinct state, not an expiry story.
    assert.equal(sessionExpiryShouldNotify("unreachable"), false);
    // Cookie died mid-use: tell the user exactly once.
    assert.equal(sessionExpiryShouldNotify("connected"), true);
  });

  test("consecutive 401s in the same tick notify once (connected → anonymous → silent)", () => {
    // Simulates two parallel page loads both hitting 401 before React
    // re-renders: the handler flips the status ref synchronously after
    // the first one, so the second decision sees "anonymous".
    let status = "connected";
    const notifications: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const notify = sessionExpiryShouldNotify(status);
      notifications.push(notify);
      if (notify) status = "anonymous";
    }
    assert.deepEqual(notifications, [true, false, false]);
  });
});

describe("theme resolution", () => {
  test("stored choice wins, else prefers-color-scheme, dark is the fallback", () => {
    assert.equal(resolveTheme("light", false), "light");
    assert.equal(resolveTheme("dark", true), "dark");
    assert.equal(resolveTheme(null, true), "light");
    assert.equal(resolveTheme(null, false), "dark");
  });
});
