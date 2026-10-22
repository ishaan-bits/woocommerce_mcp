import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { API_PREFIX } from "@mcp/shared";
import { createApiRouter } from "../src/api/routes.ts";
import { createAuditWriter, type AuditWriter } from "../src/audit.ts";
import { createAuthMiddleware, principalOf } from "../src/auth/middleware.ts";
import { looksLikeApiKey } from "../src/auth/keys.ts";
import { hashSessionToken } from "../src/auth/sessions.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import {
  FakeAuditRepository,
  FakeAuthRepository,
  FakeSessionRepository,
  FakeUpstreamRegistry,
  FakeUpstreamStateRepository,
} from "./helpers/fake-repos.ts";
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
  sessions: FakeSessionRepository;
  upstreamState: FakeUpstreamStateRepository;
  registry: FakeUpstreamRegistry;
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
  const sessions = new FakeSessionRepository();
  const upstreamState = new FakeUpstreamStateRepository();
  const registry = new FakeUpstreamRegistry([
    {
      id: "woocommerce",
      enabled: true,
      reachable: true,
      tools: [
        {
          upstreamId: "woocommerce",
          name: "list_products",
          qualifiedName: "woocommerce_list_products",
          description: "List products",
          inputSchema: { type: "object" },
        },
      ],
    },
    { id: "inventory", enabled: true, reachable: false, lastErrorMessage: "unreachable" },
    // support: intentionally absent = not configured via env.
  ]);
  return {
    authRepo,
    auditRepo,
    audit,
    logger,
    sessions,
    upstreamState,
    registry,
    adminKey: authRepo.issueKey(ADMIN_ID, TEST_PEPPER).key,
    readerKey: authRepo.issueKey(READER_ID, TEST_PEPPER).key,
  };
}

