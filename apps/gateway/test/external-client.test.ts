import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Phase E — external MCP client compatibility against a LIVE gateway.
 *
 * Everything else in this suite talks to an in-process harness (see
 * test/mcp-protocol.test.ts). This file is different on purpose: it runs the
 * OFFICIAL MCP TypeScript SDK exactly the way a third-party client would
 * (initialize → tools/list → tools/call over Streamable HTTP with a Bearer
 * key) against whatever gateway GATEWAY_URL points at — the deployed
 * Kubernetes service via port-forward in the demo, a local `npm run dev`
 * gateway otherwise.
 *
 * Gated like scripts/llm-smoke.sh: with no GATEWAY_URL / GATEWAY_API_KEY the
 * suite is EXPLICITLY skipped with a printed reason (never silently), so the
 * default `npm test` and check.sh stay self-contained.
 *
 * The key is read from the environment and never logged, asserted on, or
 * included in failure messages.
 */

const gatewayUrl = (process.env.GATEWAY_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.GATEWAY_API_KEY ?? "";

const SKIP_REASON =
  "GATEWAY_URL and/or GATEWAY_API_KEY is not set - external MCP client test EXPLICITLY SKIPPED; " +
  "point GATEWAY_URL at a running gateway (e.g. http://127.0.0.1:8080 via kubectl port-forward) " +
  "and GATEWAY_API_KEY at one of its keys to run it";

interface TextContentLike {
  type?: string;
  text?: string;
}

function firstText(result: unknown): string {
  const content = (result as { content?: readonly TextContentLike[] }).content;
  const block = content?.find((entry) => entry.type === "text" && typeof entry.text === "string");
  assert.ok(block?.text, "expected at least one text content block");
  return block.text;
}

describe(
  "external MCP client compatibility (official SDK against a live gateway)",
  { skip: gatewayUrl !== "" && apiKey !== "" ? false : SKIP_REASON },
  () => {
    async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
      const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      });
      const client = new Client({ name: "external-client-check", version: "1.0.0" });
      await client.connect(transport);
      return { client, transport };
    }

    test("initialize handshake and tools/list over Streamable HTTP", async () => {
      const { client } = await connect();
      try {
        const { tools } = await client.listTools();
        assert.ok(tools.length > 0, "a valid key must see the aggregated catalogue");
        const qualified = tools.map((tool) => tool.name);
        assert.equal(new Set(qualified).size, qualified.length, "qualified names are unique");
        const woo = tools.find((tool) => tool.name === "woocommerce_list_products");
        assert.ok(woo, "the gateway's flagship tool must be discoverable");
        assert.ok(woo.description, "tool specs carry descriptions");
      } finally {
        await client.close();
      }
    });

    test("tools/call reaches an upstream and answers with a protocol-valid result", async () => {
      const { client } = await connect();
      try {
        const result = await client.callTool({ name: "woocommerce_list_products", arguments: {} });
        // Tool-level errors are still protocol-valid (isError), and so is a
        // JSON-RPC McpError (e.g. a key without the woocommerce grant —
        // gateway error -32003). Anything else (HTML 500, parse failure,
        // non-McpError) means an incompatible server and must fail here.
        if (result.isError === true) {
          assert.ok(firstText(result).length > 0, "tool-level errors carry a message");
          return;
        }
        const payload = JSON.parse(firstText(result));
        // Canonical shape: { products: [...], pagination: {...} }.
        const products = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.products)
            ? payload.products
            : null;
        assert.ok(products, "woocommerce_list_products returns a products array");
        for (const product of products.slice(0, 5)) {
          assert.equal(typeof product.name, "string");
          assert.equal(typeof product.sku, "string");
        }
      } catch (error) {
        assert.ok(
          error instanceof McpError,
          `expected a JSON-RPC McpError (server-expressed refusal), got: ${String(error)}`,
        );
        assert.match(
          error.message,
          /not granted|forbidden|denied/i,
          `unexpected McpError from the gateway: ${error.message}`,
        );
      } finally {
        await client.close();
      }
    });

    test("DoD D6: one session reaches TWO different upstreams (two-upstream prompt)", async () => {
      const { client } = await connect();
      try {
        const { tools } = await client.listTools();
        const prefixes = new Set(tools.map((tool) => tool.name.split("_")[0]));
        assert.ok(prefixes.size >= 2, "the key must see tools from at least two upstreams");

        // The demo prompt: "compare products and orders" style — one question,
        // tools from two upstreams, one session, one key. The demo member key
        // is granted both reads; a denial here means the key lacks grants.
        const calls: Array<[string, string]> = [
          ["woocommerce_list_products", "woocommerce"],
          ["inventory_list_products", "inventory"],
        ];
        const reached = new Set<string>();
        for (const [name, upstream] of calls) {
          if (!tools.some((tool) => tool.name === name)) continue;
          const result = await client.callTool({ name, arguments: {} });
          if (result.isError === true) {
            const message = firstText(result);
            assert.ok(
              !/not granted|denied/i.test(message),
              `the demo key must be granted ${name} for the two-upstream prompt — got: ${message}`,
            );
            assert.fail(`${name} failed on a live gateway: ${message}`);
          }
          reached.add(upstream);
        }
        assert.ok(
          reached.has("woocommerce") && reached.has("inventory"),
          `expected calls to both upstreams in one session, reached: ${JSON.stringify([...reached])}`,
        );
      } finally {
        await client.close();
      }
    });
  },
);
