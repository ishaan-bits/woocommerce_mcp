import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { UserConflictError } from "../../src/db/auth-repository.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { createLogger, type Logger } from "../../src/logger.ts";
import { applyUpstreamOverrides, createUpstreamRegistry } from "../../src/upstream-registry.ts";
import { makeConfig, TEST_PEPPER } from "../helpers/config.ts";
import { FakeUpstreamRegistry } from "../helpers/fake-repos.ts";
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
      await admin.query(
        `DROP TABLE IF EXISTS audit_log, api_keys, users, web_sessions, upstream_overrides, schema_migrations CASCADE`,
      );
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
      ["001_init.sql", "002_dashboard.sql", "003_user_admin.sql"],
    );

    const tables = await admin.query<{ regclass: string | null }>(
      `SELECT to_regclass('public.users')::text AS regclass`,
    );
    assert.equal(tables.rows[0]?.regclass, "users");
    const more = await Promise.all(
      ["api_keys", "audit_log", "web_sessions", "upstream_overrides"].map((table) =>
        admin.query<{ regclass: string | null }>(`SELECT to_regclass('public.${table}')::text AS regclass`),
      ),
    );
    assert.deepEqual(more.map((result) => result.rows[0]?.regclass), [
      "api_keys",
      "audit_log",
      "web_sessions",
      "upstream_overrides",
    ]);

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
    const registry = new FakeUpstreamRegistry([{ id: "woocommerce", enabled: true, reachable: true }]);
    const mini = await startMiniApp((app) => {
      app.use(
        createAuthMiddleware({ repo: deps.authRepo, sessions: deps.sessionRepo, pepper: TEST_PEPPER, audit, logger }),
      );
      app.use(
        "/api",
        createApiRouter({
          authRepo: deps.authRepo,
          auditRepo: deps.auditRepo,
          audit,
          sessions: deps.sessionRepo,
          upstreamState: deps.upstreamStateRepo,
          registry,
          logger,
          pepper: TEST_PEPPER,
        }),
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

      // Dashboard sessions (D23): the runtime role writes and prunes only the
      // ephemeral session store — never the audit or user tables.
      const probeToken = "f".repeat(64);
      await roleClient.query(
        `INSERT INTO web_sessions (token_hash, user_id, key_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 minute')`,
        [probeToken, ADMIN_ID, adminKeyId],
      );
      const sessionRows = await roleClient.query(`SELECT token_hash FROM web_sessions WHERE token_hash = $1`, [
        probeToken,
      ]);
      assert.equal(sessionRows.rowCount, 1);
      await roleClient.query(`DELETE FROM web_sessions WHERE token_hash = $1`, [probeToken]);
      await assert.rejects(
        () => roleClient.query(`DELETE FROM users`),
        (error: unknown) => (error as { code?: string }).code === "42501",
        "DELETE on users must be insufficient_privilege",
      );

      // Upstream toggles (D24): updated in place, never deleted by the runtime role.
      await roleClient.query(
        `INSERT INTO upstream_overrides (upstream_id, enabled, updated_by) VALUES ('woocommerce', false, $1)
         ON CONFLICT (upstream_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [ADMIN_ID],
      );
      await roleClient.query(`UPDATE upstream_overrides SET enabled = true WHERE upstream_id = 'woocommerce'`);
      await assert.rejects(
        () => roleClient.query(`DELETE FROM upstream_overrides`),
        (error: unknown) => (error as { code?: string }).code === "42501",
        "DELETE on upstream_overrides must be insufficient_privilege",
      );
      await roleClient.query(`DELETE FROM web_sessions`).catch(() => undefined);
      await admin.query(`DELETE FROM upstream_overrides WHERE upstream_id = 'woocommerce'`);
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
      ssrf: { allowedPrivateHosts: ["*"] },
      clientInfo: { name: "integration-gateway", version: "0.0.0" },
    });
    const mcpApp = createApp({
      config,
      logger,
      registry,
      authRepo: deps.authRepo,
      auditRepo: deps.auditRepo,
      sessionRepo: deps.sessionRepo,
      upstreamStateRepo: deps.upstreamStateRepo,
    });
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

  test("migration 002 extends the audit action CHECK to the dashboard actions (D22)", async () => {
    await admin.query(
      `INSERT INTO audit_log (action, outcome, upstream_id) VALUES ('upstream_enabled', 'success', 'woocommerce')`,
    );
    await admin.query(
      `INSERT INTO audit_log (action, outcome, upstream_id) VALUES ('upstream_disabled', 'success', 'woocommerce')`,
    );
    // The database, not just the TypeScript union, rejects unknown actions.
    await assert.rejects(
      () => admin.query(`INSERT INTO audit_log (action, outcome) VALUES ('made_up_action', 'success')`),
      (error: unknown) => (error as { code?: string }).code === "23514",
      "an unknown audit action must violate the CHECK constraint",
    );
    await admin.query(`DELETE FROM audit_log WHERE action IN ('upstream_enabled', 'upstream_disabled')`);
  });

  test("migration 003 extends the audit action CHECK to the member-administration actions (M10)", async () => {
    await admin.query(`INSERT INTO audit_log (action, outcome) VALUES ('user_created', 'success')`);
    await admin.query(`INSERT INTO audit_log (action, outcome) VALUES ('user_updated', 'success')`);
    await assert.rejects(
      () => admin.query(`INSERT INTO audit_log (action, outcome) VALUES ('user_deleted', 'success')`),
      (error: unknown) => (error as { code?: string }).code === "23514",
      "an unknown audit action must still violate the CHECK constraint after 003",
    );
    await admin.query(`DELETE FROM audit_log WHERE action IN ('user_created', 'user_updated') AND key_id IS NULL`);
  });

  test("member administration runs against the real users table (M10)", async () => {
    const created = await deps.authRepo.createUser({
      displayName: "member-m10",
      role: "reader",
      allowedUpstreams: ["woocommerce"],
      allowedTools: ["tools:woocommerce_list_products"],
    });
    assert.equal(created.displayName, "member-m10");
    assert.equal(created.role, "reader");
    assert.equal(created.activeKeys, 0, "a new member starts without keys");
    assert.equal(created.totalKeys, 0);

    // The UNIQUE constraint (not just the route) enforces display names.
    await assert.rejects(
      () =>
        deps.authRepo.createUser({
          displayName: "member-m10",
          role: "reader",
          allowedUpstreams: [],
          allowedTools: [],
        }),
      (error: unknown) => error instanceof UserConflictError,
      "duplicate display names must surface as UserConflictError",
    );

    // One issued key flips the counts through the real JOIN.
    const generated = generateApiKey(TEST_PEPPER);
    const key = await deps.authRepo.createKey(created.id, generated.keyPrefix, generated.keyHash);
    const listed = await deps.authRepo.listUsers();
    const mine = listed.find((user) => user.id === created.id);
    assert.ok(mine, "the new member must appear in the admin listing");
    assert.equal(mine.activeKeys, 1);
    assert.equal(mine.totalKeys, 1);

    // Role/grant updates persist; unknown ids return null (route maps to 404).
    const updated = await deps.authRepo.updateUser(created.id, {
      role: "admin",
      allowedUpstreams: ["woocommerce", "support"],
      allowedTools: ["tools:woocommerce_list_products", "tools:support_list_tickets"],
    });
    assert.ok(updated);
    assert.equal(updated.role, "admin");
    assert.deepEqual(updated.allowedUpstreams, ["woocommerce", "support"]);
    const missing = await deps.authRepo.updateUser("00000000-0000-4000-8000-000000000000", { role: "reader" });
    assert.equal(missing, null);

    // Revocation is reflected in activeKeys (row kept, C1).
    assert.equal(await deps.authRepo.revokeKey(key.id).then((result) => result.revokedNow), true);
    const afterRevoke = await deps.authRepo.listUsers();
    const mineAfter = afterRevoke.find((user) => user.id === created.id);
    assert.equal(mineAfter?.activeKeys, 0);
    assert.equal(mineAfter?.totalKeys, 1);

    // Cleanup: api_keys references users with ON DELETE RESTRICT.
    await admin.query(`DELETE FROM api_keys WHERE user_id = $1`, [created.id]);
    await admin.query(`DELETE FROM users WHERE id = $1`, [created.id]);
  });

  test("audit filters run as parameterized SQL against the real audit_log (M10)", async () => {
    const audit = createAuditWriter(deps.auditRepo, logger);
    const marker = "m10_filter_marker";
    await audit.record({
      action: "tool_call",
      keyId: adminKeyId,
      userId: ADMIN_ID,
      role: "admin",
      upstreamId: "woocommerce",
      toolName: "list_products",
      qualifiedName: "woocommerce_list_products",
      outcome: "success",
      durationMs: 2,
      errorCode: marker,
    });
    await audit.record({
      action: "tool_call",
      keyId: "m10-key",
      userId: READER_ID,
      role: "reader",
      upstreamId: "inventory",
      toolName: "adjust_stock",
      qualifiedName: "inventory_adjust_stock",
      outcome: "error",
      durationMs: 3,
      errorCode: marker,
    });

    try {
      const toolCalls = await deps.auditRepo.recent(50, undefined, { action: "tool_call" });
      assert.ok(toolCalls.length >= 2);
      assert.ok(toolCalls.every((entry) => entry.action === "tool_call"));

      const failures = await deps.auditRepo.recent(50, undefined, { action: "tool_call", outcome: "error" });
      assert.ok(failures.length >= 1);
      assert.ok(failures.every((entry) => entry.outcome === "error"));

      const byUser = await deps.auditRepo.recent(50, undefined, { userId: READER_ID, action: "tool_call" });
      assert.ok(byUser.length >= 1);
      assert.ok(byUser.every((entry) => entry.userId === READER_ID));

      const byUpstream = await deps.auditRepo.recent(50, undefined, { upstreamId: "inventory" });
      assert.ok(byUpstream.every((entry) => entry.upstreamId === "inventory"));

      const byTool = await deps.auditRepo.recent(50, undefined, { tool: "inventory" });
      assert.ok(byTool.length >= 1);
      assert.ok(byTool.every((entry) => (entry.qualifiedName ?? "").includes("inventory")));

      // LIKE metacharacters are data, not syntax: no row contains "100%".
      const literal = await deps.auditRepo.recent(50, undefined, { tool: "100%" });
      assert.equal(literal.length, 0);

      // Filters combine with the keyset cursor (beforeId still applies).
      const firstPage = await deps.auditRepo.recent(1, undefined, { action: "tool_call" });
      assert.equal(firstPage.length, 1);
      const cursor = await deps.auditRepo.recent(50, firstPage[0]!.id, { action: "tool_call" });
      assert.ok(cursor.every((entry) => Number(entry.id) < Number(firstPage[0]!.id)));
    } finally {
      await admin.query(`DELETE FROM audit_log WHERE error_code = $1`, [marker]);
    }
  });

  /** The dashboard REST surface wired to the *real* session/audit/override stores. */
  async function startDashboardApp(registry: FakeUpstreamRegistry): Promise<{ origin: string; close(): Promise<void> }> {
    const audit = createAuditWriter(deps.auditRepo, logger);
    return startMiniApp((app) => {
      app.use(
        createAuthMiddleware({ repo: deps.authRepo, sessions: deps.sessionRepo, pepper: TEST_PEPPER, audit, logger }),
      );
      app.use(
        "/api",
        createApiRouter({
          authRepo: deps.authRepo,
          auditRepo: deps.auditRepo,
          audit,
          sessions: deps.sessionRepo,
          upstreamState: deps.upstreamStateRepo,
          registry,
          logger,
          pepper: TEST_PEPPER,
        }),
      );
    });
  }

  test("dashboard login/session lifecycle runs against the real web_sessions table (D23)", async () => {
    const registry = new FakeUpstreamRegistry([{ id: "woocommerce", enabled: true, reachable: true }]);
    const mini = await startDashboardApp(registry);
    try {
      // A dedicated key so the shared adminKey stays valid for later tests.
      const generated = generateApiKey(TEST_PEPPER);
      const created = await deps.authRepo.createKey(ADMIN_ID, generated.keyPrefix, generated.keyHash);

      const loginRes = await fetch(`${mini.origin}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: generated.key }),
      });
      assert.equal(loginRes.status, 200);
      const setCookie = loginRes.headers.get("set-cookie") ?? "";
      assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"));
      const cookie = setCookie.split(";")[0] ?? "";

      // The row stores sha256(token) bound to the key — never the plaintext key.
      const token = cookie.slice("urumi_session=".length);
      const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
      const rows = await admin.query<{ key_id: string; user_id: string }>(
        `SELECT key_id, user_id FROM web_sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0]?.key_id, created.id);
      assert.equal(rows.rows[0]?.user_id, ADMIN_ID);
      const leak = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM web_sessions WHERE token_hash = $1`, [
        generated.key,
      ]);
      assert.equal(leak.rows[0]?.n, 0, "plaintext key must never be stored");

      const me = await fetch(`${mini.origin}/api/me`, { headers: { cookie } });
      assert.equal(me.status, 200);
      const meBody = (await me.json()) as { user_id: string; role: string };
      assert.equal(meBody.user_id, ADMIN_ID);
      assert.equal(meBody.role, "admin");

      // Revoking the key kills the live session on its next request (C1/D23).
      await deps.authRepo.revokeKey(created.id);
      const after = await fetch(`${mini.origin}/api/me`, { headers: { cookie } });
      assert.equal(after.status, 401);

      // The audit surface never carries key material to the browser (C1/C6).
      const auditRes = await fetch(`${mini.origin}/api/audit?limit=100`, {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      assert.equal(auditRes.status, 200);
      const raw = JSON.stringify(await auditRes.json());
      assert.ok(!raw.includes("umk_"), "no key material in audit responses");
      assert.ok(!raw.includes(generated.key), "no plaintext key in audit responses");
      assert.ok(!raw.includes("key_hash"), "no stored hashes in audit responses");
    } finally {
      await mini.close();
    }
  });

  test("dashboard toggle writes the override and audit rows into PostgreSQL (D24)", async () => {
    const registry = new FakeUpstreamRegistry([{ id: "woocommerce", enabled: true, reachable: true }]);
    const mini = await startDashboardApp(registry);
    try {
      const disabled = await fetch(`${mini.origin}/api/upstreams/woocommerce:disable`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminKey}` },
      });
      assert.equal(disabled.status, 200);
      assert.deepEqual(await disabled.json(), { id: "woocommerce", enabled: false, changed: true });

      const override = await admin.query<{ enabled: boolean; updated_by: string }>(
        `SELECT enabled, updated_by FROM upstream_overrides WHERE upstream_id = 'woocommerce'`,
      );
      assert.deepEqual(override.rows, [{ enabled: false, updated_by: ADMIN_ID }]);

      const row = await admin.query<{ action: string; upstream_id: string; outcome: string; user_id: string }>(
        `SELECT action, upstream_id, outcome, user_id FROM audit_log
          WHERE action = 'upstream_disabled' ORDER BY id DESC LIMIT 1`,
      );
      assert.deepEqual(row.rows[0], {
        action: "upstream_disabled",
        upstream_id: "woocommerce",
        outcome: "success",
        user_id: ADMIN_ID,
      });

      // Unauthorized attempt: real 403 + access_denied row, no state change.
      const readerGen = generateApiKey(TEST_PEPPER);
      await deps.authRepo.createKey(READER_ID, readerGen.keyPrefix, readerGen.keyHash);
      const denied = await fetch(`${mini.origin}/api/upstreams/woocommerce:enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${readerGen.key}` },
      });
      assert.equal(denied.status, 403);
      const denial = await admin.query<{ role: string; outcome: string; error_code: string }>(
        `SELECT role, outcome, error_code FROM audit_log
          WHERE action = 'access_denied' ORDER BY id DESC LIMIT 1`,
      );
      assert.deepEqual(denial.rows[0], { role: "reader", outcome: "denied", error_code: "role_forbidden" });
      assert.equal(
        (await admin.query(`SELECT enabled FROM upstream_overrides WHERE upstream_id = 'woocommerce'`)).rows[0]
          ?.enabled,
        false,
        "the denied attempt must not flip the stored state",
      );

      await admin.query(`DELETE FROM upstream_overrides`);
    } finally {
      await mini.close();
    }
  });

  test("stored overrides re-apply onto a fresh registry after a simulated restart (D24)", async () => {
    await deps.upstreamStateRepo.setOverride("woocommerce", false, ADMIN_ID);
    const overrides = await deps.upstreamStateRepo.getOverrides();
    assert.deepEqual(overrides, { woocommerce: false });

    // A brand-new registry (same env config as a restarted gateway would get).
    const config = makeConfig({
      databaseUrl,
      upstreams: [
        { id: "woocommerce", baseUrl: "http://127.0.0.1:1/mcp", enabled: true, timeoutMs: 1_000, connectTimeoutMs: 500 },
      ],
    });
    const registry = createUpstreamRegistry({
      configs: config.upstreams,
      toolCacheTtlMs: 1_000,
      logger,
      ssrf: { allowedPrivateHosts: ["*"] },
      clientInfo: { name: "integration-restart", version: "0.0.0" },
    });
    try {
      assert.equal(registry.health().find((entry) => entry.id === "woocommerce")?.enabled, true);
      const applied = applyUpstreamOverrides(registry, overrides, logger);
      assert.equal(applied, 1);
      assert.equal(
        registry.health().find((entry) => entry.id === "woocommerce")?.enabled,
        false,
        "the stored disable must survive the restart",
      );
      // Unknown ids (env URL removed) are skipped, not fatal.
      assert.equal(applyUpstreamOverrides(registry, { ghost: false }, logger), 0);
    } finally {
      await registry.close();
      await admin.query(`DELETE FROM upstream_overrides`);
    }
  });

  test("a failing migration rolls back and records nothing in schema_migrations (C6)", async () => {
    // Sabotage: a wrong-shape `users` table makes 001's CREATE TABLE IF NOT
    // EXISTS skip, so the seed INSERT inside the same transaction fails and
    // the whole migration must roll back.
    await admin.query(
      `DROP TABLE IF EXISTS audit_log, api_keys, users, web_sessions, upstream_overrides, schema_migrations CASCADE`,
    );
    await admin.query(`CREATE TABLE users (oops integer)`);
    try {
      await assert.rejects(() => runMigrations({ databaseUrl, appPassword: APP_PASSWORD, log: () => undefined }));
      const applied = await admin.query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
      assert.equal(applied.rows.length, 0, "no migration may be recorded after a rollback");
      const users = await admin.query(`SELECT oops FROM users`);
      assert.equal(users.rows.length, 0, "the sabotaged table must be untouched by the rolled-back DDL");
    } finally {
      await admin.query(`DROP TABLE IF EXISTS users CASCADE`);
      await runMigrations({ databaseUrl, appPassword: APP_PASSWORD, log: () => undefined });
    }
  });
});
