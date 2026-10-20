import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WOOCOMMERCE_TOOLS } from "@mcp/shared";
import pg from "pg";
import { createApp } from "../../src/app.ts";
import { createApiRouter } from "../../src/api/routes.ts";
import { createAuditWriter } from "../../src/audit.ts";
import { createAuthMiddleware, principalOf } from "../../src/auth/middleware.ts";
import { generateApiKey } from "../../src/auth/keys.ts";
import { createDatabaseDeps, type DatabaseDeps } from "../../src/db/index.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { createLogger, type Logger } from "../../src/logger.ts";
import { createUpstreamRegistry } from "../../src/upstream-registry.ts";
import { makeConfig, TEST_PEPPER } from "../helpers/config.ts";
import { startFakeUpstream, type FakeToolSpec } from "../helpers/fake-upstream.ts";
import { startMiniApp } from "../helpers/mini-app.ts";

/**
 * REAL PostgreSQL integration (C6 / D7 / architecture §5.4).
 *
 * Gated on TEST_DATABASE_URL, which must point at a DISPOSABLE database
 * (the temporary postgres:17-alpine container this milestone pulls). The
 * suite creates tables, seeds, a cluster role, and drops them afterwards.
 * When the variable is absent the suite is EXPLICITLY skipped with the
 * reason printed — never silently.
 *
 * Everything below (pool, migrations, repositories, middleware, MCP server)
 * is production code; only the upstream MCP server is a local fake.
 */

const SKIP_REASON =
  "TEST_DATABASE_URL is not set - PostgreSQL integration tests EXPLICITLY SKIPPED; " +
  "point TEST_DATABASE_URL at a disposable postgres database to run them";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const RUN = databaseUrl.length > 0;

const APP_PASSWORD = "integration-test-app-role-password";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const READER_ID = "22222222-2222-4222-8222-222222222222";

const WOOCOMMERCE_FAKE_TOOLS: FakeToolSpec[] = [
  ...WOOCOMMERCE_TOOLS.map((name) => ({
    name,
    inputSchema:
      name === "list_products" || name === "list_orders"
        ? { type: "object", properties: {} }
        : { type: "object", properties: { id: { type: "integer" } } },
  })),
];

