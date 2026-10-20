export interface MockProduct {
  id: number;
  name: string;
  regular_price?: string;
  status?: string;
  [key: string]: unknown;
}

export interface MockOrder {
  id: number;
  status: string;
  date_created?: string;
  [key: string]: unknown;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FailMode =
  | { kind: "status"; status: number; body?: unknown }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "malformed" };

export interface MockStoreOptions {
  products?: MockProduct[];
  orders?: MockOrder[];
  expectedAuth?: string;
}

export interface MockStore {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  products: MockProduct[];
  orders: MockOrder[];
  setFail(mode: FailMode | null): void;
}

const ORDER_WRITE_STATUSES = new Set([
  "pending",
  "processing",
  "completed",
  "on-hold",
  "cancelled",
  "refunded",
  "failed",
]);

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pageSlice<T>(items: T[], page: number, perPage: number): Response {
  const start = (page - 1) * perPage;
  return json(items.slice(start, start + perPage), 200, {
    "X-WP-Total": String(items.length),
    "X-WP-TotalPages": String(Math.ceil(items.length / perPage)),
  });
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function createMockStore(options: MockStoreOptions = {}): MockStore {
  const products: MockProduct[] = [...(options.products ?? [])];
  const orders: MockOrder[] = [...(options.orders ?? [])];
  const calls: RecordedCall[] = [];
  let failMode: FailMode | null = null;
  let nextProductId = 1000;
  let nextOrderId = 2000;

  async function respond(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url: url.toString(), headers, body });

    if (failMode !== null) {
      const mode = failMode;
      if (mode.kind === "network") {
        throw new TypeError("fetch failed");
      }
      if (mode.kind === "timeout") {
        throw new DOMException("The operation timed out", "TimeoutError");
      }
      if (mode.kind === "malformed") {
        return new Response("<html>definitely not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return json(mode.body ?? { code: "woocommerce_rest_error", message: "Simulated failure" }, mode.status);
    }

    if (options.expectedAuth !== undefined && headers.authorization !== options.expectedAuth) {
      return json({ code: "woocommerce_rest_authentication_error", message: "Consumer secret is invalid." }, 401);
    }

    const path = url.pathname;
    const basePath = "/wp-json/wc/v3";

    if (!path.startsWith(basePath)) {
      return json({ code: "woocommerce_rest_no_route", message: "No route was found matching the URL and request method." }, 404);
    }
    const resourcePath = path.slice(basePath.length);
    const orderMatch = /^\/orders\/(\d+)$/.exec(resourcePath);

    if (method === "GET" && resourcePath === "/products") {
      let filtered = [...products];
      const search = url.searchParams.get("search");
      if (search !== null) {
        filtered = filtered.filter((product) => product.name.toLowerCase().includes(search.toLowerCase()));
      }
      const status = url.searchParams.get("status");
      if (status !== null && status !== "any") {
        filtered = filtered.filter((product) => (product.status ?? "publish") === status);
      }
      const page = positiveInt(url.searchParams.get("page"), 1);
      const perPage = positiveInt(url.searchParams.get("per_page"), 10);
      return pageSlice(filtered, page, perPage);
    }

    if (method === "POST" && resourcePath === "/products") {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.name !== "string" || typeof input.regular_price !== "string") {
        return json(
          { code: "woocommerce_rest_missing_required_param", message: "Missing parameter(s): name, regular_price" },
          400,
        );
      }
      const product: MockProduct = {
        id: nextProductId++,
        name: input.name,
        regular_price: input.regular_price,
        status: typeof input.status === "string" ? input.status : "publish",
      };
      if (typeof input.sku === "string") product.sku = input.sku;
      if (typeof input.description === "string") product.description = input.description;
      if (typeof input.stock_quantity === "number") product.stock_quantity = input.stock_quantity;
      products.push(product);
      return json(product, 201);
    }

    if (method === "GET" && resourcePath === "/orders") {
      let filtered = [...orders];
      const search = url.searchParams.get("search");
      if (search !== null) {
        filtered = filtered.filter(
          (order) =>
            String(order.id).includes(search) ||
            (typeof order.customer_note === "string" && order.customer_note.toLowerCase().includes(search.toLowerCase())),
        );
      }
      const status = url.searchParams.get("status");
      if (status !== null && status !== "any") {
        filtered = filtered.filter((order) => order.status === status);
      }
      const after = url.searchParams.get("after");
      if (after !== null && !Number.isNaN(Date.parse(after))) {
        filtered = filtered.filter(
          (order) => order.date_created !== undefined && Date.parse(order.date_created) > Date.parse(after),
        );
      }
      const before = url.searchParams.get("before");
      if (before !== null && !Number.isNaN(Date.parse(before))) {
        filtered = filtered.filter(
          (order) => order.date_created !== undefined && Date.parse(order.date_created) < Date.parse(before),
        );
      }
      const page = positiveInt(url.searchParams.get("page"), 1);
      const perPage = positiveInt(url.searchParams.get("per_page"), 10);
      return pageSlice(filtered, page, perPage);
    }

    if (orderMatch !== null) {
      const orderId = Number(orderMatch[1]);
      const order = orders.find((candidate) => candidate.id === orderId);
      if (order === undefined) {
        return json({ code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." }, 404);
      }
      if (method === "GET") {
        return json(order);
      }
      if (method === "PUT") {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.status !== "string" || !ORDER_WRITE_STATUSES.has(input.status)) {
          return json({ code: "woocommerce_rest_shop_order_invalid_status", message: "Invalid order status." }, 400);
        }
        order.status = input.status;
        return json(order);
      }
    }

    return json({ code: "woocommerce_rest_no_route", message: "No route was found matching the URL and request method." }, 404);
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return respond(url, init ?? {});
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    products,
    orders,
    setFail(mode: FailMode | null): void {
      failMode = mode;
    },
  };
}
