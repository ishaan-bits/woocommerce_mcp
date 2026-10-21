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
});
