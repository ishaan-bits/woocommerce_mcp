import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WooCommerceClient } from "./woocommerce-client.ts";
import { createToolHandlers } from "./tool-handlers.ts";
import {
  createProductInput,
  getOrderInput,
  listOrdersInput,
  listProductsInput,
  updateOrderStatusInput,
} from "./tool-schemas.ts";
import { VERSION } from "./version.ts";

export interface McpServerOptions {
  client: WooCommerceClient;
  name?: string;
  version?: string;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "woocommerce-mcp",
      version: options.version ?? VERSION,
    },
    {
      instructions:
        "This server exposes a small subset of the WooCommerce REST API of the connected store as MCP tools. " +
        "Tool results are JSON text; pagination objects carry the store's X-WP-Total and X-WP-TotalPages values. " +
        "Prices are decimal strings exactly as WooCommerce stores them (for example \"19.99\"). " +
        "Order dates are ISO-8601 instants with an explicit UTC offset. " +
        "Store failures are reported as tool results with isError set to true; invalid tool arguments are reported as validation error results.",
    },
  );

  const handlers = createToolHandlers(options.client);

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List products from the connected WooCommerce store, one page at a time. Read-only. Returns the products plus pagination (page, per_page, total, total_pages).",
      inputSchema: listProductsInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => handlers.listProducts(args),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product on the connected WooCommerce store. Requires name and regular_price (a decimal string such as \"19.99\"). Each call creates a new product, so it is not idempotent.",
      inputSchema: createProductInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => handlers.createProduct(args),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders from the connected WooCommerce store, optionally filtered by a single status, search text, or an after/before instant window (ISO-8601 with explicit offset; dates_are_gmt defaults to true). Read-only.",
      inputSchema: listOrdersInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => handlers.listOrders(args),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Fetch a single order from the connected WooCommerce store by numeric order_id. Read-only.",
      inputSchema: getOrderInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => handlers.getOrder(args),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description:
        "Update the status of an existing order on the connected WooCommerce store. Accepted statuses: pending, processing, completed, on-hold, cancelled, refunded, failed. Applying the same status again is idempotent.",
      inputSchema: updateOrderStatusInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => handlers.updateOrderStatus(args),
  );

  return server;
}
