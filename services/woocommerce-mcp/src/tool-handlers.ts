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
        return textResult({ products: items, pagination });
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
        return textResult({ product });
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
        return textResult({ orders: items, pagination });
      } catch (error) {
        return handleFailure(error);
      }
    },

    async getOrder(args) {
      try {
        const order = await client.getOrder(args.order_id);
        return textResult({ order });
      } catch (error) {
        return handleFailure(error);
      }
    },

    async updateOrderStatus(args) {
      try {
        const order = await client.updateOrderStatus(args.order_id, args.status);
        return textResult({ order });
      } catch (error) {
        return handleFailure(error);
      }
    },
  };
}