function startApi(fx: Fixture, options?: { woocommerceStoreMode?: "mock" | "real" | null }): Promise<MiniApp> {
  return startMiniApp((app) => {
    app.use(
      createAuthMiddleware({
        repo: fx.authRepo,
        sessions: fx.sessions,
        pepper: TEST_PEPPER,
        audit: fx.audit,
        logger: fx.logger,
      }),
    );
    app.use(
      API_PREFIX,
      createApiRouter({
        authRepo: fx.authRepo,
        auditRepo: fx.auditRepo,
        audit: fx.audit,
        sessions: fx.sessions,
        upstreamState: fx.upstreamState,
        registry: fx.registry,
        logger: fx.logger,
        pepper: TEST_PEPPER,
        ...(options?.woocommerceStoreMode !== undefined
          ? { woocommerceStoreMode: options.woocommerceStoreMode }
          : {}),
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

describe("dashboard login/session (D23)", () => {
  function callWithCookie(
    app: MiniApp,
    method: string,
    path: string,
    cookie: string | null,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${app.origin}${API_PREFIX}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie !== null ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function login(app: MiniApp, key: unknown): Promise<{ response: Response; setCookie: string | null }> {
    const response = await call(app, "POST", "/auth/login", undefined, { key });
    return { response, setCookie: response.headers.get("set-cookie") };
  }

  test("login exchanges a key for an HttpOnly session cookie and stores only its sha256", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const { response, setCookie } = await login(active, fx.adminKey);
    assert.equal(response.status, 200);
    assert.ok(setCookie !== null, "Set-Cookie must be present");
    assert.match(setCookie, /^urumi_session=[A-Za-z0-9_-]+;/);
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=Strict"));
    assert.ok(setCookie.includes("Secure"));
    assert.ok(setCookie.includes("Path=/"));
    assert.ok(setCookie.includes("Max-Age=43200"));

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.user_id, ADMIN_ID);
    assert.equal(body.role, "admin");

    // The browser token is stored hashed and bound to the key; the plaintext
    // key appears nowhere in the session store.
    const token = setCookie.split(";")[0]?.slice("urumi_session=".length) ?? "";
    assert.ok(token.length > 0);
    assert.notEqual(token, fx.adminKey);
    const stored = await fx.sessions.find(hashSessionToken(token));
    assert.ok(stored !== null);
    assert.equal(stored.tokenHash, hashSessionToken(token));
    assert.notEqual(stored.tokenHash, fx.adminKey);
    assert.equal(fx.sessions.size, 1);
    assert.equal(fx.auditRepo.byAction("auth_failed").length, 0);
  });

  test("cookie round trip: login → /me → logout clears server row and cookie", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const { response: loginRes, setCookie } = await login(active, fx.adminKey);
    assert.equal(loginRes.status, 200);
    assert.ok(setCookie !== null);
    const cookie = setCookie.split(";")[0] ?? "";

    const me = await callWithCookie(active, "GET", "/me", cookie);
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { user_id: string; role: string };
    assert.equal(meBody.user_id, ADMIN_ID);
    assert.equal(meBody.role, "admin");

    const logout = await callWithCookie(active, "POST", "/auth/logout", cookie);
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });
    const clearCookie = logout.headers.get("set-cookie") ?? "";
    assert.ok(clearCookie.startsWith("urumi_session=;"));
    assert.ok(clearCookie.includes("Max-Age=0"));
    assert.equal(fx.sessions.size, 0);

    const after = await callWithCookie(active, "GET", "/me", cookie);
    assert.equal(after.status, 401);
    assert.deepEqual(await after.json(), { error: "unauthorized" });
  });

  test("a wrong or revoked key cannot log in: 401, uniform body, auth_failed row", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const unknown = `umk_${"A".repeat(43)}`;
    const wrong = await login(active, unknown);
    assert.equal(wrong.response.status, 401);
    assert.deepEqual(await wrong.response.json(), { error: "unauthorized" });

    const revoked = fx.authRepo.issueKey(READER_ID, TEST_PEPPER);
    fx.authRepo.revokeByKeyId(revoked.keyId);
    const revokedLogin = await login(active, revoked.key);
    assert.equal(revokedLogin.response.status, 401);
    assert.deepEqual(await revokedLogin.response.json(), { error: "unauthorized" });

    const failures = fx.auditRepo.byAction("auth_failed");
    assert.equal(failures.length, 2);
    assert.equal(failures[0]?.errorCode, "unknown_key");
    assert.equal(failures[1]?.errorCode, "revoked_key");
    assert.equal(fx.sessions.size, 0);
  });

  test("login validates the body and fails closed on a database outage", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const missing = await call(active, "POST", "/auth/login", undefined, {});
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "key must be a string" });

    fx.authRepo.down = true;
    const outage = await login(active, fx.adminKey);
    assert.equal(outage.response.status, 503);
    assert.deepEqual(await outage.response.json(), { error: "service_unavailable" });
    assert.equal(fx.auditRepo.byAction("auth_failed").length, 0);
  });

  test("logout fails closed with 503 when the session store is down", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const { response: loginRes, setCookie } = await login(active, fx.adminKey);
    assert.equal(loginRes.status, 200);
    const cookie = setCookie?.split(";")[0] ?? "";

    fx.sessions.down = true;
    const logout = await callWithCookie(active, "POST", "/auth/logout", cookie);
    assert.equal(logout.status, 503);
    assert.deepEqual(await logout.json(), { error: "service_unavailable" });
  });
});

