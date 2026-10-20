import { z } from "zod";

export const productSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
});

export type Product = z.infer<typeof productSchema>;

export const productListSchema = z.array(productSchema);

export const orderSchema = z.looseObject({
  id: z.number(),
  status: z.string(),
});

export type Order = z.infer<typeof orderSchema>;

export const orderListSchema = z.array(orderSchema);

export interface Pagination {
  page: number;
  per_page: number;
  total: number | null;
  total_pages: number | null;
}
