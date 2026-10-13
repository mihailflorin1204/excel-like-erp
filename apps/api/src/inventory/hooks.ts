import { randomUUID } from 'node:crypto';
import { type CommitPlan, ConflictError, type SheetStore } from '@erp/db';
import { type AuditEntry, type BatchError, type CellValue, roundTo, type Row, stockMovementsSheet } from '@erp/schema';
import { ActionError, type SheetHooks } from '../hooks.ts';
import { applyMovement, averageCost, binQty, buildStock, itemQty, type StockState } from './stock.ts';

export const MOVEMENTS = 'stockMovements';
const COST_DIGITS = 4;

/** Today's date on the server, in its own time zone (the browser normally fills the date itself). */
export const today = () => new Date().toLocaleDateString('sv-SE');
export const str = (v: CellValue | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const num = (v: CellValue | undefined): number | null => (typeof v === 'number' ? v : null);
export const fmtQty = (n: number) => String(roundTo(n, 6));

export async function stockFor(store: SheetStore, itemIds: readonly string[]): Promise<StockState> {
  return buildStock(await store.listWhere(MOVEMENTS, 'item', itemIds));
}

export async function codes(store: SheetStore, warehouseIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await store.getRows('warehouses', [...new Set(warehouseIds)]);
  return new Map(rows.map((r) => [r.id, String(r.values.code ?? '?')]));
}

/**
 * Posting rules for new stock movements, applied in the order they were entered:
 * - Receipt: qty > 0, in at the typed unit cost (or the item's default cost).
 * - Issue: qty > 0, out at the moving-average cost.
 * - Adjustment: qty ≠ 0 with a reason; + comes in at the typed cost (or the average), − goes out at the average.
 * - Transfer: qty > 0 from Warehouse to To warehouse at the average cost; the item's total doesn't change.
 * No warehouse may go below zero.
 */
export async function postMovements(store: SheetStore, inserts: { tempId: string; values: Record<string, CellValue> }[]) {
  const errors: BatchError[] = [];
  const itemIds = [...new Set(inserts.map((i) => str(i.values.item)).filter((v): v is string => !!v))];
  const state = await stockFor(store, itemIds);
  const items = new Map((await store.getRows('items', itemIds)).map((r) => [r.id, r]));
  const whCodes = await codes(
    store,
    inserts.flatMap((i) => [str(i.values.warehouse), str(i.values.toWarehouse)]).filter((v): v is string => !!v),
  );

  for (const ins of inserts) {
    const v = ins.values;
    const before = errors.length;
    const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
    const type = String(v.type);
    const item = String(v.item);
    const warehouse = String(v.warehouse);
    const toWarehouse = str(v.toWarehouse);
    const qty = num(v.qty) ?? 0;

    if (type === 'Transfer') {
      if (!toWarehouse) err('toWarehouse', 'Required for a transfer');
      else if (toWarehouse === warehouse) err('toWarehouse', 'Must be a different warehouse');
    } else if (toWarehouse) {
      err('toWarehouse', 'Only used for transfers');
    }
    if (type === 'Adjustment') {
      if (qty === 0) err('qty', 'Use + to add stock, − to remove it');
      if (!str(v.reason)) err('reason', 'Required for an adjustment');
    } else if (qty <= 0) {
      err('qty', 'Must be more than 0');
    }
    if (errors.length > before) continue;

    const signed = type === 'Receipt' || type === 'Adjustment' ? qty : -qty;
    const average = averageCost(state, item);
    const defaultCost = num(items.get(item)?.values.cost);
    let unitCost: number | null;
    if (signed > 0 && type !== 'Transfer') {
      unitCost = num(v.unitCost) ?? (type === 'Adjustment' ? average : null) ?? defaultCost;
      if (unitCost === null) {
        err('unitCost', 'Enter a unit cost (the item has no default cost)');
        continue;
      }
    } else {
      // Outgoing stock always leaves at the current average; a typed cost is replaced.
      unitCost = average ?? defaultCost ?? 0;
      const available = binQty(state, item, warehouse);
      if (available + signed < 0) {
        err('qty', `Only ${fmtQty(available)} in stock in ${whCodes.get(warehouse) ?? 'this warehouse'}`);
        continue;
      }
    }

    v.date = str(v.date) ?? today();
    v.unitCost = roundTo(unitCost, COST_DIGITS);
    v.signedQty = signed;
    v.value = roundTo((type === 'Transfer' ? qty : signed) * unitCost, 2);
    v.reversalOf = null;
    v.reversedBy = null;
    v.source = str(v.source);
    applyMovement(state, v);
  }
  return errors;
}

/** Who is reversing, and when (shared by everything saved in one go). */
export interface PostingContext {
  user: string;
  now: string;
  batchId: string;
}

export const auditEntry = (
  ctx: PostingContext,
  sheet: string,
  rowId: string,
  op: AuditEntry['op'],
  column: string | null,
  oldValue: CellValue,
  newValue: CellValue,
): AuditEntry => ({ id: randomUUID(), sheet, rowId, op, column, oldValue, newValue, user: ctx.user, batchId: ctx.batchId, at: ctx.now });

/** Audit entries for a newly created row (one per filled column). */
export const insertAudit = (ctx: PostingContext, sheet: string, row: Row): AuditEntry[] =>
  Object.entries(row.values)
    .filter(([, value]) => value !== null)
    .map(([column, value]) => auditEntry(ctx, sheet, row.id, 'insert', column, null, value));

/**
 * Plans the exact opposite of a movement (same quantities and cost, opposite sign) and marks the original
 * as reversed. Throws ActionError when it isn't allowed. `source` must match the movement's source, so a
 * movement posted by a goods receipt can only be reversed through that receipt.
 */
export async function planMovementReversal(
  store: SheetStore,
  original: Row,
  ctx: PostingContext,
  source: string | null = null,
): Promise<{ plan: CommitPlan; reversal: Row; updated: Row }> {
  const o = original.values;
  if (str(o.reversedBy)) throw new ActionError(409, 'This movement is already reversed');
  if (str(o.reversalOf)) throw new ActionError(409, 'This is a reversal; post a new movement instead');
  if (str(o.source) !== source) {
    throw new ActionError(409, 'This movement was posted by a goods receipt. Reverse that receipt instead.');
  }

  const item = String(o.item);
  const signed = -(num(o.signedQty) ?? 0);
  const state = await stockFor(store, [item]);
  const whCodes = await codes(store, [String(o.warehouse), String(o.toWarehouse ?? '')].filter(Boolean));
  // Check the side that loses stock: the warehouse for a reversed receipt, the destination for a reversed transfer.
  const losing: [string, number][] =
    o.type === 'Transfer' ? [[String(o.toWarehouse), -signed]] : [[String(o.warehouse), signed]];
  for (const [wh, change] of losing) {
    const available = binQty(state, item, wh);
    if (change < 0 && available + change < 0) {
      throw new ActionError(409, `Can't reverse: only ${fmtQty(available)} left in ${whCodes.get(wh) ?? 'the warehouse'}`);
    }
  }
  // Taking a receipt back out at its own cost after stock was issued at a blended average can leave the
  // remaining stock with a negative value. Refuse that; a stock adjustment (at the average) is the right fix.
  if (o.type !== 'Transfer') {
    const totals = state.items.get(item) ?? { qty: 0, value: 0 };
    const qtyAfter = totals.qty + signed;
    const valueAfter = totals.value + signed * (num(o.unitCost) ?? 0);
    if (qtyAfter > 0 && valueAfter < -0.005) {
      throw new ActionError(
        409,
        "Can't reverse: stock from this receipt was already used at a blended cost. Post an Adjustment instead.",
      );
    }
  }

  const reversal: Row = {
    id: randomUUID(),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    values: {
      date: today(),
      type: o.type ?? null,
      item: o.item ?? null,
      warehouse: o.warehouse ?? null,
      toWarehouse: o.toWarehouse ?? null,
      qty: -(num(o.qty) ?? 0),
      unitCost: o.unitCost ?? null,
      reason: `Reversal of ${o.date ?? 'movement'}${str(o.reason) ? `: ${o.reason}` : ''}`.slice(0, 200),
      reference: o.reference ?? null,
      value: -(num(o.value) ?? 0),
      signedQty: signed,
      reversalOf: original.id,
      reversedBy: null,
      source,
    },
  };
  const plan: CommitPlan = {
    sheet: stockMovementsSheet,
    inserts: [reversal],
    updates: [{ id: original.id, expectedVersion: original.version, set: { reversedBy: reversal.id }, updatedAt: ctx.now }],
    deletes: [],
    audit: [
      ...insertAudit(ctx, MOVEMENTS, reversal),
      auditEntry(ctx, MOVEMENTS, original.id, 'update', 'reversedBy', null, reversal.id),
    ],
    // If another request reversed it first, the original's version moved and nothing is saved.
    atomic: true,
  };
  const updated: Row = { ...original, version: original.version + 1, updatedAt: ctx.now, values: { ...o, reversedBy: reversal.id } };
  return { plan, reversal, updated };
}

/** Commits a plan; a version conflict becomes a clear 409 for the user. */
export async function commitOrConflict(store: SheetStore, plan: CommitPlan): Promise<void> {
  try {
    await store.commit(plan);
  } catch (err) {
    if (err instanceof ConflictError) throw new ActionError(409, 'This was just changed (already reversed?). Reload and check.');
    throw err;
  }
}

async function reverseMovement(store: SheetStore, id: string, user: string): Promise<Row[]> {
  const [original] = await store.getRows(MOVEMENTS, [id]);
  if (!original) throw new ActionError(404, 'Movement not found');
  const { plan, reversal, updated } = await planMovementReversal(store, original, {
    user,
    now: new Date().toISOString(),
    batchId: randomUUID(),
  });
  await commitOrConflict(store, plan);
  return [updated, reversal];
}

export const inventoryHooks: Record<string, SheetHooks> = {
  items: {
    async computed(store, rows) {
      const state = await stockFor(store, rows.map((r) => r.id));
      const { onOrderByItem } = await import('../purchasing/hooks.ts');
      const onOrder = await onOrderByItem(store, rows.map((r) => r.id));
      for (const r of rows) {
        const qty = itemQty(state, r.id);
        const average = averageCost(state, r.id);
        const reorderPoint = num(r.values.reorderPoint);
        r.values.onHand = qty;
        r.values.onOrder = onOrder.get(r.id) ?? 0;
        r.values.avgCost = average === null ? null : roundTo(average, COST_DIGITS);
        r.values.stockValue = roundTo(state.items.get(r.id)?.value ?? 0, 2);
        r.values.stockStatus = reorderPoint === null ? null : qty <= reorderPoint ? 'Reorder' : 'OK';
      }
    },
  },

  stockMovements: {
    beforeInsert: postMovements,
    async computed(_store, rows) {
      for (const r of rows) {
        r.values.status = str(r.values.reversedBy) ? 'Reversed' : str(r.values.reversalOf) ? 'Reversal' : 'Posted';
      }
    },
    actions: { reverse: reverseMovement },
  },

  stockLevels: {
    async virtualRows(store) {
      const movements = await store.listWhere(MOVEMENTS, 'item');
      const state = buildStock(movements);
      const itemIds = [...new Set([...state.bins.keys()].map((k) => k.split('|')[0]!))];
      const items = new Map((await store.getRows('items', itemIds)).map((r) => [r.id, r]));
      const whCodes = await codes(store, [...state.bins.keys()].map((k) => k.split('|')[1]!));

      const rows: Row[] = [...state.bins.entries()].map(([key, qty]) => {
        const [itemId, wh] = key.split('|') as [string, string];
        const item = items.get(itemId);
        const average = averageCost(state, itemId);
        const total = itemQty(state, itemId);
        const reorderPoint = num(item?.values.reorderPoint);
        return {
          id: key,
          version: 0,
          createdAt: '',
          updatedAt: '',
          values: {
            item: itemId,
            itemName: item?.values.name ?? null,
            warehouse: wh,
            onHand: qty,
            unit: item?.values.unit ?? null,
            avgCost: average === null ? null : roundTo(average, COST_DIGITS),
            value: average === null ? 0 : roundTo(qty * average, 2),
            itemOnHand: total,
            reorderPoint,
            stockStatus: reorderPoint === null ? null : total <= reorderPoint ? 'Reorder' : 'OK',
          },
        };
      });
      const sortKey = (r: Row) => `${items.get(String(r.values.item))?.values.sku ?? ''}|${whCodes.get(String(r.values.warehouse)) ?? ''}`;
      return rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    },
  },
};
