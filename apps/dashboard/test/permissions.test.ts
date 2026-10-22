import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canUseTool,
  isLocalEndpoint,
  isToolAllowed,
  isWriteLocalName,
  parseToolName,
  roleLabel,
  storeModeLabel,
  toolPermission,
  upstreamLabel,
  UPSTREAM_IDS,
  WRITE_VERBS,
  type PrincipalLike,
} from "../src/lib/permissions.ts";

function principal(overrides: Partial<PrincipalLike> = {}): PrincipalLike {
  return {
    role: "reader",
    allowed_upstreams: [],
    allowed_tools: [],
    ...overrides,
  };
}

describe("tool permission predicate (mirrors gateway authorization.ts)", () => {
  test("parseToolName splits on the fixed upstream-id prefix", () => {
    assert.deepEqual(parseToolName("woocommerce_list_products"), {
      upstreamId: "woocommerce",
      localName: "list_products",
    });
    assert.deepEqual(parseToolName("inventory_check_stock"), {
      upstreamId: "inventory",
      localName: "check_stock",
    });
    assert.deepEqual(parseToolName("support_create_ticket"), {
      upstreamId: "support",
      localName: "create_ticket",
    });
    assert.equal(parseToolName("unknown_tool"), null);
    assert.equal(parseToolName("woocommerce_"), null, "empty local name is unparseable");
    assert.equal(parseToolName(""), null);
  });

  test("isWriteLocalName recognises the gateway's write-verb ceiling", () => {
    for (const verb of WRITE_VERBS) {
      assert.ok(isWriteLocalName(`${verb}_something`), verb);
    }
    assert.ok(!isWriteLocalName("list_products"));
    assert.ok(!isWriteLocalName("get_order"));
    // "set_" is a write verb; "offset_" must NOT match via a bare prefix check.
    assert.ok(isWriteLocalName("set_status"));
    assert.ok(!isWriteLocalName("listsets"));
  });

  test("REGRESSION: admins are bound by their grants — no bypass in the indicator", () => {
    // The old UI short-circuited role === "admin" to allowed, while the
    // gateway's authorizeToolCall enforces upstream + tool grants for every
    // role (and /api/keys creates admin keys with empty grants by default).
    // The catalogue then showed "allowed" for tools the server denies.
    const bareAdmin = principal({ role: "admin" });
    const decision = canUseTool(bareAdmin, "woocommerce_list_products");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "grant_forbidden");

    const partialAdmin = principal({ role: "admin", allowed_upstreams: ["woocommerce"] });
    assert.equal(
      canUseTool(partialAdmin, "woocommerce_list_products").reason,
      "grant_forbidden",
      "missing tools: grant denies even with the upstream granted",
    );
    assert.equal(
      canUseTool(partialAdmin, "inventory_list_products").reason,
      "grant_forbidden",
      "missing upstream grant denies first",
    );
  });

  test("admin with grants may call read AND write tools (write ceiling is reader-only)", () => {
    const admin = principal({
      role: "admin",
      allowed_upstreams: [...UPSTREAM_IDS],
      allowed_tools: [
        "tools:woocommerce_list_products",
        "tools:woocommerce_create_product",
        "tools:inventory_update_stock",
      ],
    });
    assert.ok(isToolAllowed(admin, "woocommerce_list_products"));
    assert.ok(isToolAllowed(admin, "woocommerce_create_product"), "granted admin may write");
    assert.ok(isToolAllowed(admin, "inventory_update_stock"));
    assert.ok(
      !isToolAllowed(admin, "support_create_ticket"),
      "unlisted tool fails closed for admins too",
    );
  });

  test("dashboard predicate matches the gateway authorization matrix", () => {
    // Same fixtures as apps/gateway/test/authorization.test.ts — keep in sync:
    // gateway decisions use errorCode, the dashboard uses reason; both are the
    // stable codes role_forbidden / grant_forbidden (null/undefined = allowed).
    const fullAdmin = principal({
      role: "admin",
      allowed_upstreams: [...UPSTREAM_IDS],
      allowed_tools: [
        "tools:woocommerce_list_products",
        "tools:inventory_adjust_stock",
        "tools:support_create_ticket",
      ],
    });
    const cases: Array<{
      p: PrincipalLike;
      tool: string;
      code: string | null;
    }> = [
      { p: fullAdmin, tool: "woocommerce_list_products", code: null },
      { p: fullAdmin, tool: "inventory_adjust_stock", code: null },
      { p: principal({ role: "reader", allowed_upstreams: [...UPSTREAM_IDS], allowed_tools: ["tools:inventory_adjust_stock"] }), tool: "inventory_adjust_stock", code: "role_forbidden" },
      { p: principal({ role: "reader", allowed_upstreams: ["woocommerce"], allowed_tools: ["tools:woocommerce_list_products"] }), tool: "woocommerce_list_products", code: null },
      { p: principal({ role: "admin", allowed_upstreams: ["woocommerce"] }), tool: "inventory_list_products", code: "grant_forbidden" },
      { p: principal({ role: "admin", allowed_upstreams: [...UPSTREAM_IDS], allowed_tools: ["tools:woocommerce_list_products"] }), tool: "woocommerce_get_order", code: "grant_forbidden" },
      { p: fullAdmin, tool: "mystery_tool", code: null },
      { p: principal({ role: "admin" }), tool: "woocommerce_list_products", code: "grant_forbidden" },
    ];
    for (const c of cases) {
      const decision = canUseTool(c.p, c.tool);
      if (c.code === null) {
        assert.equal(decision.allowed, true, `${c.tool} should be allowed`);
      } else {
        assert.equal(decision.allowed, false, `${c.tool} should be denied`);
        assert.equal(decision.reason, c.code, `${c.tool}`);
      }
    }
  });

  test("reader: write verb denied before any grant check (role_forbidden)", () => {
    // Fully granted, but the role ceiling still applies — mirrors check order.
    const reader = principal({
      allowed_upstreams: [...UPSTREAM_IDS],
      allowed_tools: ["tools:woocommerce_create_product"],
    });
    const decision = canUseTool(reader, "woocommerce_create_product");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "role_forbidden");
  });

  test("reader: upstream grant required (grant_forbidden)", () => {
    const reader = principal({
      allowed_upstreams: ["inventory"],
      allowed_tools: ["tools:woocommerce_list_products"],
    });
    const decision = canUseTool(reader, "woocommerce_list_products");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "grant_forbidden");
  });

  test("reader: exact tools: grant required even with the upstream granted", () => {
    const reader = principal({ allowed_upstreams: ["woocommerce"] });
    const decision = canUseTool(reader, "woocommerce_list_products");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "grant_forbidden");
  });

  test("reader: fully granted read tool allowed", () => {
    const reader = principal({
      allowed_upstreams: ["woocommerce", "support"],
      allowed_tools: ["tools:woocommerce_list_products", "tools:support_list_tickets"],
    });
    assert.ok(isToolAllowed(reader, "woocommerce_list_products"));
    assert.ok(isToolAllowed(reader, "support_list_tickets"));
    assert.ok(!isToolAllowed(reader, "woocommerce_list_orders"), "unlisted tool fails closed");
  });

  test("unparseable names are not an authorization decision (server answers unknown_tool)", () => {
    const reader = principal();
    assert.ok(isToolAllowed(reader, "totally_mystery_tool"));
  });

  test("toolPermission formats the grant string exactly like the server", () => {
    assert.equal(toolPermission("woocommerce_list_products"), "tools:woocommerce_list_products");
  });

  test("a reader with every grant can read but not write (full mirror scenario)", () => {
    const everything = UPSTREAM_IDS.flatMap((id) => [
      `tools:${id}_list_products`,
      `tools:${id}_check_stock`,
      `tools:${id}_create_ticket`,
    ]);
    const reader = principal({ allowed_upstreams: [...UPSTREAM_IDS], allowed_tools: everything });
    assert.ok(isToolAllowed(reader, "woocommerce_list_products"));
    assert.ok(isToolAllowed(reader, "inventory_check_stock"));
    assert.ok(!isToolAllowed(reader, "woocommerce_create_product"), "write verb blocked by role (even when granted)");
    assert.ok(!isToolAllowed(reader, "support_create_ticket"), "write verb blocked by role (even when granted)");
  });
});

