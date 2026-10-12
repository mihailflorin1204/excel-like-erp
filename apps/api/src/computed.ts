import type { SheetStore } from '@erp/db';
import type { Row } from '@erp/schema';

type Resolver = (store: SheetStore, rows: Row[]) => Promise<void>;

/**
 * Server-side values for computed columns, keyed by sheet.
 * Items.onHand = sum of stock movement quantities. The stockMovements sheet arrives in Phase 2,
 * so until then the sum is over an empty collection and reads 0.
 */
const resolvers: Record<string, Resolver> = {
  items: async (store, rows) => {
    const sums = await store.sumBy('stockMovements', 'itemId', 'qty', rows.map((r) => r.id));
    for (const r of rows) r.values.onHand = sums.get(r.id) ?? 0;
  },
};

export async function applyComputed(store: SheetStore, sheet: string, rows: Row[]): Promise<Row[]> {
  const resolve = resolvers[sheet];
  if (resolve && rows.length > 0) await resolve(store, rows);
  return rows;
}