describe("dashboard tool/upstream endpoints (D6, D24)", () => {
  test("GET /tools mirrors the aggregated registry for any authenticated principal, with no internal URLs", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const anonymous = await call(active, "GET", "/tools");
    assert.equal(anonymous.status, 401);

    for (const key of [fx.adminKey, fx.readerKey]) {
      const response = await call(active, "GET", "/tools", key);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        tools: Array<{ qualified_name: string; upstream_id: string; input_schema: Record<string, unknown> }>;
        upstreams: Array<{ id: string; enabled: boolean; reachable: boolean; last_error: string | null }>;
      };
      assert.deepEqual(
        body.tools.map((tool) => tool.qualified_name),
        ["woocommerce_list_products"],
      );
      assert.equal(body.tools[0]?.upstream_id, "woocommerce");
      assert.deepEqual(body.tools[0]?.input_schema, { type: "object" });
      assert.deepEqual(
        body.upstreams.map((entry) => entry.id),
        ["woocommerce", "inventory"],
      );
      assert.equal(body.upstreams[1]?.last_error, "unreachable");
      // The mirror never exposes connection targets or credentials.
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes("http://"), "no internal URLs in the mirror");
      assert.ok(!raw.includes("umk_"), "no key material in the mirror");
    }
  });

  test("GET /upstreams covers every fixed upstream id with configured flags", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const anonymous = await call(active, "GET", "/upstreams");
    assert.equal(anonymous.status, 401);

    const response = await call(active, "GET", "/upstreams", fx.adminKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      upstreams: Array<{ id: string; configured: boolean; enabled: boolean; reachable: boolean; last_error: string | null }>;
    };
    assert.deepEqual(
      body.upstreams.map((entry) => entry.id),
      ["woocommerce", "inventory", "support"],
    );
    assert.deepEqual(
      body.upstreams.map((entry) => [entry.configured, entry.enabled]),
      [
        [true, true],
        [true, true],
        [false, false],
      ],
    );
    assert.equal(body.upstreams[1]?.reachable, false);
    assert.equal(body.upstreams[1]?.last_error, "unreachable");
  });

  test("admin toggle persists, applies live, audits, and mirrors back through /tools", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const disabled = await call(active, "POST", "/upstreams/woocommerce:disable", fx.adminKey);
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), { id: "woocommerce", enabled: false, changed: true });

    // Persisted (D24: survives a restart) and applied to the registry (D24).
    assert.equal(fx.upstreamState.overrides.get("woocommerce")?.enabled, false);
    assert.equal(fx.upstreamState.overrides.get("woocommerce")?.updatedBy, ADMIN_ID);
    assert.deepEqual(fx.registry.toggles, [{ id: "woocommerce", enabled: false }]);

    // Audited as an administrative action.
    const rows = fx.auditRepo.byAction("upstream_disabled");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.upstreamId, "woocommerce");
    assert.equal(rows[0]?.userId, ADMIN_ID);
    assert.equal(rows[0]?.outcome, "success");

    // The mirror reflects the toggle; the *other* upstream is untouched.
    const mirror = await call(active, "GET", "/tools", fx.adminKey);
    const mirrorBody = (await mirror.json()) as { tools: unknown[]; upstreams: Array<{ id: string; enabled: boolean }> };
    assert.equal(mirrorBody.tools.length, 0);
    assert.deepEqual(
      mirrorBody.upstreams.map((entry) => [entry.id, entry.enabled]),
      [
        ["woocommerce", false],
        ["inventory", true],
      ],
    );

    // Idempotent repeat: no change, no second audit row.
    const repeat = await call(active, "POST", "/upstreams/woocommerce:disable", fx.adminKey);
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), { id: "woocommerce", enabled: false, changed: false });
    assert.equal(fx.auditRepo.byAction("upstream_disabled").length, 1);

    // Re-enable restores the mirror.
    const enabled = await call(active, "POST", "/upstreams/woocommerce:enable", fx.adminKey);
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { id: "woocommerce", enabled: true, changed: true });
    const restored = await call(active, "GET", "/tools", fx.adminKey);
    const restoredBody = (await restored.json()) as { tools: unknown[] };
    assert.equal(restoredBody.tools.length, 1);
    assert.equal(fx.auditRepo.byAction("upstream_enabled").length, 1);
  });

  test("toggles are admin-only: reader gets 403, an access_denied row, and no state change", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const response = await call(active, "POST", "/upstreams/woocommerce:disable", fx.readerKey);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });

    assert.equal(fx.upstreamState.overrides.size, 0);
    assert.deepEqual(fx.registry.toggles, []);
    const denials = fx.auditRepo.byAction("access_denied");
    assert.equal(denials.length, 1);
    assert.equal(denials[0]?.role, "reader");
    assert.equal(denials[0]?.outcome, "denied");
  });

  test("toggle inputs are validated against the fixed registry: no arbitrary targets", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const anonymous = await call(active, "POST", "/upstreams/woocommerce:disable");
    assert.equal(anonymous.status, 401);

    const badAction = await call(active, "POST", "/upstreams/woocommerce:delete", fx.adminKey);
    assert.equal(badAction.status, 400);
    assert.deepEqual(await badAction.json(), { error: "spec must be <upstream>:enable or <upstream>:disable" });

    const unknown = await call(active, "POST", "/upstreams/http%3A%2F%2Fevil%3Aenable", fx.adminKey);
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "unknown_upstream" });

    const notConfigured = await call(active, "POST", "/upstreams/support:enable", fx.adminKey);
    assert.equal(notConfigured.status, 409);
    assert.deepEqual(await notConfigured.json(), { error: "upstream_not_configured" });

    assert.equal(fx.upstreamState.overrides.size, 0);
    assert.deepEqual(fx.registry.toggles, []);
    assert.equal(fx.auditRepo.byAction("upstream_enabled").length, 0);
    assert.equal(fx.auditRepo.byAction("upstream_disabled").length, 0);
  });

  test("a persistence failure fails closed: no live toggle, 500, audited error row", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    fx.upstreamState.down = true;

    const response = await call(active, "POST", "/upstreams/woocommerce:disable", fx.adminKey);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });

    assert.deepEqual(fx.registry.toggles, []);
    const rows = fx.auditRepo.byAction("upstream_disabled");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, "error");
    assert.equal(rows[0]?.errorCode, "persist_failed");
  });
});

