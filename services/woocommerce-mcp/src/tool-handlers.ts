import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WooCommerceClient } from "./woocommerce-client.ts";
import { isUpstreamError } from "./errors.ts";
import {
  createProductInput,
  getOrderInput,
  listOrdersInput,
  listProductsInput,
  updateOrderStatusInput,
} from "./tool-schemas.ts";

export type ListProductsArgs = z.infer<z.ZodObject<typeof listProductsInput>>;
export type CreateProductArgs = z.infer<z.ZodObject<typeof createProductInput>>;
export type ListOrdersArgs = z.infer<typeof listOrdersInput>;
export type GetOrderArgs = z.infer<z.ZodObject<typeof getOrderInput>>;
export type UpdateOrderStatusArgs = z.infer<z.ZodObject<typeof updateOrderStatusInput>>;

export interface ToolHandlers {
  listProducts(args: ListProductsArgs): Promise<CallToolResult>;
  createProduct(args: CreateProductArgs): Promise<CallToolResult>;
  listOrders(args: ListOrdersArgs): Promise<CallToolResult>;
  getOrder(args: GetOrderArgs): Promise<CallToolResult>;
  updateOrderStatus(args: UpdateOrderStatusArgs): Promise<CallToolResult>;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Compact product projection: real fields only, one object per product id. */
function productSummary(product: {
  id: number;
  name: string;
  price?: string;
  regular_price?: string;
  status?: string;
  sku?: string;
  permalink?: string;
}): Record<string, unknown> {
  return {
    id: product.id,
    name: product.name,
    ...(product.price !== undefined ? { price: product.price } : {}),
    ...(product.regular_price !== undefined ? { regular_price: product.regular_price } : {}),
    ...(product.status !== undefined ? { status: product.status } : {}),
    ...(product.sku !== undefined ? { sku: product.sku } : {}),
    ...(product.permalink !== undefined ? { permalink: product.permalink } : {}),
  };
}

/** Compact order projection with real timestamps for date questions. */
function orderSummary(order: {
  id: number;
  status: string;
  total?: string;
  currency?: string;
  date_created?: string;
  date_created_gmt?: string;
}): Record<string, unknown> {
  return {
    id: order.id,
    status: order.status,
    ...(order.total !== undefined ? { total: order.total } : {}),
    ...(order.currency !== undefined ? { currency: order.currency } : {}),
    ...(order.date_created !== undefined ? { date_created: order.date_created } : {}),
    ...(order.date_created_gmt !== undefined ? { date_created_gmt: order.date_created_gmt } : {}),
  };
}

/**
 * Explicit, machine-readable pagination built ONLY from real API metadata
 * (the store's X-WP-Total / X-WP-TotalPages headers). Unknown totals stay
 * null — never fabricated. `has_more` is null when the metadata is missing.
 */
function paginationSummary(
  pagination: { page: number; per_page: number; total: number | null; total_pages: number | null },
  returned: number,
): Record<string, unknown> {
  const hasMore =
    pagination.total_pages === null
      ? null
      : pagination.total_pages > 0
        ? pagination.page < pagination.total_pages
        : returned >= pagination.per_page; // bounded fallback: at least a full page came back
  return {
    page: pagination.page,
    per_page: pagination.per_page,
    returned,
    total_products: pagination.total,
    total_pages: pagination.total_pages,
    has_more: hasMore,
  };
}

function orderPaginationSummary(
  pagination: { page: number; per_page: number; total: number | null; total_pages: number | null },
  returned: number,
): Record<string, unknown> {
  const summary = paginationSummary(pagination, returned);
  return {
    page: summary.page,
    per_page: summary.per_page,
    returned: summary.returned,
    total_orders: pagination.total,
    total_pages: summary.total_pages,
    has_more: summary.has_more,
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function handleFailure(error: unknown): CallToolResult {
  if (isUpstreamError(error)) {
    return errorResult(error.message);
  }
  return errorResult("Unexpected error while talking to the WooCommerce store. See the server logs for details.");
}

export function createToolHandlers(client: WooCommerceClient): ToolHandlers {
  return {
    async listProducts(args) {
      try {
        const { items, pagination } = await client.listProducts({
          page: args.page,
          perPage: args.per_page,
          search: args.search,
          status: args.status,
        });
        // Pagination FIRST so even a size-capped result keeps the page facts;
        // each product keeps its own real id (never ranges, never merged ids).
        return textResult({
          pagination: paginationSummary(pagination, items.length),
          products: items.map(productSummary),
        });
      } catch (error) {
        return handleFailure(error);
      }
    },

    async createProduct(args) {
      try {
        const product = await client.createProduct({
          name: args.name,
          regularPrice: args.regular_price,
          description: args.description,
          sku: args.sku,
          stockQuantity: args.stock_quantity,
          status: args.status,
        });
        return textResult({ product: productSummary(product) });
      } catch (error) {
        return handleFailure(error);
      }
    },

    async listOrders(args) {
      try {
        const { items, pagination } = await client.listOrders({
          page: args.page,
          perPage: args.per_page,
          search: args.search,
          status: args.status,
          after: args.after,
          before: args.before,
          datesAreGmt: args.dates_are_gmt,
        });
        return textResult({
          pagination: orderPaginationSummary(pagination, items.length),
          orders: items.map(orderSummary),
        });
      } catch (error) {
        return handleFailure(error);
      }
    },

    async getOrder(args) {
      try {
        const order = await client.getOrder(args.order_id);
        return textResult({ order: orderSummary(order) });
      } catch (error) {
        return handleFailure(error);
      }
    },

    async updateOrderStatus(args) {
      try {
        const order = await client.updateOrderStatus(args.order_id, args.status);
        return textResult({ order: orderSummary(order) });
      } catch (error) {
        return handleFailure(error);
      }
    },
  };
}
