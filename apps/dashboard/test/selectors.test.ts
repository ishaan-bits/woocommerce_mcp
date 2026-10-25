import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolView, UpstreamStatusView } from "../src/api/client.ts";
import {
  filterTools,
  groupToolsByUpstream,
  matchesToolSearch,
  sanitizeError,
  toolCountSummary,
  upstreamHealth,
  upstreamHealthText,
  upstreamHealthTone,
  upstreamStatsSummary,
} from "../src/lib/selectors.ts";

function status(overrides: Partial<UpstreamStatusView> = {}): UpstreamStatusView {
  return { id: "woocommerce", configured: true, enabled: true, reachable: true, last_error: null, ...overrides };
}

function tool(overrides: Partial<ToolView> = {}): ToolView {
  return {
    qualified_name: "woocommerce_list_products",
    name: "list_products",
    upstream_id: "woocommerce",
    description: "List products",
    input_schema: {},
    ...overrides,
  };
}

describe("upstream health labels", () => {
  test("configured/enabled/reachable map to four distinct states", () => {
    assert.equal(upstreamHealth(status({ configured: false, enabled: false, reachable: false })), "missing");
    assert.equal(upstreamHealth(status({ enabled: false, reachable: false })), "disabled");
    assert.equal(upstreamHealth(status({ reachable: false, last_error: "boom" })), "degraded");
    assert.equal(upstreamHealth(status()), "healthy");
  });

  test("text and tone are distinct per state", () => {
    assert.equal(upstreamHealthText(status({ configured: false })), "Missing (not configured)");
    assert.equal(upstreamHealthText(status({ enabled: false })), "Disabled");
    assert.equal(upstreamHealthText(status({ reachable: false })), "Degraded (unreachable)");
    assert.equal(upstreamHealthText(status()), "Healthy");
    assert.equal(upstreamHealthTone("healthy"), "success");
    assert.equal(upstreamHealthTone("disabled"), "neutral");
    assert.equal(upstreamHealthTone("degraded"), "error");
    assert.equal(upstreamHealthTone("missing"), "warn");
  });
});

describe("sanitizeError", () => {
  test("strips URLs so internal addresses never reach the UI", () => {
    assert.equal(sanitizeError("connect ECONNREFUSED http://10.0.0.5:9000/mcp"), "connect ECONNREFUSED [url]");
    assert.equal(sanitizeError("timeout to https://internal.corp.local:8443/x"), "timeout to [url]");
  });

  test("truncates long errors and maps null/blank to null", () => {
    assert.equal(sanitizeError(null), null);
    assert.equal(sanitizeError(""), null);
    assert.equal(sanitizeError("   "), null);
    const long = sanitizeError("y".repeat(500));
    assert.ok(long !== null && long.length === 160 && long.endsWith("…"));
  });
});

describe("grouping and filtering", () => {
  const statuses = [status(), status({ id: "inventory" }), status({ id: "support", configured: false })];
  const tools = [
    tool(),
    tool({ qualified_name: "woocommerce_get_order", name: "get_order" }),
    tool({ qualified_name: "inventory_check_stock", name: "check_stock", upstream_id: "inventory", description: "Stock levels" }),
  ];

  test("groupToolsByUpstream preserves status order and attaches tools", () => {
    const grouped = groupToolsByUpstream(statuses, tools);
    assert.deepEqual(
      grouped.map((entry) => entry.id),
      ["woocommerce", "inventory", "support"],
    );
    assert.equal(grouped[0]?.tools.length, 2);
    assert.equal(grouped[1]?.tools.length, 1);
    assert.deepEqual(grouped[2]?.tools, [], "unconfigured upstream groups as empty");
  });

  test("search matches qualified name, local name or description, case-insensitively", () => {
    assert.ok(matchesToolSearch(tool(), "WOOCOMMERCE_LIST"));
    assert.ok(matchesToolSearch(tool(), "list_prod"));
    assert.ok(matchesToolSearch(tool(), "list products"));
    assert.ok(!matchesToolSearch(tool(), "orders"));
    assert.ok(matchesToolSearch(tool(), "   "), "blank needle matches all");
  });

  test("filterTools combines upstream filter and search", () => {
    assert.equal(filterTools(tools, {}).length, 3);
    assert.equal(filterTools(tools, { upstreamId: "woocommerce" }).length, 2);
    assert.equal(filterTools(tools, { search: "stock" }).length, 1);
    assert.equal(filterTools(tools, { search: "stock", upstreamId: "woocommerce" }).length, 0);
    assert.equal(filterTools(tools, { search: "zzz" }).length, 0);
  });

  test("toolCountSummary shows 'N of M' only when filtered", () => {
    assert.equal(toolCountSummary(5, 5), "5 tools");
    assert.equal(toolCountSummary(2, 5), "2 of 5 tools");
    assert.equal(toolCountSummary(0, 0), "0 tools");
  });
});

describe("upstreamStatsSummary (observability line)", () => {
  test("absent stats render nothing (never invented numbers)", () => {
    assert.equal(upstreamStatsSummary(undefined), null);
    assert.equal(upstreamStatsSummary(null), null);
  });

  test("an upstream that was never called says so", () => {
    assert.equal(
      upstreamStatsSummary({ calls: 0, errors: 0, avgDurationMs: 0, lastCalledAt: null }),
      "No tool calls yet",
    );
  });

  test("calls, errors, latency and last-call time summarise on one line", () => {
    const line = upstreamStatsSummary({
      calls: 42,
      errors: 2,
      avgDurationMs: 120,
      lastCalledAt: "2026-10-26T10:31:05.000Z",
    });
    assert.ok(line !== null);
    assert.ok(line.startsWith("42 calls · 2 errors · avg 120 ms · last "), line);
    assert.equal(
      upstreamStatsSummary({ calls: 1, errors: 0, avgDurationMs: 5, lastCalledAt: null }),
      "1 call · 0 errors · avg 5 ms",
    );
  });
});
