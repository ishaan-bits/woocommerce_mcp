import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InventoryError } from "./errors.ts";
import type { InventoryDataSource } from "./inventory-store.ts";
import type { Logger } from "./logger.ts";
import { adjustStockInput, listProductsInput } from "./tool-schemas.ts";

export type ListProductsArgs = z.infer<z.ZodObject<typeof listProductsInput>>;
export type AdjustStockArgs = z.infer<z.ZodObject<typeof adjustStockInput>>;

export const UNAVAILABLE_MESSAGE =
  "The inventory data source is unavailable. No stock was changed. See the server logs for details.";

export interface ToolHandlers {
  listProducts(args: ListProductsArgs): Promise<CallToolResult>;
  adjustStock(args: AdjustStockArgs): Promise<CallToolResult>;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createToolHandlers(store: InventoryDataSource, logger: Logger): ToolHandlers {
  function fail(tool: string, error: unknown): CallToolResult {
    if (error instanceof InventoryError) {
      return errorResult(error.message);
    }
    logger.error("tool_data_source_failed", { tool, error: String(error) });
    return errorResult(UNAVAILABLE_MESSAGE);
  }

  return {
    async listProducts(args) {
      try {
        const { items, total } = store.listProducts(
          { warehouse: args.warehouse },
          args.page,
          args.per_page,
        );
        return textResult({
          source: "seeded-demo",
          warehouse: args.warehouse ?? null,
          products: items,
          pagination: {
            page: args.page,
            per_page: args.per_page,
            total,
            total_pages: total === 0 ? 0 : Math.ceil(total / args.per_page),
          },
        });
      } catch (error) {
        return fail("list_products", error);
      }
    },

    async adjustStock(args) {
      try {
        const { item, previousQuantity } = store.adjustStock(args.sku, args.delta);
        return textResult({
          source: "seeded-demo",
          sku: item.sku,
          name: item.name,
          warehouse: item.warehouse,
          previous_quantity: previousQuantity,
          delta: args.delta,
          quantity: item.quantity,
        });
      } catch (error) {
        return fail("adjust_stock", error);
      }
    },
  };
}
