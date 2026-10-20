import type { z } from "zod";
import { UpstreamError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import {
  orderListSchema,
  orderSchema,
  productListSchema,
  productSchema,
  type Order,
  type Pagination,
  type Product,
} from "./woocommerce-types.ts";

export interface WooCommerceClientOptions {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface ListProductsParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
}

export interface CreateProductInput {
  name: string;
  regularPrice: string;
  description?: string;
  sku?: string;
  stockQuantity?: number;
  status?: string;
}

export interface ListOrdersParams {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
  after?: string;
  before?: string;
  datesAreGmt?: boolean;
}

export interface ListResult<T> {
  items: T[];
  pagination: Pagination;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  notFoundMessage?: string;
}

interface RawResponse {
  data: unknown;
  pagination: Pagination;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberHeader(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class WooCommerceClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: WooCommerceClientOptions) {
    this.origin = new URL(options.storeUrl).origin;
    this.baseUrl = `${options.storeUrl.replace(/\/+$/, "")}/wp-json/wc/v3`;
    this.authHeader = `Basic ${Buffer.from(`${options.consumerKey}:${options.consumerSecret}`, "utf8").toString("base64")}`;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async listProducts(params: ListProductsParams = {}): Promise<ListResult<Product>> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? 10;
    const query: Record<string, string | number> = { page, per_page: perPage };
    if (params.search !== undefined) {
      query.search = params.search;
    }
    if (params.status !== undefined) {
      query.status = params.status;
    }
    const raw = await this.request("GET", "/products", { query });
    return { items: this.parseList(raw.data, productListSchema, "GET", "/products"), pagination: raw.pagination };
  }

  async createProduct(input: CreateProductInput): Promise<Product> {
    const body: Record<string, unknown> = {
      name: input.name,
      regular_price: input.regularPrice,
    };
    if (input.description !== undefined) {
      body.description = input.description;
    }
    if (input.sku !== undefined) {
      body.sku = input.sku;
    }
    if (input.stockQuantity !== undefined) {
      body.stock_quantity = input.stockQuantity;
    }
    if (input.status !== undefined) {
      body.status = input.status;
    }
    const raw = await this.request("POST", "/products", { body });
    return this.parseOne(raw.data, productSchema, "POST", "/products");
  }

  async listOrders(params: ListOrdersParams = {}): Promise<ListResult<Order>> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? 10;
    const query: Record<string, string | number | boolean> = { page, per_page: perPage };
    if (params.search !== undefined) {
      query.search = params.search;
    }
    if (params.status !== undefined) {
      query.status = params.status;
    }
    if (params.after !== undefined) {
      query.after = params.after;
    }
    if (params.before !== undefined) {
      query.before = params.before;
    }
    query.dates_are_gmt = params.datesAreGmt ?? true;
    const raw = await this.request("GET", "/orders", { query });
    return { items: this.parseList(raw.data, orderListSchema, "GET", "/orders"), pagination: raw.pagination };
  }

  async getOrder(orderId: number): Promise<Order> {
    const path = `/orders/${orderId}`;
    const raw = await this.request("GET", path, {
      notFoundMessage: `Order ${orderId} was not found on the store.`,
    });
    return this.parseOne(raw.data, orderSchema, "GET", path);
  }

  async updateOrderStatus(orderId: number, status: string): Promise<Order> {
    const path = `/orders/${orderId}`;
    const raw = await this.request("PUT", path, {
      body: { status },
      notFoundMessage: `Order ${orderId} was not found on the store.`,
    });
    return this.parseOne(raw.data, orderSchema, "PUT", path);
  }

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: this.authHeader,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const upstream = this.classifyTransportError(error);
      this.logger?.warn("woo_request_failed", {
        method,
        path,
        code: upstream.code,
        duration_ms: Date.now() - startedAt,
      });
      throw upstream;
    }

    const text = await response.text().catch(() => null);
    let parsed: unknown;
    let parsedOk = false;
    if (text !== null && text !== "") {
      try {
        parsed = JSON.parse(text);
        parsedOk = true;
      } catch {
        parsedOk = false;
      }
    }

    if (!response.ok) {
      const upstream = this.httpError(method, path, response, parsed, parsedOk, options.notFoundMessage);
      this.logger?.warn("woo_request_failed", {
        method,
        path,
        status: response.status,
        code: upstream.code,
        duration_ms: Date.now() - startedAt,
      });
      throw upstream;
    }

    if (!parsedOk) {
      const upstream = new UpstreamError(
        "malformed_response",
        `The store returned an unexpected (non-JSON) response for ${method} ${path}. Check that WOOCOMMERCE_STORE_URL points at a WordPress site with the WooCommerce REST API enabled.`,
        { details: { method, path, status: response.status } },
      );
      this.logger?.warn("woo_request_failed", {
        method,
        path,
        status: response.status,
        code: upstream.code,
        duration_ms: Date.now() - startedAt,
      });
      throw upstream;
    }

    this.logger?.debug("woo_request_ok", {
      method,
      path,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });

    return {
      data: parsed,
      pagination: {
        page: options.query?.page !== undefined ? Number(options.query.page) : 1,
        per_page: options.query?.per_page !== undefined ? Number(options.query.per_page) : 10,
        total: numberHeader(response.headers.get("x-wp-total")),
        total_pages: numberHeader(response.headers.get("x-wp-totalpages")),
      },
    };
  }

  private classifyTransportError(error: unknown): UpstreamError {
    if (error instanceof Error && error.name === "TimeoutError") {
      return new UpstreamError(
        "timeout",
        `The store did not respond within ${this.timeoutMs} ms. The store may be down or slow; try again or raise WOOCOMMERCE_TIMEOUT_MS.`,
        { cause: error },
      );
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    if (cause?.message === "redirect" || (error instanceof Error && error.message.toLowerCase().includes("redirect"))) {
      return new UpstreamError(
        "connection",
        `The store at ${this.origin} redirected the request. Set WOOCOMMERCE_STORE_URL to the final URL that serves the WooCommerce REST API directly.`,
        { cause: error },
      );
    }
    return new UpstreamError(
      "connection",
      `Could not reach the store at ${this.origin} (connection failed). Check the URL and that the store is running.`,
      { cause: error },
    );
  }

  private httpError(
    method: string,
    path: string,
    response: Response,
    parsed: unknown,
    parsedOk: boolean,
    notFoundMessage: string | undefined,
  ): UpstreamError {
    const wooMessage = parsedOk && isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : undefined;
    const wooCode = parsedOk && isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : undefined;
    const details = { status: response.status, wooCode, method, path };

    if (response.status === 404) {
      return new UpstreamError(
        "not_found",
        notFoundMessage ?? `${method} ${path} returned HTTP 404 (not found) on the store.`,
        { details },
      );
    }
    if (response.status === 401) {
      return new UpstreamError(
        "http",
        `The store rejected the API credentials (HTTP 401). Check the consumer key and secret, and note that WooCommerce only accepts Basic authentication when the store is served over HTTPS.${wooMessage ? ` Store message: ${wooMessage}` : ""}`,
        { details },
      );
    }
    if (response.status === 403) {
      return new UpstreamError(
        "http",
        `The store denied access (HTTP 403). The API key may lack ${method === "GET" ? "read" : "write"} permission.${wooMessage ? ` Store message: ${wooMessage}` : ""}`,
        { details },
      );
    }
    return new UpstreamError(
      "http",
      `WooCommerce responded with HTTP ${response.status} for ${method} ${path}.${wooMessage ? ` Store message: ${wooMessage}` : ""}`,
      { details },
    );
  }

  private parseList<S extends z.ZodType<unknown[]>>(
    data: unknown,
    schema: S,
    method: string,
    path: string,
  ): z.infer<S> {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new UpstreamError(
        "malformed_response",
        `The store returned a list for ${method} ${path} that did not match the expected shape.`,
        { details: { method, path } },
      );
    }
    return result.data;
  }

  private parseOne<S extends z.ZodType<unknown>>(
    data: unknown,
    schema: S,
    method: string,
    path: string,
  ): z.infer<S> {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new UpstreamError(
        "malformed_response",
        `The store returned an object for ${method} ${path} that did not match the expected shape.`,
        { details: { method, path } },
      );
    }
    return result.data;
  }
}
