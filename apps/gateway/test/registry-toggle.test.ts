import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startGatewayHarness } from "./helpers/gateway-harness.ts";

function textBlock(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first === undefined || typeof first.text !== "string") {
    throw new Error("expected a text content block");
  }
  return first.text;
}

/**
 * D24 + learning-guide Stage 5 checkpoint: the dashboard toggle is enforced
 * by the *real* registry, so `tools/list` shrinks for a real MCP client the
 * moment an upstream is disabled — and the other upstream keeps working
 * (failure isolation), and the disabled one answers with a structured error
 * instead of disappearing silently.
 */
describe("runtime upstream toggle on the real registry (D24)", () => {
  test("disable shrinks tools/list for a live MCP client; enable restores it; siblings unaffected", async () => {
    const harness = await startGatewayHarness();
    try {
      const before = await harness.client.listTools();
      const beforeNames = before.tools.map((tool) => tool.name);
      assert.ok(beforeNames.some((name) => name.startsWith("woocommerce_")), "woocommerce tools present");
      assert.ok(beforeNames.some((name) => name.startsWith("inventory_")), "inventory tools present");

      // The dashboard toggle path: server-side setEnabled (no client trust).
      const applied = harness.registry.setEnabled("inventory", false);
      assert.equal(applied, true);

      const during = await harness.client.listTools();
      const duringNames = during.tools.map((tool) => tool.name);
      assert.ok(
        duringNames.every((name) => name.startsWith("woocommerce_")),
        `inventory tools must be gone from tools/list, got: ${duringNames.join(", ")}`,
      );

      // Calls to the disabled upstream are rejected with a structured error...
      const denied = await harness.client.callTool({ name: "inventory_list_products", arguments: {} });
      assert.equal(denied.isError, true);
      assert.match(textBlock(denied), /disabled/);

      // ...while the other upstream still executes normally (isolation).
      const working = await harness.client.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.notEqual(working.isError, true);

      // Re-enable and the aggregated list comes back (cache is re-gated live).
      assert.equal(harness.registry.setEnabled("inventory", true), true);
      const after = await harness.client.listTools();
      assert.ok(after.tools.some((tool) => tool.name.startsWith("inventory_")));

      // Unknown ids are refused — the toggle can only target registry members.
      assert.equal(harness.registry.setEnabled("evil" as never, false), false);
    } finally {
      await harness.close();
    }
  });

  test("health() reflects the runtime toggle for /readyz and the dashboard", async () => {
    const harness = await startGatewayHarness();
    try {
      const before = harness.registry.health().find((entry) => entry.id === "woocommerce");
      assert.equal(before?.enabled, true);

      harness.registry.setEnabled("woocommerce", false);
      const after = harness.registry.health().find((entry) => entry.id === "woocommerce");
      assert.equal(after?.enabled, false);
      // Reachability bookkeeping is untouched by a toggle.
      assert.equal(after?.reachable, before?.reachable);
    } finally {
      await harness.close();
    }
  });
});
