import { z } from "zod";

/**
 * Product fields preserved in tool results (Phase: factual accuracy). The
 * WooCommerce REST object carries ~80 fields (images, meta, HTML) — the tool
 * result projects these exact, real fields so a model never has to guess ids
 * or prices from truncated fragments.
 */
export const productSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  price: z.string().optional(),
  regular_price: z.string().optional(),
  status: z.string().optional(),
  sku: z.string().optional(),
  permalink: z.string().optional(),
});

export type Product = z.infer<typeof productSchema>;

export const productListSchema = z.array(productSchema);

export const orderSchema = z.looseObject({
  id: z.number(),
  status: z.string(),
  total: z.string().optional(),
  currency: z.string().optional(),
  /** Local creation time — grounds "orders today" claims in real timestamps. */
  date_created: z.string().optional(),
  date_created_gmt: z.string().optional(),
});

export type Order = z.infer<typeof orderSchema>;

export const orderListSchema = z.array(orderSchema);

export interface Pagination {
  page: number;
  per_page: number;
  total: number | null;
  total_pages: number | null;
}
