import { z } from "zod";

export const PAGE_MESSAGE = "page must be an integer of 1 or more";
export const PER_PAGE_MESSAGE = "per_page must be an integer between 1 and 100";
export const SKU_MESSAGE = "sku must be a string of 1 to 64 characters";
export const DELTA_MESSAGE = "delta must be a non-zero integer between -1000 and 1000";

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

export const listProductsInput = {
  page: pageSchema,
  per_page: perPageSchema,
  warehouse: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Filter to a single warehouse code (seeded demo uses north and south)"),
};

export const adjustStockInput = {
  sku: z
    .string()
    .min(1, SKU_MESSAGE)
    .max(64, SKU_MESSAGE)
    .describe("Stock keeping unit, e.g. TEE-BLK-M (trimmed and matched case-insensitively)"),
  delta: z.coerce
    .number({ error: DELTA_MESSAGE })
    .int(DELTA_MESSAGE)
    .min(-1000, DELTA_MESSAGE)
    .max(1000, DELTA_MESSAGE)
    .refine((value) => value !== 0, { message: DELTA_MESSAGE, path: ["delta"] })
    .describe("Signed change applied to the quantity, -1000..1000 excluding 0 (e.g. -3 removes 3 units)"),
};
