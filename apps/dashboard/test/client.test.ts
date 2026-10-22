import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, createApiClient, ForbiddenError, UnauthorizedError, type FetchLike } from "../src/api/client.ts";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

describe("dashboard API client", () => {
  test("every request targets relative /api paths with same-origin credentials (no gateway URL in the browser)", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({}));
    const api = createApiClient(fetchImpl);

    await api.login("umk_test");
    await api.logout();
    await api.me();
    await api.tools();
    await api.upstreams();
    await api.setUpstream("woocommerce", false);
    await api.audit(50);

    assert.equal(calls.length, 7);
    for (const call of calls) {
      assert.ok(call.url.startsWith("/api/"), `expected relative /api path, got ${call.url}`);
      assert.ok(!call.url.includes("://"), "no absolute URLs — the gateway origin never enters the client bundle");
      assert.equal(call.init?.credentials, "same-origin");
    }
    assert.deepEqual(
      calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`),
      [
        "POST /api/auth/login",
        "POST /api/auth/logout",
        "GET /api/me",
        "GET /api/tools",
        "GET /api/upstreams",
        "POST /api/upstreams/woocommerce:disable",
        "GET /api/audit?limit=50",
      ],
    );
  });

  test("login sends the key only in the JSON body, never in the URL", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        user_id: "u",
        display_name: "admin-demo",
        role: "admin",
        allowed_upstreams: [],
        allowed_tools: [],
        key_id: "k",
      }),
    );
    const api = createApiClient(fetchImpl);

    const me = await api.login("umk_super_secret_value");
    assert.equal(me.role, "admin");
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.ok(!call.url.includes("umk_"), "key must not appear in the URL");
    assert.equal(bodyOf(call).key, "umk_super_secret_value");
    assert.equal(call.init?.credentials, "same-origin");
  });

  test("401 becomes UnauthorizedError and 403 becomes ForbiddenError (with server code)", async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.includes("/me")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ error: "forbidden" }, 403);
    });
    const api = createApiClient(fetchImpl);

    await assert.rejects(() => api.me(), (error: unknown) => {
      assert.ok(error instanceof UnauthorizedError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "unauthorized");
      return true;
    });

    await assert.rejects(() => api.setUpstream("woocommerce", true), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "forbidden");
      return true;
    });
  });

  test("server errors surface their safe code; unreachable gateway maps to gateway_unreachable", async () => {
    const { fetchImpl: failing } = recordingFetch(() => jsonResponse({ error: "internal_error" }, 500));
    const failingApi = createApiClient(failing);
    await assert.rejects(() => failingApi.tools(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.code, "internal_error");
      return true;
    });

    const offline = createApiClient(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(() => offline.upstreams(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      assert.equal(error.code, "gateway_unreachable");
      return true;
    });

    // Non-JSON error body (e.g. a proxy failure page) still yields a usable error.
    const { fetchImpl: html } = recordingFetch(
      () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );
    const htmlApi = createApiClient(html);
    await assert.rejects(() => htmlApi.me(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "error");
      return true;
    });
  });

  test("audit queries are bounded and use the keyset cursor, never an unbounded fetch", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ entries: [] }));
    const api = createApiClient(fetchImpl);

    await api.audit(100);
    await api.audit(10, "1234");
    assert.equal(calls[0]?.url, "/api/audit?limit=100");
    assert.equal(calls[1]?.url, "/api/audit?limit=10&before=1234");
    assert.ok(!calls[0]!.url.includes("offset"), "keyset pagination only — no OFFSET");
  });

  test("toggle responses are returned verbatim for the UI (changed flag)", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ id: "woocommerce", enabled: false, changed: true }));
    const api = createApiClient(fetchImpl);
    const result = await api.setUpstream("woocommerce", false);
    assert.deepEqual(result, { id: "woocommerce", enabled: false, changed: true });
  });

  test("chat posts message + bounded history to relative /api/chat with no credentials in the body", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ reply: "ok", tool_calls: [{ name: "woocommerce_list_products", outcome: "success" }], rounds: 2 }),
    );
    const api = createApiClient(fetchImpl);
    const result = await api.chat("list products", [{ role: "user", content: "hi" }]);

    assert.equal(calls[0]?.url, "/api/chat");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal((calls[0]?.init?.headers as Record<string, string>)["content-type"], "application/json");
    const body = bodyOf(calls[0]!);
    assert.deepEqual(body, { message: "list products", history: [{ role: "user", content: "hi" }] });
    // The browser never holds or sends an LLM key.
    assert.ok(!JSON.stringify(body).includes("gsk_"));
    assert.deepEqual(result.tool_calls, [{ name: "woocommerce_list_products", outcome: "success" }]);
  });

  test("503 agent_not_configured surfaces its code so the UI can show the setup hint", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: "agent_not_configured", message: "Set GROQ_API_KEY" }, 503),
    );
    const api = createApiClient(fetchImpl);
    await assert.rejects(
      () => api.chat("hi"),
      (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "agent_not_configured",
    );
  });
});

describe("admin surface methods (users, keys, settings)", () => {
  test("typed methods target the exact gateway paths", async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.includes("/settings")) return jsonResponse({ mcp_endpoint: null, mcp_path: "/mcp", transport: "streamable-http", auth: "bearer", session_header: "mcp-session-id", chat_enabled: false });
      if (call.url.includes("/users") && call.init?.method === "POST") return jsonResponse({ id: "u1" }, 201);
      if (call.url.includes("/users/") && call.init?.method === "PATCH") return jsonResponse({ id: "u1" });
      if (call.url.includes("/users")) return jsonResponse({ users: [] });
      if (call.url.includes("/keys/") && call.url.endsWith("/revoke")) return jsonResponse({ id: "k1", revoked_at: "2026-01-01T00:00:00Z", already_revoked: false });
      if (call.url.includes("/keys") && call.init?.method === "POST") return jsonResponse({ id: "k1", user_id: "u1", key_prefix: "umk_ab", created_at: "2026-01-01T00:00:00Z", revoked_at: null, key: "umk_plaintext" }, 201);
      if (call.url.includes("/keys")) return jsonResponse({ keys: [] });
      return jsonResponse({ entries: [] });
    });
    const api = createApiClient(fetchImpl);

    const settings = await api.settings();
    assert.equal(settings.transport, "streamable-http");
    await api.users();
    await api.createUser({ display_name: "Ada", role: "reader", allowed_upstreams: ["woocommerce"], allowed_tools: [] });
    await api.updateUser("u1", { role: "admin" });
    await api.keys();
    const issued = await api.issueKey("u1");
    assert.equal(issued.key, "umk_plaintext", "the client surfaces the one-time key verbatim for the modal");
    await api.revokeKey("k1");

    assert.deepEqual(
      calls.map((call) => `${call.init?.method ?? "GET"} ${call.url.split("?")[0]}`),
      [
        "GET /api/settings",
        "GET /api/users",
        "POST /api/users",
        "PATCH /api/users/u1",
        "GET /api/keys",
        "POST /api/keys",
        "POST /api/keys/k1/revoke",
      ],
    );
    // Every call stays relative + same-origin.
    for (const call of calls) {
      assert.ok(call.url.startsWith("/api/"));
      assert.equal(call.init?.credentials, "same-origin");
    }
  });

  test("POST /users and PATCH /users/:id send the documented snake_case body", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ id: "u1" }, 201));
    const api = createApiClient(fetchImpl);
    await api.createUser({ display_name: "Ada Lovelace", role: "reader", allowed_upstreams: ["inventory"], allowed_tools: ["tools:inventory_check_stock"] });
    assert.deepEqual(bodyOf(calls[0]!), {
      display_name: "Ada Lovelace",
      role: "reader",
      allowed_upstreams: ["inventory"],
      allowed_tools: ["tools:inventory_check_stock"],
    });
    await api.updateUser("u1", { allowed_upstreams: ["support"] });
    assert.deepEqual(bodyOf(calls[1]!), { allowed_upstreams: ["support"] });
    assert.equal(calls[1]?.init?.method, "PATCH");
  });

  test("issueKey posts {user_id} and revokeKey hits /keys/:id/revoke", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ id: "k", revoked_at: null, already_revoked: true }));
    const api = createApiClient(fetchImpl);
    await api.issueKey("user-1");
    assert.equal(calls[0]?.url, "/api/keys");
    assert.deepEqual(bodyOf(calls[0]!), { user_id: "user-1" });
    const result = await api.revokeKey("k");
    assert.equal(calls[1]?.url, "/api/keys/k/revoke");
    assert.equal(result.already_revoked, true);
  });

  test("audit filters map to whitelisted query params; empty values are omitted", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ entries: [] }));
    const api = createApiClient(fetchImpl);
    await api.audit(25, "999", { action: "tool_call", outcome: "error", upstreamId: "woocommerce", tool: "list_products", userId: "u1" });
    const params = new URLSearchParams(calls[0]?.url.split("?")[1]);
    assert.deepEqual(Object.fromEntries(params.entries()), {
      limit: "25",
      before: "999",
      action: "tool_call",
      outcome: "error",
      upstreamId: "woocommerce",
      tool: "list_products",
      userId: "u1",
    });
    await api.audit(10, undefined, { action: "", tool: "  " });
    assert.equal(calls[1]?.url, "/api/audit?limit=10", "blank filters are never sent");
  });

  test("chat passes an AbortController signal through to fetch", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ reply: "ok", tool_calls: [], rounds: 1 }));
    const api = createApiClient(fetchImpl);
    const controller = new AbortController();
    await api.chat("hi", [], controller.signal);
    assert.equal(calls[0]?.init?.signal, controller.signal);
    // Without a signal nothing is attached.
    await api.chat("hi again");
    assert.equal(calls[1]?.init?.signal, undefined);
  });

  test("error bodies with a message surface it (chat provider errors)", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: "provider_rate_limited", message: "The LLM provider is rate limiting requests; try again shortly." }, 429),
    );
    const api = createApiClient(fetchImpl);
    await assert.rejects(() => api.chat("hi"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "provider_rate_limited");
      assert.ok(error.message.includes("rate limiting"));
      return true;
    });
  });
});