describe("member administration (/api/users, admin-only)", () => {
  test("GET /users lists members with grants and key counts, never credentials", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    // The fixture issued one key to the admin, none to the reader.
    const response = await call(active, "GET", "/users", fx.adminKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      users: Array<{
        id: string;
        displayName: string;
        role: string;
        allowedUpstreams: string[];
        activeKeys: number;
        totalKeys: number;
        createdAt: string;
      }>;
    };
    const admin = body.users.find((user) => user.id === ADMIN_ID);
    const reader = body.users.find((user) => user.id === READER_ID);
    assert.ok(admin && reader);
    assert.equal(admin.role, "admin");
    assert.equal(admin.activeKeys, 1);
    assert.equal(reader.activeKeys, 1); // reader also got a key in the fixture
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("key_hash") && !serialized.includes("umk_"));
  });

  test("listing members is admin-only: reader gets 403 plus an access_denied row", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const response = await call(active, "GET", "/users", fx.readerKey);
    assert.equal(response.status, 403);
    const denials = fx.auditRepo.byAction("access_denied");
    assert.equal(denials.length, 1);
    assert.equal(denials[0]?.outcome, "denied");
  });

  test("POST /users creates a member, audits user_created, and rejects duplicates", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const created = await call(active, "POST", "/users", fx.adminKey, {
      display_name: "member-one",
      role: "reader",
      allowed_upstreams: ["woocommerce"],
      allowed_tools: ["tools:woocommerce_list_products"],
    });
    assert.equal(created.status, 201);
    const record = (await created.json()) as { id: string; displayName: string; activeKeys: number };
    assert.equal(record.displayName, "member-one");
    assert.equal(record.activeKeys, 0, "a new member starts with no API keys");

    const createdRows = fx.auditRepo.byAction("user_created");
    assert.equal(createdRows.length, 1);
    assert.equal(createdRows[0]?.userId, ADMIN_ID, "the creating admin is the actor");
    assert.equal(createdRows[0]?.outcome, "success");

    // Duplicate display name → 409, no second row.
    const duplicate = await call(active, "POST", "/users", fx.adminKey, {
      display_name: "member-one",
      role: "reader",
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "display_name_in_use" });
    assert.equal(fx.auditRepo.byAction("user_created").length, 1);
  });

  test("POST /users validates role, name and grants server-side", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const badRole = await call(active, "POST", "/users", fx.adminKey, {
      display_name: "sneaky",
      role: "superadmin",
    });
    assert.equal(badRole.status, 400);

    const badUpstream = await call(active, "POST", "/users", fx.adminKey, {
      display_name: "sneaky-two",
      role: "reader",
      allowed_upstreams: ["http://evil"],
    });
    assert.equal(badUpstream.status, 400);

    const badTool = await call(active, "POST", "/users", fx.adminKey, {
      display_name: "sneaky-three",
      role: "reader",
      allowed_tools: ["woocommerce_list_products"],
    });
    assert.equal(badTool.status, 400);

    const shortName = await call(active, "POST", "/users", fx.adminKey, {
      display_name: "x",
      role: "reader",
    });
    assert.equal(shortName.status, 400);

    assert.equal(fx.auditRepo.byAction("user_created").length, 0);
    assert.equal((await call(active, "GET", "/users", fx.adminKey)).status, 200);
  });

  test("POST /users is admin-only: a reader cannot create members", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const response = await call(active, "POST", "/users", fx.readerKey, {
      display_name: "privilege-escalation",
      role: "admin",
    });
    assert.equal(response.status, 403);
    assert.equal(fx.auditRepo.byAction("user_created").length, 0);
    assert.equal((await call(active, "GET", "/users", fx.adminKey)).status, 200);
    const listed = (await (await call(active, "GET", "/users", fx.adminKey)).json()) as { users: Array<{ id: string }> };
    assert.ok(!listed.users.some((user) => user.id === UNKNOWN_ID));
  });

  test("PATCH /users/:id updates role and grants, audits user_updated, 404s unknown ids", async () => {
    const fx = makeFixture();
    active = await startApi(fx);

    const patched = await call(active, "PATCH", `/users/${READER_ID}`, fx.adminKey, {
      role: "admin",
      allowed_upstreams: ["woocommerce", "inventory"],
    });
    assert.equal(patched.status, 200);
    const record = (await patched.json()) as { role: string; allowedUpstreams: string[] };
    assert.equal(record.role, "admin");
    assert.deepEqual(record.allowedUpstreams, ["woocommerce", "inventory"]);
    assert.equal(fx.auditRepo.byAction("user_updated").length, 1);

    const unknown = await call(active, "PATCH", `/users/${UNKNOWN_ID}`, fx.adminKey, { role: "reader" });
    assert.equal(unknown.status, 404);

    const empty = await call(active, "PATCH", `/users/${READER_ID}`, fx.adminKey, {});
    assert.equal(empty.status, 400);

    const notUuid = await call(active, "PATCH", "/users/not-a-uuid", fx.adminKey, { role: "reader" });
    assert.equal(notUuid.status, 400);
  });
});

