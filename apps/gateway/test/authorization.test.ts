import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApiKeyPrincipal } from "@mcp/shared";
import { authorizeAdminApi, authorizeToolCall, isWriteLocalName } from "../src/auth/authorization.ts";

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    displayName: "test-user",
    role: "admin",
    allowedUpstreams: ["woocommerce", "inventory", "support"],
    allowedTools: ["tools:woocommerce_list_products", "tools:inventory_adjust_stock", "tools:support_create_ticket"],
    keyId: "00000000-0000-4000-8000-000000000000",
    ...overrides,
  };
}

describe("tool call authorization (C2/C5)", () => {
  test("admin with upstream and tool grants may call read and write tools", () => {
    assert.deepEqual(authorizeToolCall(principal(), "woocommerce_list_products"), {
      allowed: true,
      errorCode: null,
      reason: null,
    });
    assert.deepEqual(authorizeToolCall(principal(), "inventory_adjust_stock"), {
      allowed: true,
      errorCode: null,
      reason: null,
    });
  });

  test("the reader role is a ceiling over grants: write tools are denied even when granted", () => {
    const reader = principal({ role: "reader" });
    const decision = authorizeToolCall(reader, "inventory_adjust_stock");
    assert.equal(decision.allowed, false);
    assert.equal(decision.errorCode, "role_forbidden");
    // The grant list itself contains inventory_adjust_stock — the role ceiling fires first.
    assert.ok(reader.allowedTools.includes("tools:inventory_adjust_stock"));
  });

  test("reader may call read tools that are granted", () => {
    const reader = principal({ role: "reader", allowedUpstreams: ["woocommerce"] });
    assert.equal(authorizeToolCall(reader, "woocommerce_list_products").allowed, true);
  });

  test("a missing upstream grant denies before the tool grant is consulted", () => {
    const p = principal({ allowedUpstreams: ["woocommerce"] });
    const decision = authorizeToolCall(p, "inventory_list_products");
    assert.equal(decision.allowed, false);
    assert.equal(decision.errorCode, "grant_forbidden");
    assert.match(decision.reason ?? "", /upstream 'inventory' is not granted/);
  });

  test("REGRESSION: grants bind admins too — there is no admin bypass (the dashboard indicator mirrors this)", () => {
    // principal() defaults to role "admin"; /api/keys also creates admin keys
    // with empty grants by default. Every call must still pass the grant
    // checks — the dashboard's tool-permission indicator asserts the same
    // matrix in apps/dashboard/test/permissions.test.ts (keep in sync).
    const bareAdmin = principal({ allowedUpstreams: [], allowedTools: [] });
    assert.equal(bareAdmin.role, "admin");
    const decision = authorizeToolCall(bareAdmin, "woocommerce_list_products");
    assert.equal(decision.allowed, false);
    assert.equal(decision.errorCode, "grant_forbidden");
    // Write ceiling stays reader-only: a granted admin may call write tools.
    const granted = principal({ allowedUpstreams: ["woocommerce"], allowedTools: ["tools:woocommerce_create_product"] });
    assert.equal(authorizeToolCall(granted, "woocommerce_create_product").allowed, true);
    assert.equal(authorizeToolCall(principal({ role: "reader", allowedUpstreams: ["woocommerce"], allowedTools: ["tools:woocommerce_create_product"] }), "woocommerce_create_product").errorCode, "role_forbidden");
  });

  test("a missing exact tool grant denies even when the upstream is granted", () => {
    const p = principal({ allowedTools: ["tools:woocommerce_list_products"] });
    const decision = authorizeToolCall(p, "woocommerce_get_order");
    assert.equal(decision.allowed, false);
    assert.equal(decision.errorCode, "grant_forbidden");
    assert.match(decision.reason ?? "", /tool 'woocommerce_get_order' is not granted/);
  });

  test("unparseable tool names are handed to the registry's unknown_tool path, not denied here", () => {
    for (const name of ["list_products", "woocommerce_", "mystery_list_products", "", "woocommerce"]) {
      assert.deepEqual(authorizeToolCall(principal({ allowedUpstreams: [] }), name), {
        allowed: true,
        errorCode: null,
        reason: null,
      });
    }
  });

  test("denials never echo secrets, headers or arguments", () => {
    const decision = authorizeToolCall(principal({ allowedUpstreams: [] }), "woocommerce_list_products");
    const reason = decision.reason ?? "";
    assert.ok(!/umk_|Bearer|pepper/i.test(reason));
  });
});

describe("write-verb ceiling (C2)", () => {
  test("recognises write verbs and leaves reads alone", () => {
    for (const name of ["create_order", "update_stock", "delete_product", "remove_item", "patch_customer", "put_record", "insert_row", "adjust_stock", "set_status"]) {
      assert.equal(isWriteLocalName(name), true, name);
    }
    for (const name of ["list_products", "get_order", "create", "update", "created_by", "listed_items"]) {
      assert.equal(isWriteLocalName(name), false, name);
    }
  });
});

describe("admin API gate (C2)", () => {
  test("admin passes, reader is denied with role_forbidden", () => {
    assert.deepEqual(authorizeAdminApi(principal()), { allowed: true, errorCode: null, reason: null });
    const decision = authorizeAdminApi(principal({ role: "reader" }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.errorCode, "role_forbidden");
  });
});
