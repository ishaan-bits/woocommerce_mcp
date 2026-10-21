import { InventoryError } from "./errors.ts";

export interface StockItem {
  readonly sku: string;
  readonly name: string;
  readonly warehouse: string;
  quantity: number;
}

export interface StockPage {
  readonly items: StockItem[];
  readonly total: number;
}

export interface AdjustResult {
  readonly item: StockItem;
  readonly previousQuantity: number;
}

/**
 * The seam between tool handlers and stock data. Production uses the seeded
 * in-process store below; tests inject failing stores to exercise the
 * unavailable-data path without any real warehouse.
 */
export interface InventoryDataSource {
  listProducts(filter: { warehouse?: string | undefined }, page: number, perPage: number): StockPage;
  adjustStock(sku: string, delta: number): AdjustResult;
}

/**
 * Deterministic seed — 12 SKUs, six per warehouse, no randomness, no clock.
 * This is demo data: no real warehouse or WooCommerce inventory is connected.
 */
export const SEED_ITEMS: readonly StockItem[] = [
  { sku: "TEE-BLK-M", name: "Black Tee (M)", warehouse: "north", quantity: 120 },
  { sku: "TEE-BLK-L", name: "Black Tee (L)", warehouse: "north", quantity: 84 },
  { sku: "MUG-GRN-01", name: "Green Mug", warehouse: "north", quantity: 46 },
  { sku: "CAP-NVY-01", name: "Navy Cap", warehouse: "north", quantity: 60 },
  { sku: "TOTE-CNV-01", name: "Canvas Tote", warehouse: "north", quantity: 38 },
  { sku: "STK-ORG-250", name: "Loose Leaf Tea 250g (Orange)", warehouse: "north", quantity: 210 },
  { sku: "TEE-WHT-M", name: "White Tee (M)", warehouse: "south", quantity: 95 },
  { sku: "TEE-WHT-L", name: "White Tee (L)", warehouse: "south", quantity: 72 },
  { sku: "MUG-BLU-01", name: "Blue Mug", warehouse: "south", quantity: 54 },
  { sku: "CAP-BLK-01", name: "Black Cap", warehouse: "south", quantity: 41 },
  { sku: "TOTE-NAT-01", name: "Natural Tote", warehouse: "south", quantity: 27 },
  { sku: "STK-GRN-250", name: "Loose Leaf Tea 250g (Green)", warehouse: "south", quantity: 188 },
] as const;

export const SEEDED_ITEM_COUNT = 12;

function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

export function createInventoryStore(): InventoryDataSource {
  const items: StockItem[] = SEED_ITEMS.map((seed) => ({
    sku: seed.sku,
    name: seed.name,
    warehouse: seed.warehouse,
    quantity: seed.quantity,
  }));

  return {
    listProducts(filter, page, perPage) {
      const filtered =
        filter.warehouse !== undefined
          ? items.filter((item) => item.warehouse === filter.warehouse)
          : items;
      const total = filtered.length;
      const start = (page - 1) * perPage;
      const pageItems = filtered.slice(start, start + perPage).map((item) => ({ ...item }));
      return { items: pageItems, total };
    },

    adjustStock(sku, delta) {
      const key = normalizeSku(sku);
      const item = items.find((candidate) => candidate.sku === key);
      if (item === undefined) {
        throw new InventoryError(
          `Unknown SKU '${sku}'. Call list_products to see the available SKUs.`,
        );
      }
      const next = item.quantity + delta;
      if (next < 0) {
        throw new InventoryError(
          `Adjustment rejected: ${item.sku} has quantity ${item.quantity} and delta ${delta} would drop below zero.`,
        );
      }
      const previousQuantity = item.quantity;
      item.quantity = next;
      return { item: { ...item }, previousQuantity };
    },
  };
}
