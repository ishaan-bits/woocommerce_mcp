import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InventoryDataSource } from "./inventory-store.ts";
import type { Logger } from "./logger.ts";
import { createToolHandlers } from "./tool-handlers.ts";
import { adjustStockInput, listProductsInput } from "./tool-schemas.ts";
import { VERSION } from "./version.ts";

export interface McpServerOptions {
  store: InventoryDataSource;
  logger: Logger;
  name?: string;
  version?: string;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "inventory-mcp",
      version: options.version ?? VERSION,
    },
    {
      instructions:
        "This server exposes a small INVENTORY DEMO: a deterministic, seeded in-memory stock dataset. " +
        "No real warehouse, ERP or WooCommerce inventory is connected, and data changes live only in this process. " +
        "Tool results are JSON text with a source field of \"seeded-demo\". " +
        "Read tools are marked read-only; adjust_stock mutates the in-process quantities and is not idempotent. " +
        "Failures are returned as tool results with isError set to true; invalid arguments are reported as validation error results.",
    },
  );

  const handlers = createToolHandlers(options.store, options.logger);

  server.registerTool(
    "list_products",
    {
      title: "List inventory products",
      description:
        "List stock items from the seeded demo inventory, one page at a time, optionally filtered by warehouse code (north or south). " +
        "Read-only. Returns products (sku, name, warehouse, quantity) plus pagination (page, per_page, total, total_pages).",
      inputSchema: listProductsInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => handlers.listProducts(args),
  );

  server.registerTool(
    "adjust_stock",
    {
      title: "Adjust stock quantity",
      description:
        "Apply a signed delta (-1000..1000, never 0) to one SKU's quantity in the seeded demo inventory. " +
        "Unknown SKUs and adjustments that would drop below zero are rejected without changing anything. " +
        "Not idempotent: applying the same delta twice changes the quantity twice. Mutating tool.",
      inputSchema: adjustStockInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => handlers.adjustStock(args),
  );

  return server;
}
