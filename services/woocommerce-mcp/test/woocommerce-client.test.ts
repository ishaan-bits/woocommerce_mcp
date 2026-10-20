import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isUpstreamError, UpstreamError } from "../src/errors.ts";
import { WooCommerceClient } from "../src/woocommerce-client.ts";

const CONSUMER_KEY = "ck_unit_test_key";
const CONSUMER_SECRET = "cs_unit_test_secret";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`, "utf8").toString("base64")}`;

interface CapturedCall {
  url: URL;
  init: RequestInit;
}

function capturingFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const resolved = init ?? {};
    calls.push({ url, init: resolved });
    return handler(url, resolved);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function clientWith(fetchImpl: typeof fetch, timeoutMs = 5000): WooCommerceClient {
  return new WooCommerceClient({
    storeUrl: "https://store.test",
    consumerKey: CONSUMER_KEY,
    consumerSecret: CONSUMER_SECRET,
    timeoutMs,
    fetchImpl,
  });
}

function headers(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

function firstCall(calls: CapturedCall[]): CapturedCall {
  const call = calls[0];
  if (call === undefined) {
    throw new Error("expected at least one captured call");
  }
  return call;
}

function json(data: unknown, status = 200, responseHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...responseHeaders },
  });
}

async function expectUpstreamError(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isUpstreamError(error), `expected UpstreamError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("WooCommerceClient request basics", () => {
  test("sends Basic auth, builds the wc/v3 URL and defaults pagination params", async () => {
    const { fetchImpl, calls } = capturingFetch(() => json([], 200, { "X-WP-Total": "0", "X-WP-TotalPages": "0" }));
    const client = clientWith(fetchImpl);
    const result = await client.listProducts();

    assert.equal(calls.length, 1);
    assert.equal(firstCall(calls).url.origin, "https://store.test");
    assert.equal(firstCall(calls).url.pathname, "/wp-json/wc/v3/products");
    assert.equal(firstCall(calls).url.searchParams.get("page"), "1");
    assert.equal(firstCall(calls).url.searchParams.get("per_page"), "10");
    assert.equal(headers(firstCall(calls).init).authorization, EXPECTED_AUTH);
    assert.equal(headers(firstCall(calls).init).accept, "application/json");
    assert.ok(firstCall(calls).init.signal instanceof AbortSignal);
    assert.equal(firstCall(calls).init.redirect, "error");
    assert.deepEqual(result.pagination, { page: 1, per_page: 10, total: 0, total_pages: 0 });
    assert.deepEqual(result.items, []);
  });

  test("maps list_products params onto WooCommerce query parameters", async () => {
    const { fetchImpl, calls } = capturingFetch(() => json([]));
    await clientWith(fetchImpl).listProducts({ page: 2, perPage: 5, search: "Tea", status: "publish" });
    assert.equal(firstCall(calls).url.searchParams.get("page"), "2");
    assert.equal(firstCall(calls).url.searchParams.get("per_page"), "5");
    assert.equal(firstCall(calls).url.searchParams.get("search"), "Tea");
    assert.equal(firstCall(calls).url.searchParams.get("status"), "publish");
  });

  test("reads X-WP-Total and X-WP-TotalPages into pagination", async () => {
    const { fetchImpl } = capturingFetch(() =>
      json([{ id: 1, name: "Tea" }], 200, { "X-WP-Total": "42", "X-WP-TotalPages": "5" }),
    );
    const result = await clientWith(fetchImpl).listProducts({ page: 3, perPage: 9 });
    assert.deepEqual(result.pagination, { page: 3, per_page: 9, total: 42, total_pages: 5 });
    assert.equal(result.items[0]?.name, "Tea");
  });

  test("sends list_orders date filters with dates_are_gmt defaulting to true", async () => {
    const { fetchImpl, calls } = capturingFetch(() => json([]));
    await clientWith(fetchImpl).listOrders({ after: "2024-01-01T00:00:00Z", before: "2024-02-01T00:00:00Z" });
    const url = firstCall(calls).url;
    assert.equal(url.pathname, "/wp-json/wc/v3/orders");
    assert.equal(url.searchParams.get("after"), "2024-01-01T00:00:00Z");
    assert.equal(url.searchParams.get("before"), "2024-02-01T00:00:00Z");
    assert.equal(url.searchParams.get("dates_are_gmt"), "true");
  });

  test("createProduct posts WooCommerce snake_case fields", async () => {
    const { fetchImpl, calls } = capturingFetch(() => json({ id: 7, name: "Tea", regular_price: "19.99" }, 201));
    const product = await clientWith(fetchImpl).createProduct({
      name: "Tea",
      regularPrice: "19.99",
      sku: "SKU-1",
      stockQuantity: 3,
    });
    assert.equal(firstCall(calls).init.method, "POST");
    assert.equal(firstCall(calls).url.pathname, "/wp-json/wc/v3/products");
    assert.equal(headers(firstCall(calls).init)["content-type"], "application/json");
    assert.deepEqual(JSON.parse(String(firstCall(calls).init.body)), {
      name: "Tea",
      regular_price: "19.99",
      sku: "SKU-1",
      stock_quantity: 3,
    });
    assert.equal(product.id, 7);
  });

  test("updateOrderStatus sends a PUT with only the status field", async () => {
    const { fetchImpl, calls } = capturingFetch(() => json({ id: 12, status: "completed" }));
    const order = await clientWith(fetchImpl).updateOrderStatus(12, "completed");
    assert.equal(firstCall(calls).init.method, "PUT");
    assert.equal(firstCall(calls).url.pathname, "/wp-json/wc/v3/orders/12");
    assert.deepEqual(JSON.parse(String(firstCall(calls).init.body)), { status: "completed" });
    assert.equal(order.status, "completed");
  });
});

describe("WooCommerceClient error mapping", () => {
  test("maps 404 to not_found with the caller-supplied message", async () => {
    const { fetchImpl } = capturingFetch(() => json({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." }, 404));
    const error = await expectUpstreamError(clientWith(fetchImpl).getOrder(99));
    assert.equal(error.code, "not_found");
    assert.match(error.message, /Order 99 was not found on the store\./);
    assert.equal(error.details.status, 404);
    assert.equal(error.details.wooCode, "woocommerce_rest_shop_order_invalid_id");
  });

  test("maps 401 to an http error that mentions HTTPS Basic auth", async () => {
    const { fetchImpl } = capturingFetch(() =>
      json({ code: "woocommerce_rest_authentication_error", message: "Consumer secret is invalid." }, 401),
    );
    const error = await expectUpstreamError(clientWith(fetchImpl).listProducts());
    assert.equal(error.code, "http");
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /HTTPS/);
    assert.match(error.message, /Consumer secret is invalid\./);
  });

  test("maps 403 to a permissions hint", async () => {
    const { fetchImpl } = capturingFetch(() => json({ message: "You cannot do that." }, 403));
    const error = await expectUpstreamError(clientWith(fetchImpl).updateOrderStatus(1, "completed"));
    assert.equal(error.code, "http");
    assert.match(error.message, /write permission/);
  });

  test("maps other HTTP failures to http with status and store message", async () => {
    const { fetchImpl } = capturingFetch(() => json({ message: "Simulated boom" }, 500));
    const error = await expectUpstreamError(clientWith(fetchImpl).listOrders());
    assert.equal(error.code, "http");
    assert.match(error.message, /HTTP 500/);
    assert.match(error.message, /Simulated boom/);
  });

  test("maps non-JSON success bodies to malformed_response", async () => {
    const { fetchImpl } = capturingFetch(
      () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const error = await expectUpstreamError(clientWith(fetchImpl).listProducts());
    assert.equal(error.code, "malformed_response");
    assert.match(error.message, /non-JSON/);
  });

  test("maps JSON with the wrong shape to malformed_response", async () => {
    const { fetchImpl } = capturingFetch(() => json({ products: [] }));
    const error = await expectUpstreamError(clientWith(fetchImpl).listProducts());
    assert.equal(error.code, "malformed_response");
  });

  test("maps AbortSignal timeouts to a timeout error mentioning the configured budget", async () => {
    const { fetchImpl } = capturingFetch(() => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    const error = await expectUpstreamError(clientWith(fetchImpl, 1234).listProducts());
    assert.equal(error.code, "timeout");
    assert.match(error.message, /1234 ms/);
  });

  test("maps fetch failures to a connection error naming the store origin", async () => {
    const { fetchImpl } = capturingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await expectUpstreamError(clientWith(fetchImpl).listProducts());
    assert.equal(error.code, "connection");
    assert.match(error.message, /https:\/\/store\.test/);
  });

  test("surfaces redirect failures with a clear message", async () => {
    const { fetchImpl } = capturingFetch(() => {
      const error = new TypeError("fetch failed");
      error.cause = new Error("redirect");
      throw error;
    });
    const error = await expectUpstreamError(clientWith(fetchImpl).listProducts());
    assert.equal(error.code, "connection");
    assert.match(error.message, /redirected/);
  });

  test("never includes the consumer secret in error messages", async () => {
    const { fetchImpl } = capturingFetch(() => json({ message: "nope" }, 401));
    const error = await expectUpstreamError(clientWith(fetchImpl).listProducts());
    assert.ok(!error.message.includes(CONSUMER_SECRET));
    assert.ok(!String(error).includes(CONSUMER_SECRET));
  });
});
