import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Express } from "express";
import { createAuditWriter, type AuditWriter } from "../src/audit.ts";
import { createAuthMiddleware, principalOf } from "../src/auth/middleware.ts";
import { generateApiKey } from "../src/auth/keys.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import { createSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/sessions.ts";
import { FakeAuditRepository, FakeAuthRepository, FakeSessionRepository } from "./helpers/fake-repos.ts";
import { startMiniApp, type MiniApp } from "./helpers/mini-app.ts";
import { TEST_PEPPER } from "./helpers/config.ts";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const READER_ID = "22222222-2222-4222-8222-222222222222";

interface Fixture {
  authRepo: FakeAuthRepository;
  auditRepo: FakeAuditRepository;
  audit: AuditWriter;
  sessions: FakeSessionRepository;
  lines: string[];
  logger: Logger;
  pepper: string;
}

function makeFixture(): Fixture {
  const authRepo = new FakeAuthRepository();
  authRepo.seedUser({
    id: ADMIN_ID,
    displayName: "admin-demo",
    role: "admin",
    allowedUpstreams: ["woocommerce", "inventory", "support"],
    allowedTools: ["tools:woocommerce_list_products", "tools:woocommerce_create_order"],
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
  return { authRepo, auditRepo, audit, sessions: new FakeSessionRepository(), lines, logger, pepper: TEST_PEPPER };
}

async function startAuthApp(fx: Fixture, build?: (app: Express) => void): Promise<MiniApp> {
  return startMiniApp((app) => {
    app.use(
      createAuthMiddleware({
        repo: fx.authRepo,
        sessions: fx.sessions,
        pepper: fx.pepper,
        audit: fx.audit,
        logger: fx.logger,
      }),
    );
    app.get("/healthz", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.get("/me", (req, res) => {
      const principal = principalOf(req);
      res.json({ principal });
    });
    build?.(app);
  });
}

let active: MiniApp | null = null;
afterEach(async () => {
  if (active !== null) {
    await active.close();
    active = null;
  }
});

async function get(app: MiniApp, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.origin}${path}`, { headers });
}

describe("auth middleware (B2, C1)", () => {
  test("a valid, unrevoked key sets the principal and writes no auth_failed row", async () => {
    const fx = makeFixture();
    const issued = fx.authRepo.issueKey(ADMIN_ID, fx.pepper);
    active = await startAuthApp(fx);

    const response = await get(active, "/me", { authorization: `Bearer ${issued.key}` });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { principal: { userId: string; role: string; keyId: string } | null };
    assert.equal(body.principal?.userId, ADMIN_ID);
    assert.equal(body.principal?.role, "admin");
    assert.equal(body.principal?.keyId, issued.keyId);
    assert.equal(fx.auditRepo.byAction("auth_failed").length, 0);
  });

  test("every credential failure returns the identical 401 body (no oracle) with an exact audit reason", async () => {
    const fx = makeFixture();
    const issued = fx.authRepo.issueKey(ADMIN_ID, fx.pepper);
    active = await startAuthApp(fx);

    // Same 12-char prefix, tampered body: reaches the row, fails the hash.
    const wrongPrefix = `umk_${issued.key.slice(4, 12)}${"A".repeat(35)}`;
    const cases: Array<{ headers: Record<string, string>; errorCode: string }> = [
      { headers: {}, errorCode: "missing_credentials" },
      { headers: { authorization: "Basic dXNlcjpwdw==" }, errorCode: "malformed_credentials" },
      { headers: { authorization: "Bearer not-a-key" }, errorCode: "invalid_format" },
      { headers: { authorization: `Bearer umk_${"A".repeat(43)}` }, errorCode: "unknown_key" },
      { headers: { authorization: `Bearer ${wrongPrefix}` }, errorCode: "invalid_key" },
    ];

    for (const entry of cases) {
      const response = await get(active, "/me", entry.headers);
      assert.equal(response.status, 401, entry.errorCode);
      assert.deepEqual(await response.json(), { error: "unauthorized" }, entry.errorCode);
    }

    const failures = fx.auditRepo.byAction("auth_failed");
    assert.equal(failures.length, cases.length);
    assert.deepEqual(
      [...new Set(failures.map((row) => row.errorCode))].sort(),
      ["invalid_format", "invalid_key", "malformed_credentials", "missing_credentials", "unknown_key"],
    );
    // No failure row ever carries a full key.
    assert.ok(!JSON.stringify(failures).includes(issued.key));
  });

  test("a revoked key is rejected on the next request", async () => {
    const fx = makeFixture();
    const issued = fx.authRepo.issueKey(ADMIN_ID, fx.pepper);
    active = await startAuthApp(fx);

    const first = await get(active, "/me", { authorization: `Bearer ${issued.key}` });
    assert.equal(first.status, 200);

    fx.authRepo.revokeByKeyId(issued.keyId);

    const second = await get(active, "/me", { authorization: `Bearer ${issued.key}` });
    assert.equal(second.status, 401);
    assert.deepEqual(await second.json(), { error: "unauthorized" });
    const revoked = fx.auditRepo.byAction("auth_failed").find((row) => row.errorCode === "revoked_key");
    assert.ok(revoked);
    assert.equal(revoked?.keyId, issued.keyId);
  });

  test("a database outage fails closed with 503 and a diagnostic, not an audit row through the dead store", async () => {
    const fx = makeFixture();
    const issued = fx.authRepo.issueKey(ADMIN_ID, fx.pepper);
    fx.authRepo.down = true;
    active = await startAuthApp(fx);

    const response = await get(active, "/me", { authorization: `Bearer ${issued.key}` });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
    assert.ok(fx.lines.some((line) => line.includes("auth_lookup_failed")));
    assert.equal(fx.auditRepo.entries.length, 0);
  });

  test("operational probes stay public and unauthenticated (D21)", async () => {
    const fx = makeFixture();
    active = await startAuthApp(fx);

    const response = await get(active, "/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(fx.auditRepo.entries.length, 0);
  });

  test("principalOf returns null on a request that bypassed the middleware", async () => {
    active = await startMiniApp((app) => {
      app.get("/raw", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });
    const response = await get(active, "/raw");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { principal: null });
  });
});

describe("dashboard session cookie (D23)", () => {
  function issueSession(fx: Fixture, userId: string, expiresAtMs = 60_000): { token: string; keyId: string } {
    const issued = fx.authRepo.issueKey(userId, fx.pepper);
    const token = createSessionToken();
    void fx.sessions.create({
      tokenHash: hashSessionToken(token),
      userId,
      keyId: issued.keyId,
      expiresAt: new Date(Date.now() + expiresAtMs).toISOString(),
    });
    return { token, keyId: issued.keyId };
  }

  test("a valid session cookie authenticates /api requests; the principal comes from the bound key", async () => {
    const fx = makeFixture();
    const { token, keyId } = issueSession(fx, ADMIN_ID);
    active = await startAuthApp(fx, (app) => {
      app.get("/api/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/api/whoami", { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { principal: { userId: string; role: string; keyId: string } | null };
    assert.equal(body.principal?.userId, ADMIN_ID);
    assert.equal(body.principal?.role, "admin");
    // The session row binds to the key that created it (revocation propagates).
    assert.equal(body.principal?.keyId, keyId);
    assert.equal(fx.auditRepo.byAction("auth_failed").length, 0);
  });

  test("the cookie is ignored outside /api, so /mcp keeps its Bearer-only contract", async () => {
    const fx = makeFixture();
    const { token } = issueSession(fx, ADMIN_ID);
    active = await startAuthApp(fx, (app) => {
      app.get("/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/whoami", { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    const failures = fx.auditRepo.byAction("auth_failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.errorCode, "missing_credentials");
  });

  test("an expired session denies with expired_session and the row is cleaned up", async () => {
    const fx = makeFixture();
    const { token } = issueSession(fx, ADMIN_ID, -1_000);
    active = await startAuthApp(fx, (app) => {
      app.get("/api/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/api/whoami", { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(fx.auditRepo.byAction("auth_failed")[0]?.errorCode, "expired_session");
    assert.equal(await fx.sessions.find(hashSessionToken(token)), null);
  });

  test("revoking the key kills the live session on its next request", async () => {
    const fx = makeFixture();
    const { token } = issueSession(fx, ADMIN_ID);
    const issuedRow = await fx.sessions.find(hashSessionToken(token));
    assert.ok(issuedRow !== null);
    fx.authRepo.revokeByKeyId(issuedRow.keyId);
    active = await startAuthApp(fx, (app) => {
      app.get("/api/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/api/whoami", { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(fx.auditRepo.byAction("auth_failed")[0]?.errorCode, "revoked_key");
  });

  test("an unknown cookie token denies with unknown_session (same 401 body)", async () => {
    const fx = makeFixture();
    active = await startAuthApp(fx, (app) => {
      app.get("/api/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/api/whoami", { cookie: `${SESSION_COOKIE_NAME}=forged-token` });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(fx.auditRepo.byAction("auth_failed")[0]?.errorCode, "unknown_session");
  });

  test("a session-store outage fails closed with 503, not a diagnostic", async () => {
    const fx = makeFixture();
    const { token } = issueSession(fx, ADMIN_ID);
    fx.sessions.down = true;
    active = await startAuthApp(fx, (app) => {
      app.get("/api/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/api/whoami", { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  });

  test("a present Authorization header always wins over the cookie (malformed bearer denies)", async () => {
    const fx = makeFixture();
    const { token } = issueSession(fx, ADMIN_ID);
    active = await startAuthApp(fx, (app) => {
      app.get("/api/whoami", (req, res) => {
        res.json({ principal: principalOf(req) });
      });
    });

    const response = await get(active, "/api/whoami", {
      authorization: "Bearer",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    assert.equal(response.status, 401);
    assert.equal(fx.auditRepo.byAction("auth_failed")[0]?.errorCode, "malformed_credentials");
  });
});
