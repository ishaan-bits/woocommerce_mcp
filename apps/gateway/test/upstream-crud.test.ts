import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../src/logger.ts";
import { createCredentialVault } from "../src/upstream-credentials.ts";
import { ADMIN_USER_ID, startGatewayHarness, type GatewayHarness } from "./helpers/gateway-harness.ts";
import { FakeDynamicUpstreamRepository } from "./helpers/fake-repos.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";

/** Test-only vault key (32 bytes). Never a production secret. */
const VAULT_KEY = Buffer.alloc(32, 7);

interface HarnessOptions {
  repo?: FakeDynamicUpstreamRepository;
  vault?: ReturnType<typeof createCredentialVault>;
  lines?: string[];
  config?: Record<string, unknown>;
}

async function start(options: HarnessOptions = {}): Promise<{ harness: GatewayHarness; repo: FakeDynamicUpstreamRepository; lines: string[] }> {
  const repo = options.repo ?? new FakeDynamicUpstreamRepository();
  const lines = options.lines ?? [];
  const harness = await startGatewayHarness({
    dynamicUpstreamRepo: repo,
    credentialVault: options.vault === undefined ? createCredentialVault(VAULT_KEY) : options.vault,
    logger: createLogger({ level: "debug", sink: { write: (line) => lines.push(line) } }),
    config: {
      upstreamAllowedPrivateHosts: ["127.0.0.1"],
      ...options.config,
    } as never,
  });
  return { harness, repo, lines };
}

