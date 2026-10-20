import { z } from "zod";

export const PAGE_MESSAGE = "page must be an integer of 1 or more";
export const PER_PAGE_MESSAGE = "per_page must be an integer between 1 and 100";
export const ORDER_ID_MESSAGE = "order_id must be an integer of 1 or more";
export const PRICE_MESSAGE = "regular_price must be a decimal string with up to two fractional digits and no sign, e.g. \"19.99\"";

const pageSchema = z.coerce
  .number()
  .int(PAGE_MESSAGE)
  .min(1, PAGE_MESSAGE)
  .default(1)
  .describe("1-based page number (default 1)");

const perPageSchema = z.coerce
  .number()
  .int(PER_PAGE_MESSAGE)
  .min(1, PER_PAGE_MESSAGE)
  .max(100, PER_PAGE_MESSAGE)
  .default(10)
  .describe("Items per page, 1-100 (default 10)");

const orderIdSchema = z.coerce
  .number()
  .int(ORDER_ID_MESSAGE)
  .min(1, ORDER_ID_MESSAGE)
  .describe("Numeric WooCommerce order id");

export const priceSchema = z
  .preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : value),
    z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, PRICE_MESSAGE)
      .describe("Price exactly as WooCommerce stores it: a decimal string like \"19.99\" (no currency symbol, no sign)"),
  );

export const PRODUCT_QUERY_STATUSES = ["any", "draft", "pending", "private", "publish", "future", "trash"] as const;
export const ORDER_QUERY_STATUSES = [
  "any",
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
  "trash",
] as const;
export const ORDER_WRITE_STATUSES = [
  "pending",
  "processing",
  "completed",
  "on-hold",
  "cancelled",
  "refunded",
  "failed",
] as const;

const isoOffsetPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

function isoInstantSchema(label: string) {
  const message = `${label} must be an ISO-8601 date-time with an explicit UTC offset or Z, e.g. 2024-05-01T00:00:00Z`;
  return z
    .string()
    .regex(isoOffsetPattern, message)
    .refine((value) => !Number.isNaN(Date.parse(value)), message)
    .describe(`${label} as an ISO-8601 instant with explicit offset, e.g. 2024-05-01T00:00:00Z`);
}

const datesAreGmtSchema = z
  .preprocess(
    (value) => {
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    },
    z
      .boolean()
      .default(true)
      .describe("Interpret after/before as GMT (WooCommerce dates_are_gmt; default true)"),
  );

export const listProductsInput = {
  page: pageSchema,
  per_page: perPageSchema,
  search: z.string().min(1).max(200).optional().describe("Substring match on the product name"),
  status: z
    .enum(PRODUCT_QUERY_STATUSES, { error: `status must be one of: ${PRODUCT_QUERY_STATUSES.join(", ")}` })
    .optional()
    .describe("Filter by product status (default: WooCommerce's default, usually any)"),
};

export const createProductInput = {
  name: z.string().min(1).max(200).describe("Product name"),
  regular_price: priceSchema,
  description: z.string().max(100_000).optional().describe("Product description (HTML allowed by the store)"),
  sku: z.string().min(1).max(64).optional().describe("Stock keeping unit; must be unique on the store"),
  stock_quantity: z.coerce
    .number()
    .int("stock_quantity must be an integer of 0 or more")
    .min(0, "stock_quantity must be an integer of 0 or more")
    .optional()
    .describe("Initial stock quantity for a simple product"),
  status: z
    .enum(["draft", "pending", "private", "publish"], {
      error: "status must be one of: draft, pending, private, publish",
    })
    .optional()
    .describe("Initial product status (store default applies when omitted)"),
};

const listOrdersShape = {
  page: pageSchema,
  per_page: perPageSchema,
  search: z.string().min(1).max(200).optional().describe("Substring match supported by the store's order search"),
  status: z
    .enum(ORDER_QUERY_STATUSES, { error: `status must be one of: ${ORDER_QUERY_STATUSES.join(", ")}` })
    .optional()
    .describe("Filter by a single order status (WooCommerce's orders endpoint accepts one status at a time)"),
  after: isoInstantSchema("after").optional(),
  before: isoInstantSchema("before").optional(),
  dates_are_gmt: datesAreGmtSchema,
};

export const listOrdersInput = z
  .object(listOrdersShape)
  .refine(
    (value) => {
      if (value.after === undefined || value.before === undefined) {
        return true;
      }
      const after = Date.parse(value.after);
      const before = Date.parse(value.before);
      return !Number.isNaN(after) && !Number.isNaN(before) && after < before;
    },
    {
      message: "after must be a valid instant earlier than before",
      path: ["after"],
    },
  )
  .describe("List orders, optionally filtered by status, search text, or an after/before instant window");

export const getOrderInput = {
  order_id: orderIdSchema,
};

export const updateOrderStatusInput = {
  order_id: orderIdSchema,
  status: z
    .enum(ORDER_WRITE_STATUSES, { error: `status must be one of: ${ORDER_WRITE_STATUSES.join(", ")}` })
    .describe("New order status (single status; \"any\" and \"trash\" are not accepted for updates)"),
};