describe("audit log filters (GET /api/audit)", () => {
  async function seedAudit(fx: Fixture): Promise<void> {
    const rows: Array<Parameters<AuditWriter["record"]>[0]> = [
      {
        action: "tool_call",
        keyId: "key-admin",
        userId: ADMIN_ID,
        role: "admin",
        upstreamId: "woocommerce",
        toolName: "list_products",
        qualifiedName: "woocommerce_list_products",
        outcome: "success",
        durationMs: 5,
        errorCode: null,
      },
      {
        action: "tool_call",
        keyId: "key-reader",
        userId: READER_ID,
        role: "reader",
        upstreamId: "inventory",
        toolName: "adjust_stock",
        qualifiedName: "inventory_adjust_stock",
        outcome: "error",
        durationMs: 7,
        errorCode: "upstream_timeout",
      },
      {
        action: "key_revoked",
        keyId: "key-admin",
        userId: ADMIN_ID,
        role: "admin",
        upstreamId: null,
        toolName: null,
        qualifiedName: null,
        outcome: "success",
        durationMs: 1,
        errorCode: null,
      },
    ];
    for (const row of rows) {
      await fx.audit.record(row);
    }
  }

  test("filters return only matching rows; pagination still applies", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    await seedAudit(fx);

    const toolCalls = await call(active, "GET", "/audit?action=tool_call", fx.adminKey);
    assert.equal(toolCalls.status, 200);
    const toolBody = (await toolCalls.json()) as { entries: Array<{ action: string }> };
    assert.equal(toolBody.entries.length, 2);
    assert.ok(toolBody.entries.every((entry) => entry.action === "tool_call"));

    const failures = await call(active, "GET", "/audit?action=tool_call&outcome=error", fx.adminKey);
    const failureBody = (await failures.json()) as { entries: Array<{ outcome: string; userId: string | null }> };
    assert.equal(failureBody.entries.length, 1);
    assert.equal(failureBody.entries[0]?.outcome, "error");
    assert.equal(failureBody.entries[0]?.userId, READER_ID);

    const byUser = await call(active, "GET", `/audit?userId=${READER_ID}`, fx.adminKey);
    const userBody = (await byUser.json()) as { entries: Array<{ userId: string | null }> };
    assert.ok(userBody.entries.length >= 1);
    assert.ok(userBody.entries.every((entry) => entry.userId === READER_ID));

    const byUpstream = await call(active, "GET", "/audit?upstreamId=inventory", fx.adminKey);
    const upstreamBody = (await byUpstream.json()) as { entries: Array<{ upstreamId: string | null }> };
    assert.equal(upstreamBody.entries.length, 1);
    assert.equal(upstreamBody.entries[0]?.upstreamId, "inventory");

    const byTool = await call(active, "GET", "/audit?tool=woocommerce_list", fx.adminKey);
    const toolMatch = (await byTool.json()) as { entries: Array<{ qualifiedName: string | null }> };
    assert.equal(toolMatch.entries.length, 1);
    assert.equal(toolMatch.entries[0]?.qualifiedName, "woocommerce_list_products");

    // limit interacts with filters (keyset pagination preserved).
    const limited = await call(active, "GET", "/audit?action=tool_call&limit=1", fx.adminKey);
    const limitedBody = (await limited.json()) as { entries: unknown[] };
    assert.equal(limitedBody.entries.length, 1);
  });

  test("invalid filter values are rejected with 400 and never reach SQL", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    await seedAudit(fx);

    const badAction = await call(active, "GET", "/audit?action=made_up", fx.adminKey);
    assert.equal(badAction.status, 400);
    const badOutcome = await call(active, "GET", "/audit?outcome=maybe", fx.adminKey);
    assert.equal(badOutcome.status, 400);
    const badUpstream = await call(active, "GET", "/audit?upstreamId=http", fx.adminKey);
    assert.equal(badUpstream.status, 400);
    const badTool = await call(active, "GET", "/audit?tool=", fx.adminKey);
    assert.equal(badTool.status, 400);
    const badUser = await call(active, "GET", "/audit?userId=drop%20table", fx.adminKey);
    assert.equal(badUser.status, 400);

    // Nothing was filtered in — all rows still there.
    const all = await call(active, "GET", "/audit", fx.adminKey);
    const allBody = (await all.json()) as { entries: unknown[] };
    assert.equal(allBody.entries.length, 3);
  });

  test("audit filters stay admin-only", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    await seedAudit(fx);
    const response = await call(active, "GET", "/audit?action=tool_call", fx.readerKey);
    assert.equal(response.status, 403);
  });
});

