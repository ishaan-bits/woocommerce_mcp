import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  confirmedEndpoint,
  curlSnippet,
  ENDPOINT_EXAMPLES,
  inspectorSnippet,
  isExampleEndpoint,
  jsonClientSnippet,
  type SettingsLike,
} from "../src/lib/settings.ts";

const published: SettingsLike = {
  mcp_endpoint: "https://gateway.example.com/mcp",
  mcp_path: "/mcp",
  transport: "streamable-http",
  auth: "bearer",
  session_header: "mcp-session-id",
  chat_enabled: true,
};

const unknown: SettingsLike = { ...published, mcp_endpoint: null };

describe("settings snippet builders", () => {
  test("confirmedEndpoint returns the published URL, trimming a trailing slash", () => {
    assert.equal(confirmedEndpoint(published), "https://gateway.example.com/mcp");
    assert.equal(confirmedEndpoint({ ...published, mcp_endpoint: "https://x.example/mcp/" }), "https://x.example/mcp");
    assert.equal(confirmedEndpoint(unknown), null);
    assert.equal(confirmedEndpoint({ ...published, mcp_endpoint: "   " }), null);
  });

  test("isExampleEndpoint is true only when nothing is published", () => {
    assert.equal(isExampleEndpoint(published), false);
    assert.equal(isExampleEndpoint(unknown), true);
  });

  test("curl snippet includes Bearer auth and the streamable-http Accept header", () => {
    const snippet = curlSnippet(published);
    assert.ok(snippet.includes('POST "https://gateway.example.com/mcp"'));
    assert.ok(snippet.includes("Authorization: Bearer <YOUR_KEY>"));
    assert.ok(snippet.includes("Accept: application/json, text/event-stream"));
    assert.ok(snippet.includes('"method":"initialize"'));
    assert.ok(!snippet.includes("umk_"), "no real key material ever appears");
  });

  test("curl snippet falls back to a clearly-example local URL when endpoint is null", () => {
    const snippet = curlSnippet(unknown);
    assert.ok(snippet.includes("127.0.0.1:8080/mcp"), "example, never invented as confirmed");
    assert.ok(snippet.includes("Authorization: Bearer <YOUR_KEY>"));
  });

  test("inspector snippet matches the documented CLI shape", () => {
    const snippet = inspectorSnippet(published);
    assert.equal(
      snippet,
      'npx @modelcontextprotocol/inspector --transport http https://gateway.example.com/mcp --header "Authorization: Bearer <YOUR_KEY>"',
    );
    const fallback = inspectorSnippet(unknown);
    assert.ok(fallback.includes(ENDPOINT_EXAMPLES[0]?.split(/\s+/)[0] ?? ""));
  });

  test("JSON client snippet is valid JSON with url + auth header and a placeholder key", () => {
    const parsed = JSON.parse(jsonClientSnippet(published)) as {
      mcpServers: { urumi: { url: string; headers: Record<string, string> } };
    };
    assert.equal(parsed.mcpServers.urumi.url, "https://gateway.example.com/mcp");
    assert.equal(parsed.mcpServers.urumi.headers.Authorization, "Bearer <YOUR_KEY>");
    // And the null-endpoint fallback still parses.
    assert.doesNotThrow(() => JSON.parse(jsonClientSnippet(unknown)));
  });

  test("ENDPOINT_EXAMPLES are labelled examples, not confirmed URLs", () => {
    assert.ok(ENDPOINT_EXAMPLES.length >= 3);
    for (const example of ENDPOINT_EXAMPLES) {
      assert.ok(/local port-forward|NodePort|GATEWAY_PUBLIC_URL/.test(example), example);
    }
  });
});
