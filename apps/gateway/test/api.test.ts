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

function startApi(fx: Fixture): Promise<MiniApp> {
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