describe("WooCommerce store mode label (GET /api/upstreams)", () => {
  test("the configured label is exposed on the woocommerce entry only", async () => {
    const fx = makeFixture();
    active = await startApi(fx, { woocommerceStoreMode: "mock" });
    const response = await call(active, "GET", "/upstreams", fx.adminKey);
    const body = (await response.json()) as { upstreams: Array<{ id: string; mode: string | null }> };
    assert.equal(body.upstreams.find((entry) => entry.id === "woocommerce")?.mode, "mock");
    assert.equal(body.upstreams.find((entry) => entry.id === "inventory")?.mode, null);
    assert.equal(body.upstreams.find((entry) => entry.id === "support")?.mode, null);
  });

  test("unset mode surfaces as null (no label, no guessing)", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const response = await call(active, "GET", "/upstreams", fx.adminKey);
    const body = (await response.json()) as { upstreams: Array<{ id: string; mode: string | null }> };
    assert.ok(body.upstreams.every((entry) => entry.mode === null));
  });
});

describe("connection settings (GET /api/settings)", () => {
  test("returns the MCP endpoint from deploy config, never a guessed URL", async () => {
    const fx = makeFixture();
    active = await startMiniApp((app) => {
      app.use(
        createAuthMiddleware({
          repo: fx.authRepo,
          sessions: fx.sessions,
          pepper: TEST_PEPPER,
          audit: fx.audit,
          logger: fx.logger,
        }),
      );
      app.use(
        API_PREFIX,
        createApiRouter({
          authRepo: fx.authRepo,
          auditRepo: fx.auditRepo,
          audit: fx.audit,
          sessions: fx.sessions,
          upstreamState: fx.upstreamState,
          registry: fx.registry,
          logger: fx.logger,
          pepper: TEST_PEPPER,
          gatewayPublicUrl: "https://mcp.example.com",
        }),
      );
    });
    const response = await call(active, "GET", "/settings", fx.adminKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.mcp_endpoint, "https://mcp.example.com/mcp");
    assert.equal(body.transport, "streamable-http");
    assert.equal(body.auth, "bearer");
    assert.equal(body.chat_enabled, false, "no agent in this fixture");
    assert.ok(!JSON.stringify(body).includes("umk_"));
  });

  test("without GATEWAY_PUBLIC_URL the endpoint is null (no invented localhost)", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    const response = await call(active, "GET", "/settings", fx.adminKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { mcp_endpoint: string | null; mcp_path: string };
    assert.equal(body.mcp_endpoint, null);
    assert.equal(body.mcp_path, "/mcp");
  });

  test("settings require authentication", async () => {
    const fx = makeFixture();
    active = await startApi(fx);
    assert.equal((await call(active, "GET", "/settings")).status, 401);
  });
});