async function api(
  harness: GatewayHarness,
  method: string,
  path: string,
  key: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.origin}/api${path}`, {
    method,
    headers: {
      // key === undefined means anonymous: send NO authorization header.
      ...(key === undefined ? {} : harness.authHeaders(key)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("admin upstream management (D34)", () => {
  test("members and anonymous callers cannot manage upstreams; the failure is audited", async () => {
    const { harness, repo } = await start();
    try {
      const anon = await api(harness, "POST", "/upstreams", undefined, { name: "Evil", url: "http://127.0.0.1:9/mcp" });
      assert.equal(anon.status, 401);

      const member = await api(harness, "POST", "/upstreams", harness.readerKey, {
        name: "Evil",
        url: "http://127.0.0.1:9/mcp",
      });
      assert.equal(member.status, 403);
      assert.deepEqual(await repo.list(), [], "no row was written");
      assert.ok(harness.auditRepo.entries.some((entry) => entry.action === "access_denied" && entry.role === "reader"));
    } finally {
      await harness.close();
    }
  });

  test("admin creates a server (no credential): row persisted, live in the registry, listed with source admin", async () => {
    const { harness, repo } = await start();
    try {
      const created = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.id, "acme-shop");
      assert.equal(created.json.source, "admin");
      assert.equal(created.json.has_credential, false);
      assert.equal(created.json.enabled, true);

      const row = await repo.findById("acme-shop");
      assert.ok(row !== null);
      assert.equal(row.url, "http://127.0.0.1:9/mcp");
      assert.equal(row.credentialCipher, null);

      // Registered live: the id is now part of the tool-name universe.
      assert.ok(harness.registry.upstreamIds().includes("acme-shop"));

      const list = await api(harness, "GET", "/upstreams", harness.adminKey);
      const entries = (list.json.upstreams as Array<Record<string, unknown>>).map((entry) => entry.id);
      assert.deepEqual(entries, ["woocommerce", "inventory", "support", "acme-shop"]);

      assert.ok(harness.auditRepo.entries.some((entry) => entry.action === "upstream_created" && entry.upstreamId === "acme-shop"));
    } finally {
      await harness.close();
    }
  });

  test("create is idempotent by URL: a second create with the same URL is a 409, not a duplicate row", async () => {
    const { harness, repo } = await start();
    try {
      const first = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
      });
      assert.equal(first.status, 201);
      const second = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop Copy",
        url: "http://127.0.0.1:9/mcp",
      });
      assert.equal(second.status, 409);
      assert.equal((await repo.list()).length, 1);
    } finally {
      await harness.close();
    }
  });

  test("URL validation applies the C4 private-address allow-list and the TLS policy", async () => {
    const { harness } = await start();
    try {
      // Link-local metadata address: never allowed (not on the allow-list).
      const metadata = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Metadata",
        url: "http://169.254.169.254/mcp",
      });
      assert.equal(metadata.status, 400);
      assert.match(String(metadata.json.error), /non-routable|https/);
    } finally {
      await harness.close();
    }

    const httpsOnly = await start({ config: { dynamicUpstreamTlsPolicy: "https-only" } });
    try {
      const plain = await api(httpsOnly.harness, "POST", "/upstreams", httpsOnly.harness.adminKey, {
        name: "Plain HTTP",
        url: "http://127.0.0.1:9/mcp",
      });
      assert.equal(plain.status, 400);
      assert.match(String(plain.json.error), /https/);
    } finally {
      await httpsOnly.harness.close();
    }
  });

  test("encrypted credential: stored as ciphertext only, redacted from responses and logs", async () => {
    const { harness, repo, lines } = await start();
    try {
      const secret = "sk-live-abcdef-secret-value";
      const created = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
        credential: { mode: "bearer", value: secret },
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.has_credential, true);
      assert.equal(created.json.credential_mode, "bearer");
      assert.ok(!JSON.stringify(created.json).includes(secret), "response must not echo the credential");

      const row = await repo.findById("acme-shop");
      assert.ok(row !== null && row.credentialCipher !== null);
      assert.ok(!row.credentialCipher.includes(Buffer.from(secret, "utf8")), "DB stores ciphertext, not plaintext");

      // Admin list view exposes has_credential only — never the value.
      const list = await api(harness, "GET", "/upstreams", harness.adminKey);
      const entry = (list.json.upstreams as Array<Record<string, unknown>>).find((item) => item.id === "acme-shop");
      assert.equal(entry?.has_credential, true);
      assert.equal(entry?.url, "http://127.0.0.1:9/mcp");
      assert.ok(!JSON.stringify(list.json).includes(secret));

      // Nothing in the captured logs carries the secret either.
      assert.ok(
        lines.every((line) => !line.includes(secret)),
        "gateway logs must never contain the credential value",
      );

      // The audit trail records the action, not the secret.
      assert.ok(harness.auditRepo.entries.every((entry_) => !JSON.stringify(entry_).includes(secret)));
    } finally {
      await harness.close();
    }
  });

  test("credential without a configured vault fails closed with 503 and writes nothing", async () => {
    const { harness, repo } = await start({ vault: null });
    try {
      const created = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
        credential: { mode: "bearer", value: "tok" },
      });
      assert.equal(created.status, 503);
      assert.equal(created.json.error, "credential_vault_unavailable");
      assert.deepEqual(await repo.list(), []);
    } finally {
      await harness.close();
    }
  });

  test("without the dynamic repository the whole feature is 503 (not a silent no-op)", async () => {
    const harness = await startGatewayHarness({ config: { upstreamAllowedPrivateHosts: ["127.0.0.1"] } as never });
    try {
      const created = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
      });
      assert.equal(created.status, 503);
      assert.equal(created.json.error, "dynamic_upstreams_unavailable");
    } finally {
      await harness.close();
    }
  });

  test("edit: rename/re-url plus three-state credential patch; fixed ids and unknown ids are refused", async () => {
    const { harness, repo } = await start();
    try {
      await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
      });

      // Set a credential (replace-nothing → set).
      const setCred = await api(harness, "PUT", "/upstreams/acme-shop", harness.adminKey, {
        credential: { mode: "header", value: "tok-1", header: "x-api-key" },
      });
      assert.equal(setCred.status, 200);
      assert.equal(setCred.json.has_credential, true);
      const afterSet = await repo.findById("acme-shop");
      const cipherAfterSet = afterSet?.credentialCipher;

      // Omitted credential = unchanged (identical ciphertext).
      const rename = await api(harness, "PUT", "/upstreams/acme-shop", harness.adminKey, { name: "Acme Emporium" });
      assert.equal(rename.status, 200);
      assert.equal(rename.json.name, "Acme Emporium");
      const afterRename = await repo.findById("acme-shop");
      assert.deepEqual(afterRename?.credentialCipher, cipherAfterSet);

      // Explicit null clears it.
      const clear = await api(harness, "PUT", "/upstreams/acme-shop", harness.adminKey, { credential: null });
      assert.equal(clear.status, 200);
      assert.equal(clear.json.has_credential, false);
      assert.equal((await repo.findById("acme-shop"))?.credentialCipher, null);

      // Fixed deploy-time ids are immutable through this surface.
      const fixed = await api(harness, "PUT", "/upstreams/woocommerce", harness.adminKey, { name: "Nope" });
      assert.equal(fixed.status, 409);
      const fixedDelete = await api(harness, "DELETE", "/upstreams/woocommerce", harness.adminKey);
      assert.equal(fixedDelete.status, 409);

      // Unknown ids are 404, not 500.
      const unknown = await api(harness, "PUT", "/upstreams/nope", harness.adminKey, { name: "Nope" });
      assert.equal(unknown.status, 404);

      assert.ok(harness.auditRepo.entries.some((entry) => entry.action === "upstream_updated" && entry.upstreamId === "acme-shop"));
    } finally {
      await harness.close();
    }
  });

  test("delete removes the row and unregisters the server; enable/disable persists through the dynamic table", async () => {
    const { harness, repo } = await start();
    try {
      await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
      });

      const disabled = await api(harness, "POST", "/upstreams/acme-shop:disable", harness.adminKey);
      assert.equal(disabled.status, 200);
      assert.equal(disabled.json.enabled, false);
      assert.equal((await repo.findById("acme-shop"))?.enabled, false);
      assert.equal(harness.registry.health().find((entry) => entry.id === "acme-shop")?.enabled, false);

      // Idempotent: no audit row for a no-op toggle.
      const auditsBefore = harness.auditRepo.entries.filter((entry) => entry.action === "upstream_disabled").length;
      const repeat = await api(harness, "POST", "/upstreams/acme-shop:disable", harness.adminKey);
      assert.equal(repeat.status, 200);
      assert.equal(repeat.json.changed, false);
      assert.equal(
        harness.auditRepo.entries.filter((entry) => entry.action === "upstream_disabled").length,
        auditsBefore,
      );

      const enabled = await api(harness, "POST", "/upstreams/acme-shop:enable", harness.adminKey);
      assert.equal(enabled.json.enabled, true);
      assert.equal((await repo.findById("acme-shop"))?.enabled, true);

      const removed = await api(harness, "DELETE", "/upstreams/acme-shop", harness.adminKey);
      assert.equal(removed.status, 200);
      assert.equal(removed.json.deleted, true);
      assert.equal(await repo.findById("acme-shop"), null);
      assert.ok(!harness.registry.upstreamIds().includes("acme-shop"));
      assert.ok(harness.auditRepo.entries.some((entry) => entry.action === "upstream_deleted" && entry.upstreamId === "acme-shop"));
    } finally {
      await harness.close();
    }
  });

  test("golden path: a registered server's tools are hidden until granted, then listed and callable (stand-out 2)", async () => {
    const { harness, repo } = await start();
    const fake = await startFakeUpstream({
      name: "acme-fake",
      tools: [{ name: "list_widgets", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    });
    try {
      const created = await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Widgets",
        url: fake.mcpUrl,
        credential: { mode: "bearer", value: "wire-token" },
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);

      // Stand-out 2: tools the caller may not use are HIDDEN from tools/list
      // (the same authorize predicate guards discovery and execution), so the
      // ungranted dynamic tool is invisible even though the upstream is live.
      const listed = await harness.client.listTools();
      assert.ok(
        !listed.tools.some((tool) => tool.name === `${id}_list_widgets`),
        "ungranted tools must be hidden from the tool list",
      );

      // If it were called anyway (e.g. a stale cached name), the call is
      // still denied with the standard permission-denied protocol error.
      let denied: unknown = null;
      try {
        await harness.client.callTool({ name: `${id}_list_widgets`, arguments: {} });
      } catch (error) {
        denied = error;
      }
      assert.ok(denied !== null, "expected a permission denial for the ungranted dynamic tool");
      assert.equal((denied as { code?: number }).code, -32003);

      // Grant the upstream + tool to the admin user (fixed ∪ dynamic ids are
      // both valid in allowed_upstreams now), then the call succeeds.
      const patched = await api(harness, "PATCH", `/users/${ADMIN_USER_ID}`, harness.adminKey, {
        allowed_upstreams: ["woocommerce", "inventory", "support", id],
        allowed_tools: ["tools:woocommerce_list_products", `tools:${id}_list_widgets`],
      });
      assert.equal(patched.status, 200);

      // Reconnect the harness client so the principal picks up the new grants.
      await harness.client.close();
      const client = new Client({ name: "harness-client-2", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${harness.adminKey}` } },
        }),
      );
      // Now that the grant exists, the same tool is visible in tools/list.
      const listedAfterGrant = await client.listTools();
      assert.ok(
        listedAfterGrant.tools.some((tool) => tool.name === `${id}_list_widgets`),
        "granted tools must appear in the tool list",
      );
      const called = await client.callTool({ name: `${id}_list_widgets`, arguments: { q: "x" } });
      assert.notEqual(called.isError, true);
      await client.close();

      // The fake upstream received the bearer credential on the wire.
      assert.ok(
        fake.seenAuthHeaders.some((headers) => headers.authorization === "Bearer wire-token"),
        `expected the credential header on the wire, saw: ${JSON.stringify(fake.seenAuthHeaders)}`,
      );

      // After delete the tools disappear for the next list.
      const removed = await api(harness, "DELETE", `/upstreams/${id}`, harness.adminKey);
      assert.equal(removed.status, 200);
      assert.equal((await repo.findById(id)), null);
    } finally {
      await fake.close();
      await harness.close();
    }
  });

  test("member sees upstream status without admin-only fields (C4: URLs stay admin-only)", async () => {
    const { harness } = await start();
    try {
      await api(harness, "POST", "/upstreams", harness.adminKey, {
        name: "Acme Shop",
        url: "http://127.0.0.1:9/mcp",
        credential: { mode: "bearer", value: "tok" },
      });
      const member = await api(harness, "GET", "/upstreams", harness.readerKey);
      assert.equal(member.status, 200);
      const entry = (member.json.upstreams as Array<Record<string, unknown>>).find((item) => item.id === "acme-shop");
      assert.ok(entry !== undefined);
      assert.equal(entry.source, "admin");
      assert.equal(entry.display_name ?? entry.name, "Acme Shop");
      assert.ok(!("url" in entry), "members must not see the upstream URL");
      assert.ok(!("has_credential" in entry));
      assert.ok(!JSON.stringify(member.json).includes("tok"));
    } finally {
      await harness.close();
    }
  });
});
