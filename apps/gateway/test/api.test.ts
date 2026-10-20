import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { API_PREFIX } from "@mcp/shared";
import { createApiRouter } from "../src/api/routes.ts";
import { createAuditWriter, type AuditWriter } from "../src/audit.ts";
import { createAuthMiddleware, principalOf } from "../src/auth/middleware.ts";
import { looksLikeApiKey } from "../src/auth/keys.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import { FakeAuditRepository, FakeAuthRepository } from "./helpers/fake-repos.ts";
import { TEST_PEPPER } from "./helpers/config.ts";
import { startMiniApp, type MiniApp } from "./helpers/mini-app.ts";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const READER_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

interface Fixture {
  authRepo: FakeAuthRepository;
  auditRepo: FakeAuditRepository;
  audit: AuditWriter;
  logger: Logger;
  adminKey: string;
  readerKey: string;
}

function makeFixture(): Fixture {
  const authRepo = new FakeAuthRepository();
  authRepo.seedUser({
    id: ADMIN_ID,
    displayName: "admin-demo",
    role: "admin",
    allowedUpstreams: ["woocommerce"],
    allowedTools: ["tools:woocommerce_list_products"],
  });
  authRepo.seedUser({
    id: READER_ID,
    displayName: "reader-demo",
    role: "reader",
    allowedUpstreams: ["woocommerce"],
    allowedTools: ["tools:woocommerce_list_products"],
  });
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: { write: (line) => lines.push(line) } });
  const auditRepo = new FakeAuditRepository();
  const audit = createAuditWriter(auditRepo, logger);
  return {
    authRepo,
    auditRepo,
    audit,
    logger,
    adminKey: authRepo.issueKey(ADMIN_ID, TEST_PEPPER).key,
    readerKey: authRepo.issueKey(READER_ID, TEST_PEPPER).key,
  };
}

function startApi(fx: Fixture): Promise<MiniApp> {
  return startMiniApp((app) => {
    app.use(
      createAuthMiddleware({ repo: fx.authRepo, pepper: TEST_PEPPER, audit: fx.audit, logger: fx.logger }),
    );
    app.use(
      API_PREFIX,
      createApiRouter({
        authRepo: fx.authRepo,
        auditRepo: fx.auditRepo,
        audit: fx.audit,
        pepper: TEST_PEPPER,
      }),
    );
    app.get("/raw", (req, res) => {
      res.json({ principal: principalOf(req) });
    });
  });
}

let active: MiniApp | null = null;
afterEach(async () => {
  if (active !== null) {
    await active.close();
    active = null;
  }
});

