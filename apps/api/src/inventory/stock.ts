import { type CellValue, roundTo } from '@erp/schema';

/**
 * Stock position rebuilt from the movement ledger.
 * - `items`: per item, total quantity and total value across all warehouses (for the moving average).
 * - `bins`: per item and warehouse, the quantity on hand.
 *
 * Moving average: every inbound movement adds qty × its unit cost to the item's value, every outbound movement
 * is costed at the average at that moment, so value / qty is always the current average cost.
 * Transfers move quantity between warehouses but don't change the item's total or its value.
 */
export interface StockState {
  items: Map<string, { qty: number; value: number }>;
  bins: Map<string, number>;
}

export const binKey = (item: string, warehouse: string): string => `${item}|${warehouse}`;

const num = (v: CellValue | undefined): number => (typeof v === 'number' ? v : 0);

export function emptyStock(): StockState {
  return { items: new Map(), bins: new Map() };
}

/** Adds one posted movement (its stored values) to the position. */
export function applyMovement(state: StockState, v: Record<string, CellValue>): void {
  const item = String(v.item);
  const signed = num(v.signedQty);
  const addToBin = (warehouse: CellValue | undefined, qty: number) => {
    if (typeof warehouse !== 'string') return;
    const key = binKey(item, warehouse);
    state.bins.set(key, roundTo((state.bins.get(key) ?? 0) + qty, 6));
  };

  addToBin(v.warehouse, signed);
  if (v.type === 'Transfer') {
    addToBin(v.toWarehouse, -signed);
    return;
  }
  const totals = state.items.get(item) ?? { qty: 0, value: 0 };
  totals.qty = roundTo(totals.qty + signed, 6);
  // Back at zero stock means zero value; don't let rounding leftovers distort the next average.
  totals.value = totals.qty === 0 ? 0 : roundTo(totals.value + signed * num(v.unitCost), 6);
  state.items.set(item, totals);
}

export function buildStock(movements: readonly { values: Record<string, CellValue> }[]): StockState {
  const state = emptyStock();
  for (const m of movements) applyMovement(state, m.values);
  return state;
}

/** Current moving-average unit cost, or null when the item has no stock. */
export function averageCost(state: StockState, item: string): number | null {
  const t = state.items.get(item);
  return t && t.qty > 0 ? t.value / t.qty : null;
}

export const binQty = (state: StockState, item: string, warehouse: string): number =>
  state.bins.get(binKey(item, warehouse)) ?? 0;

export const itemQty = (state: StockState, item: string): number => state.items.get(item)?.qty ?? 0;
