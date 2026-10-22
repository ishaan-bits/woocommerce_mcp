/**
 * Pure Settings snippet builders (test/settings.test.ts). Nothing here is
 * invented: the endpoint is either the deploy-configured public URL from
 * /api/settings, or — when null — clearly-labelled EXAMPLES that are never
 * presented as a confirmed/public address.
 */

export interface SettingsLike {
  mcp_endpoint: string | null;
  mcp_path: string;
  transport: string;
  auth: string;
  session_header: string;
  chat_enabled: boolean;
}

/** The confirmed endpoint, or null when the gateway does not publish one. */
export function confirmedEndpoint(settings: SettingsLike): string | null {
  const endpoint = settings.mcp_endpoint;
  if (endpoint === null || endpoint === undefined || endpoint.trim() === "") {
    return null;
  }
  return endpoint.trim().replace(/\/$/, "");
}

/**
 * Fallback guidance when mcp_endpoint is null. These are EXAMPLES only —
 * the real address is deploy-time configuration (GATEWAY_PUBLIC_URL).
 */
export const ENDPOINT_EXAMPLES: readonly string[] = [
  "http://127.0.0.1:8080/mcp   (local port-forward / dev gateway)",
  "http://<node-ip>:<nodePort>/mcp   (Kubernetes NodePort)",
  "https://gateway.example.com/mcp   (public Ingress / GATEWAY_PUBLIC_URL)",
];

const REDACTED_KEY = "<YOUR_KEY>";

function endpointOrExample(settings: SettingsLike): { text: string; isExample: boolean } {
  const confirmed = confirmedEndpoint(settings);
  return confirmed !== null
    ? { text: confirmed, isExample: false }
    : { text: ENDPOINT_EXAMPLES[0]?.split(/\s+/)[0] ?? "http://127.0.0.1:8080/mcp", isExample: true };
}

/** curl POST initialize with Bearer auth + the streamable-http Accept header. */
export function curlSnippet(settings: SettingsLike): string {
  const { text } = endpointOrExample(settings);
  return [
    `curl -s -X POST "${text}" \\`,
    `  -H "Authorization: Bearer ${REDACTED_KEY}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Accept: application/json, text/event-stream" \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example","version":"0.0.1"}}}'`,
  ].join("\n");
}

/** MCP Inspector one-liner. */
export function inspectorSnippet(settings: SettingsLike): string {
  const { text } = endpointOrExample(settings);
  return `npx @modelcontextprotocol/inspector --transport http ${text} --header "Authorization: Bearer ${REDACTED_KEY}"`;
}

/** Generic JSON client config (any streamable-http MCP client). */
export function jsonClientSnippet(settings: SettingsLike): string {
  const { text } = endpointOrExample(settings);
  return JSON.stringify(
    {
      mcpServers: {
        urumi: {
          // streamable-http, addressed by URL — the common client convention.
          transport: "http",
          url: text,
          headers: { Authorization: `Bearer ${REDACTED_KEY}` },
        },
      },
    },
    null,
    2,
  );
}

export function isExampleEndpoint(settings: SettingsLike): boolean {
  return confirmedEndpoint(settings) === null;
}
