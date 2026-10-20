import { MemoryStore } from '@erp/db';
import { type BatchResponse, type Row, sheets, stockMovementsSheet } from '@erp/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../api/src/app.ts';
import { seedIfEmpty } from '../../api/src/seed.ts';
import { RefLookups } from './lookups.ts';
import { SheetModel } from './sheet-model.ts';

/** The grid model on the Stock movements ledger, against the real API with seeded items and warehouses. */
async function setup() {
  const store = new MemoryStore();
  await store.init(sheets);
  await seedIfEmpty(store);
  const app = buildApp(store, { auth: false });
  const get = async (sheet: string) => ((await app.inject({ method: 'GET', url: `/api/sheets/${sheet}/rows` })).json() as { rows: Row[] }).rows;
  const lookups = new RefLookups();
  lookups.set('items', 'sku', await get('items'));
  lookups.set('warehouses', 'code', await get('warehouses'));
  let saves = 0;
  const model = new SheetModel(
    stockMovementsSheet,
    {
      async batch(sheet, body) {
        return (await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body })).json() as BatchResponse;
      },
    },
    { debounceMs: 1, refs: lookups, onSaved: () => saves++ },
  );
  model.load(await get('stockMovements'));
  return { model, app, get, saves: () => saves };
}

describe('Stock movements in the grid', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('hides bookkeeping columns', () => {
    expect(ctx.model.columns.map((c) => c.key)).not.toContain('signedQty');
    expect(ctx.model.columns.map((c) => c.key)).toContain('value');
  });

  it('pastes movements by SKU and code, fills cost and value, then locks the rows', async () => {
    const start = ctx.model.getSnapshot().rows.length;
    // Columns: Date, Type, Item, Warehouse, To warehouse, Qty, Unit cost
    ctx.model.paste(0, start, [
      ['12/10/2026', 'receipt', 'nut-m8', 'MAIN', '', '10', '3,50'],
      ['', 'Issue', 'NUT-M8', 'main', '', '5', ''],
      ['', 'Issue', 'NOPE', 'MAIN', '', '1', ''],
    ]);
    let s = ctx.model.getSnapshot();
    expect(s.rows[start + 2]!.cells.item).toMatchObject({ state: 'error', message: 'No item "NOPE"' });

    await ctx.model.flush();
    s = ctx.model.getSnapshot();
    const [receipt, issue] = [s.rows[start]!, s.rows[start + 1]!];
    expect(receipt.values).toMatchObject({ date: '2026-10-12', type: 'Receipt', qty: 10, unitCost: 3.5, value: 35, status: 'Posted' });
    // 60 @ 3.00 + 40 @ 3.05 (PO-00001 receipt) + 10 @ 3.50 = 110 @ 3.0636…
    expect(issue.values.unitCost).toBeCloseTo(3.0636, 4);
    expect(ctx.saves()).toBe(1);

    // Posted rows ignore edits and can't be deleted.
    ctx.model.editCells([{ rowIndex: start, column: 'qty', raw: '99' }]);
    expect(ctx.model.getSnapshot().rows[start]!.values.qty).toBe(10);
    expect(ctx.model.deleteRows([start])).toHaveLength(1);
    expect(ctx.model.getSnapshot().rows).toHaveLength(start + 3);
  });

  it('shows the server error when an issue would take stock below zero', async () => {
    const start = ctx.model.getSnapshot().rows.length;
    ctx.model.paste(0, start, [['', 'Issue', 'PAINT-W-10', 'BXL', '', '50', '']]);
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows[start]!.cells.qty).toMatchObject({ state: 'error', message: 'Only 7 in stock in BXL' });
  });

  it('merges rows returned by Reverse', async () => {
    // Row 1 is the NUT-M8 opening stock, none of it used yet.
    const original = ctx.model.getSnapshot().rows[1]!;
    const res = (await ctx.app.inject({ method: 'POST', url: `/api/sheets/stockMovements/rows/${original.id}/actions/reverse` })).json() as { rows: Row[] };
    ctx.model.applyRows(res.rows);
    const s = ctx.model.getSnapshot();
    expect(s.rows[1]!.values.status).toBe('Reversed');
    expect(s.rows.at(-1)!.values).toMatchObject({ status: 'Reversal', reversalOf: original.id });
  });
});