describe("labels and endpoint helpers", () => {
  test("roleLabel turns reader into Member", () => {
    assert.equal(roleLabel("reader"), "Member");
    assert.equal(roleLabel("admin"), "Admin");
    assert.equal(roleLabel("weird"), "weird");
  });

  test("upstreamLabel humanises ids", () => {
    assert.equal(upstreamLabel("woocommerce"), "WooCommerce");
    assert.equal(upstreamLabel("inventory"), "Inventory");
    assert.equal(upstreamLabel("support"), "Support");
    assert.equal(upstreamLabel("custom"), "custom");
  });

  test("storeModeLabel words the woocommerce backing store honestly", () => {
    assert.equal(storeModeLabel("mock"), "Demo mock store");
    assert.equal(storeModeLabel("real"), "Real store");
    assert.equal(storeModeLabel(null), null);
    assert.equal(storeModeLabel(undefined), null);
  });

  test("isLocalEndpoint detects loopback hosts only", () => {
    assert.ok(isLocalEndpoint("http://127.0.0.1:8080/mcp"));
    assert.ok(isLocalEndpoint("http://localhost:8080/mcp"));
    assert.ok(isLocalEndpoint("https://gateway.localhost/mcp"));
    assert.ok(!isLocalEndpoint("https://gateway.example.com/mcp"));
    assert.ok(!isLocalEndpoint(null));
    assert.ok(!isLocalEndpoint(undefined));
    assert.ok(!isLocalEndpoint(""));
    assert.ok(!isLocalEndpoint("not a url"));
  });
});