function countToolCalls(admin: pg.Client): Promise<number> {
  return admin
    .query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'tool_call'`)
    .then((result) => result.rows[0]?.n ?? 0);
}

describe("PostgreSQL integration (real database)", { skip: RUN ? false : SKIP_REASON }, () => {
  let admin!: pg.Client;
  let deps!: DatabaseDeps;
  let logger!: Logger;
  let adminKey = "";
  let adminKeyId = "";

  before(async () => {
    await runMigrations({ databaseUrl, appPassword: APP_PASSWORD, log: () => undefined });
    admin = new pg.Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
    await admin.connect();
    logger = createLogger({ level: "error", sink: { write: () => undefined } });
    deps = createDatabaseDeps(makeConfig({ databaseUrl }));

    // Bootstrap an admin key directly in the database: in production this is
    // an ops step outside the gateway; the HTTP issue path is exercised below.
    const generated = generateApiKey(TEST_PEPPER);
    const created = await deps.authRepo.createKey(ADMIN_ID, generated.keyPrefix, generated.keyHash);
    adminKey = generated.key;
    adminKeyId = created.id;
  });

  after(async () => {
    if (!RUN) {
      return;
    }
    await deps.pool.end();
    try {
      await admin.query(`DROP TABLE IF EXISTS audit_log, api_keys, users, schema_migrations CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS mcp_gateway_app`);
    } catch {
      // Teardown is best-effort; the container/database is disposable anyway.
    }
    await admin.end();
  });

  test("migrations apply idempotently and seed the two demo principals with their grants", async () => {
    const again = await runMigrations({ databaseUrl, appPassword: APP_PASSWORD, log: () => undefined });
    assert.equal(again, undefined);

    const applied = await admin.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
    assert.deepEqual(
      applied.rows.map((row) => row.filename),
      ["001_init.sql"],
    );

    const tables = await admin.query<{ regclass: string | null }>(
      `SELECT to_regclass('public.users')::text AS regclass`,
    );
    assert.equal(tables.rows[0]?.regclass, "users");
    const more = await Promise.all(
      ["api_keys", "audit_log"].map((table) =>
        admin.query<{ regclass: string | null }>(`SELECT to_regclass('public.${table}')::text AS regclass`),
      ),
    );
    assert.deepEqual(more.map((result) => result.rows[0]?.regclass), ["api_keys", "audit_log"]);

    const users = await admin.query<{ display_name: string; role: string; allowed_tools: string[] }>(
      `SELECT display_name, role, allowed_tools FROM users ORDER BY display_name`,
    );
    assert.deepEqual(users.rows, [
      {
        display_name: "admin-demo",
        role: "admin",
        allowed_tools: [
          "tools:woocommerce_list_products",
          "tools:woocommerce_create_product",
          "tools:woocommerce_list_orders",
          "tools:woocommerce_get_order",
          "tools:woocommerce_update_order_status",
        ],
      },
      {
        display_name: "reader-demo",
        role: "reader",
        allowed_tools: ["tools:woocommerce_list_products", "tools:woocommerce_list_orders", "tools:woocommerce_get_order"],
      },
    ]);
  });

  test("key lifecycle, 401/403 semantics and audit rows run against the real tables", async () => {
    const audit = createAuditWriter(deps.auditRepo, logger);
    const mini = await startMiniApp((app) => {
      app.use(createAuthMiddleware({ repo: deps.authRepo, pepper: TEST_PEPPER, audit, logger }));
      app.use(
        "/api",
        createApiRouter({ authRepo: deps.authRepo, auditRepo: deps.auditRepo, audit, pepper: TEST_PEPPER }),
      );
      app.get("/me", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });
    try {
    const origin = mini.origin;

    const call = (method: string, path: string, key?: string, body?: unknown): Promise<Response> =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // The DB-loaded admin key authenticates through the real hash lookup.
    const me = await call("GET", "/me", adminKey);
    assert.equal(me.status, 200);
    const principal = ((await me.json()) as { principal: { userId: string; role: string; keyId: string } | null })
      .principal;
    assert.equal(principal?.userId, ADMIN_ID);
    assert.equal(principal?.role, "admin");
    assert.equal(principal?.keyId, adminKeyId);

    // Missing credentials: identical 401 body.
    const anonymous = await call("GET", "/me");
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "unauthorized" });

    // Issue a reader key through the admin API; plaintext returned once.
    const created = await call("POST", "/api/keys", adminKey, { user_id: READER_ID });
    assert.equal(created.status, 201);
    const issued = (await created.json()) as { id: string; key: string; key_prefix: string };
    assert.ok(issued.key.startsWith("umk_"));

    const readerMe = await call("GET", "/me", issued.key);
    assert.equal(readerMe.status, 200);
    assert.equal(((await readerMe.json()) as { principal: { userId: string } }).principal.userId, READER_ID);

    // Reader is denied the admin surface with 403.
    const forbidden = await call("GET", "/api/keys", issued.key);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "forbidden" });

    // Stored schema: no plaintext column, no plaintext value anywhere.
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys'`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name).sort(),
      ["created_at", "id", "key_hash", "key_prefix", "revoked_at", "user_id"],
    );
    const hashes = await admin.query<{ key_hash: string }>(`SELECT key_hash FROM api_keys`);
    assert.ok(hashes.rows.length >= 2);
    assert.ok(!JSON.stringify(hashes.rows).includes(adminKey));
    assert.ok(!JSON.stringify(hashes.rows).includes(issued.key));
    for (const row of hashes.rows) {
      assert.match(row.key_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(row.key_hash, adminKey);
      assert.notEqual(row.key_hash, issued.key);
    }

    // Revocation takes effect on the next request against the real row.
    const revoked = await call("POST", `/api/keys/${issued.id}/revoke`, adminKey);
    assert.equal(revoked.status, 200);
    const afterRevoke = await call("GET", "/me", issued.key);
    assert.equal(afterRevoke.status, 401);
    assert.deepEqual(await afterRevoke.json(), { error: "unauthorized" });

    // The real audit_log captured the whole lifecycle with exact reasons.
    const actions = await admin.query<{ action: string; outcome: string; error_code: string | null }>(
      `SELECT action, outcome, error_code FROM audit_log ORDER BY id`,
    );
    const has = (action: string, outcome: string, errorCode: string | null): boolean =>
      actions.rows.some(
        (row) => row.action === action && row.outcome === outcome && row.error_code === errorCode,
      );
    assert.ok(has("key_created", "success", null), "key_created audit row");
    assert.ok(has("access_denied", "denied", "role_forbidden"), "access_denied audit row");
    assert.ok(has("auth_failed", "denied", "missing_credentials"), "missing_credentials audit row");
    assert.ok(has("auth_failed", "denied", "revoked_key"), "revoked_key audit row");
    // No full key ever reaches the audit table.
    assert.ok(!JSON.stringify(actions.rows).includes(adminKey));
    assert.ok(!JSON.stringify(actions.rows).includes(issued.key));
    } finally {
      await mini.close();
    }
  });

  test("the audit writer sanitizes and paginates through the real repository", async () => {
    const writer = createAuditWriter(deps.auditRepo, logger);
    await writer.recordToolCall({
      principalKey: adminKeyId,
      userId: ADMIN_ID,
      role: "admin",
      upstreamId: "woocommerce",
      toolName: "list\u0000_products",
      qualifiedName: "woocommerce_list_products",
      outcome: "success",
      durationMs: 12.9,
      errorCode: null,
    });

    const recent = await deps.auditRepo.recent(1);
    const newest = recent[0];
    assert.ok(newest);
    assert.equal(newest.action, "tool_call");
    assert.equal(newest.toolName, "list_products");
    assert.equal(newest.durationMs, 12);
    assert.equal(newest.userId, ADMIN_ID);

    const older = await deps.auditRepo.recent(10, newest.id);
    assert.ok(older.length >= 1);
    assert.ok(older.every((entry) => Number(entry.id) < Number(newest.id)));
    const ids = older.map((entry) => Number(entry.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  });

  test("the runtime role is append-only on audit_log (C6 least privilege)", async () => {
    const appUrl = new URL(databaseUrl);
    appUrl.username = "mcp_gateway_app";
    appUrl.password = APP_PASSWORD;
    const roleClient = new pg.Client({ connectionString: appUrl.toString(), statement_timeout: 10_000 });
    await roleClient.connect();
    try {
      // INSERT is granted (the writer needs it).
      await roleClient.query(
        `INSERT INTO audit_log (action, outcome, error_code) VALUES ('tool_call', 'success', 'role_grant_probe')`,
      );

      // DELETE must be denied: audit rows are append-only.
      await assert.rejects(
        () => roleClient.query(`DELETE FROM audit_log`),
        (error: unknown) => (error as { code?: string }).code === "42501",
        "DELETE on audit_log must be insufficient_privilege",
      );

      // Rewriting stored key material must be denied.
      await assert.rejects(
        () => roleClient.query(`UPDATE api_keys SET key_hash = 'deadbeef'`),
        (error: unknown) => (error as { code?: string }).code === "42501",
        "UPDATE of key_hash must be insufficient_privilege",
      );

      // Column-limited revocation update stays possible (C1).
      const probe = await roleClient.query(
        `UPDATE api_keys SET revoked_at = NULL WHERE id = '00000000-0000-4000-8000-000000000000'`,
      );
      assert.equal(probe.rowCount, 0);

      // Reads are granted.
      await roleClient.query(`SELECT id FROM users`);
      await roleClient.query(`SELECT id FROM api_keys`);
    } finally {
      await roleClient.end();
    }

    // Remove the probe row using the admin connection.
    await admin.query(`DELETE FROM audit_log WHERE error_code = 'role_grant_probe'`);
  });

  test("MCP tool calls write exactly one audit row per call into PostgreSQL (§5.4)", async () => {
    const fake = await startFakeUpstream({ name: "woocommerce-fake", tools: WOOCOMMERCE_FAKE_TOOLS });
    const config = makeConfig({
      databaseUrl,
      upstreams: [
        { id: "woocommerce", baseUrl: fake.mcpUrl, enabled: true, timeoutMs: 5_000, connectTimeoutMs: 2_000 },
      ],
    });
    const registry = createUpstreamRegistry({
      configs: config.upstreams,
      toolCacheTtlMs: config.toolCacheTtlMs,
      logger,
      clientInfo: { name: "integration-gateway", version: "0.0.0" },
    });
    const mcpApp = createApp({ config, logger, registry, authRepo: deps.authRepo, auditRepo: deps.auditRepo });
    const httpServer = mcpApp.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", () => resolve());
      httpServer.once("error", reject);
    });
    const address = httpServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    const connect = async (key: string, name: string): Promise<Client> => {
      const client = new Client({ name, version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      });
      await client.connect(transport);
      return client;
    };

    // A second, still-valid reader key (the one issued in the lifecycle test was revoked).
    const generated = generateApiKey(TEST_PEPPER);
    await deps.authRepo.createKey(READER_ID, generated.keyPrefix, generated.keyHash);
    const readerKey = generated.key;

    const clients: Client[] = [];
    try {
      const beforeCount = await countToolCalls(admin);

      const adminClient = await connect(adminKey, "admin-client");
      clients.push(adminClient);
      const listed = await adminClient.listTools();
      assert.ok(listed.tools.length > 0);
      // tools/list is authenticated but NOT audited: count must not move yet.
      assert.equal(await countToolCalls(admin), beforeCount);

      const read = await adminClient.callTool({ name: "woocommerce_list_products", arguments: {} });
      assert.ok(read.isError !== true);
      assert.equal(await countToolCalls(admin), beforeCount + 1);

      const successRow = await admin.query<{
        user_id: string;
        role: string;
        outcome: string;
        qualified_name: string;
        key_id: string;
        duration_ms: number;
      }>(
        `SELECT user_id, role, outcome, qualified_name, key_id, duration_ms FROM audit_log
         WHERE action = 'tool_call' ORDER BY id DESC LIMIT 1`,
      );
      assert.deepEqual(successRow.rows[0], {
        user_id: ADMIN_ID,
        role: "admin",
        outcome: "success",
        qualified_name: "woocommerce_list_products",
        key_id: adminKeyId,
        duration_ms: successRow.rows[0]?.duration_ms,
      });
      assert.ok((successRow.rows[0]?.duration_ms ?? -1) >= 0);

      // Reader write attempt → -32003 and exactly one denied row.
      const readerClient = await connect(readerKey, "reader-client");
      clients.push(readerClient);
      let denied: unknown = null;
      try {
        await readerClient.callTool({ name: "woocommerce_create_product", arguments: {} });
      } catch (error) {
        denied = error;
      }
      assert.ok(denied !== null);
      assert.equal((denied as { code?: number }).code, -32003);
      assert.equal(await countToolCalls(admin), beforeCount + 2);

      const deniedRow = await admin.query<{ user_id: string; role: string; outcome: string; error_code: string }>(
        `SELECT user_id, role, outcome, error_code FROM audit_log
         WHERE action = 'tool_call' AND outcome = 'denied' ORDER BY id DESC LIMIT 1`,
      );
      assert.deepEqual(deniedRow.rows[0], {
        user_id: READER_ID,
        role: "reader",
        outcome: "denied",
        error_code: "role_forbidden",
      });
    } finally {
      for (const client of clients) {
        await client.close().catch(() => undefined);
      }
      await mcpApp.close();
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      });
      await registry.close();
      await fake.close();
    }
  });
});