function call(
  app: MiniApp,
  method: string,
  path: string,
  key?: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${app.origin}${API_PREFIX}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("admin API (/api, C2)", () => {
  test("GET /me reflects the authenticated principal", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const response = await call(active, "GET", "/me", fx.adminKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.user_id, ADMIN_ID);
    assert.equal(body.display_name, "admin-demo");
    assert.equal(body.role, "admin");
    assert.deepEqual(body.allowed_upstreams, ["woocommerce"]);
    assert.ok(typeof body.key_id === "string");
  });

  test("reader is denied admin endpoints with 403 and an access_denied audit row", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    for (const path of ["/keys", "/audit"]) {
      const response = await call(active, "GET", path, fx.readerKey);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: "forbidden" });
    }
    const denials = fx.auditRepo.byAction("access_denied");
    assert.equal(denials.length, 2);
    assert.ok(denials.every((row) => row.outcome === "denied" && row.errorCode === "role_forbidden"));
    assert.ok(denials.every((row) => row.role === "reader"));
  });

  test("key issuance returns the plaintext exactly once, stores only prefix+hash, and audits key_created", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const created = await call(active, "POST", "/keys", fx.adminKey, { user_id: READER_ID });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; key: string; key_prefix: string; revoked_at: null };
    assert.ok(looksLikeApiKey(body.key));
    assert.equal(body.revoked_at, null);
    assert.equal(body.key_prefix, body.key.slice(0, 12));

    // Stored material contains the prefix and sha256 hex, never the plaintext.
    const rows = await fx.authRepo.findByPrefix(body.key_prefix);
    assert.equal(rows.length, 1);
    const stored = rows[0];
    assert.ok(stored);
    assert.match(stored.keyHash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.keyHash, body.key);
    const serialized = JSON.stringify(rows);
    assert.ok(!serialized.includes(body.key));

    const creation = fx.auditRepo.byAction("key_created");
    assert.equal(creation.length, 1);
    const created1 = creation[0];
    assert.ok(created1);
    assert.equal(created1.outcome, "success");
    assert.ok(!JSON.stringify(creation).includes(body.key));

    // The issued key works immediately against a fresh request (end-to-end).
    const me = await fetch(`${active.origin}/raw`, { headers: { authorization: `Bearer ${body.key}` } });
    assert.equal(me.status, 200);
    const principal = ((await me.json()) as { principal: { userId: string } | null }).principal;
    assert.equal(principal?.userId, READER_ID);
  });

  test("key issuance validates user_id shape and existence", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const bad = await call(active, "POST", "/keys", fx.adminKey, { user_id: "not-a-uuid" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "user_id must be a UUID" });

    const missing = await call(active, "POST", "/keys", fx.adminKey, { user_id: UNKNOWN_ID });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "unknown_user" });

    assert.equal(fx.auditRepo.byAction("key_created").length, 0);
  });

  test("revocation is idempotent, audited once, and takes effect immediately", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const created = await call(active, "POST", "/keys", fx.adminKey, { user_id: READER_ID });
    const body = (await created.json()) as { id: string; key: string };

    const first = await call(active, "POST", `/keys/${body.id}/revoke`, fx.adminKey);
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { already_revoked: boolean; revoked_at: string };
    assert.equal(firstBody.already_revoked, false);
    assert.ok(typeof firstBody.revoked_at === "string");

    const second = await call(active, "POST", `/keys/${body.id}/revoke`, fx.adminKey);
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { already_revoked: boolean }).already_revoked, true);

    assert.equal(fx.auditRepo.byAction("key_revoked").length, 1);

    const denied = await call(active, "GET", "/me", body.key);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });

    const unknown = await call(active, "POST", `/keys/${UNKNOWN_ID}/revoke`, fx.adminKey);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "unknown_key" });

    const malformed = await call(active, "POST", "/keys/not-a-uuid/revoke", fx.adminKey);
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid key id" });
  });

  test("GET /keys lists metadata without hashes or plaintext", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const response = await call(active, "GET", "/keys", fx.adminKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { keys: Array<Record<string, unknown>> };
    assert.ok(body.keys.length >= 2);
    for (const key of body.keys) {
      assert.ok(!("key" in key));
      assert.ok(!("keyHash" in key));
      assert.ok(!("key_hash" in key));
      assert.equal(typeof key.keyPrefix, "string");
      assert.equal(typeof key.id, "string");
    }
    assert.ok(!JSON.stringify(body).includes(fx.adminKey));
  });

  test("GET /audit enforces the limit/before contract and returns newest first", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const firstCreate = await call(active, "POST", "/keys", fx.adminKey, { user_id: READER_ID });
    assert.equal(firstCreate.status, 201);
    const secondCreate = await call(active, "POST", "/keys", fx.adminKey, { user_id: READER_ID });
    assert.equal(secondCreate.status, 201);

    const page = await call(active, "GET", "/audit?limit=10", fx.adminKey);
    assert.equal(page.status, 200);
    const body = (await page.json()) as { entries: Array<{ id: string; action: string }> };
    assert.equal(body.entries.length, 2);
    const ids = body.entries.map((entry) => Number(entry.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    assert.ok(body.entries.some((entry) => entry.action === "key_created"));

    const zero = await call(active, "GET", "/audit?limit=0", fx.adminKey);
    assert.equal(zero.status, 400);
    assert.deepEqual(await zero.json(), { error: "limit must be between 1 and 100" });
    const huge = await call(active, "GET", "/audit?limit=101", fx.adminKey);
    assert.equal(huge.status, 400);
    const badBefore = await call(active, "GET", "/audit?before=abc", fx.adminKey);
    assert.equal(badBefore.status, 400);
    assert.deepEqual(await badBefore.json(), { error: "before must be an audit id (digits)" });

    const first = await call(active, "GET", "/audit?limit=1", fx.adminKey);
    const firstBody = (await first.json()) as { entries: Array<{ id: string }> };
    const cursorEntry = firstBody.entries[0];
    assert.ok(cursorEntry);
    const cursor = cursorEntry.id;
    const next = await call(active, "GET", `/audit?limit=10&before=${cursor}`, fx.adminKey);
    const nextBody = (await next.json()) as { entries: Array<{ id: string }> };
    assert.ok(nextBody.entries.every((entry) => Number(entry.id) < Number(cursor)));
  });

  test("unauthenticated access to the API is denied by the middleware before routes", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    for (const path of ["/me", "/keys", "/audit"]) {
      const response = await call(active, "GET", path);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    assert.equal(fx.auditRepo.byAction("access_denied").length, 0);
  });
});
