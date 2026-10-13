import { MemoryStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, type Row, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { seedIfEmpty } from '../src/seed.ts';

let app: FastifyInstance;
let store: MemoryStore;

const batch = async (sheet: string, body: BatchRequest) =>
  (await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body })).json() as BatchResponse;
const rows = async (sheet: string) =>
  ((await app.inject({ method: 'GET', url: `/api/sheets/${sheet}/rows` })).json() as { rows: Row[] }).rows;
const move = async (...movements: Record<string, string | number | null>[]) =>
  batch('stockMovements', { inserts: movements.map((values, i) => ({ tempId: `m${i}`, values })) });
const item = async (sku: string) => (await rows('items')).find((r) => r.values.sku === sku)!;
const reverse = (id: string) => app.inject({ method: 'POST', url: `/api/sheets/stockMovements/rows/${id}/actions/reverse` });

beforeEach(async () => {
  store = new MemoryStore();
  await store.init(sheets);
  app = buildApp(store);
  await batch('warehouses', {
    inserts: [
      { tempId: 'w1', values: { code: 'MAIN', name: 'Main' } },
      { tempId: 'w2', values: { code: 'BXL', name: 'Brussels' } },
    ],
  });
  await batch('items', {
    inserts: [
      { tempId: 'a', values: { sku: 'A', name: 'Item A', unit: 'pcs', cost: 9, reorderPoint: 10 } },
      { tempId: 'b', values: { sku: 'B', name: 'Item B', unit: 'pcs' } },
    ],
  });
});

describe('moving average cost', () => {
  it('re-averages on each receipt and issues at the average', async () => {
    const res = await move(
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 10 },
      { type: 'Receipt', item: 'a', warehouse: 'main', qty: 10, unitCost: 20 }, // refs are case-insensitive
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 5, unitCost: 999 }, // typed cost is replaced
    );
    expect(res.errors).toEqual([]);
    const issue = res.inserted[2]!.row.values;
    expect(issue).toMatchObject({ unitCost: 15, signedQty: -5, value: -75, status: 'Posted' });
    expect(issue.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await item('A')).values).toMatchObject({ onHand: 15, avgCost: 15, stockValue: 225, stockStatus: 'OK' });
  });

  it("uses the item's default cost when a receipt has none, and needs one otherwise", async () => {
    const res = await move(
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 2 },
      { type: 'Receipt', item: 'B', warehouse: 'MAIN', qty: 2 },
    );
    expect(res.inserted[0]!.row.values.unitCost).toBe(9);
    expect(res.errors).toEqual([
      { op: 'insert', ref: 'm1', column: 'unitCost', message: 'Enter a unit cost (the item has no default cost)' },
    ]);
  });

  it('flags items at or below their reorder point', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10 });
    expect((await item('A')).values.stockStatus).toBe('Reorder');
    expect((await item('B')).values.stockStatus).toBeNull();
  });
});

describe('stock never goes negative', () => {
  it('rejects an issue larger than the warehouse holds, checking rows in order', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 15 });
    const res = await move(
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 10 },
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 10 },
      { type: 'Issue', item: 'A', warehouse: 'BXL', qty: 1 },
    );
    expect(res.inserted).toHaveLength(1);
    expect(res.errors.map((e) => [e.ref, e.column, e.message])).toEqual([
      ['m1', 'qty', 'Only 5 in stock in MAIN'],
      ['m2', 'qty', 'Only 0 in stock in BXL'],
    ]);
  });
});

describe('transfers and adjustments', () => {
  it('moves stock between warehouses without changing the total or the average', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 12 });
    const res = await move({ type: 'Transfer', item: 'A', warehouse: 'MAIN', toWarehouse: 'BXL', qty: 4 });
    expect(res.inserted[0]!.row.values).toMatchObject({ unitCost: 12, value: 48, signedQty: -4 });
    expect((await item('A')).values).toMatchObject({ onHand: 10, avgCost: 12 });

    const levels = await rows('stockLevels');
    // Sorted by SKU, then warehouse code.
    expect(levels.map((r) => [r.values.onHand, r.values.value, r.values.itemOnHand])).toEqual([
      [4, 48, 10], // BXL
      [6, 72, 10], // MAIN
    ]);
  });

  it('validates transfer and adjustment fields', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10 });
    const res = await move(
      { type: 'Transfer', item: 'A', warehouse: 'MAIN', qty: 1 },
      { type: 'Transfer', item: 'A', warehouse: 'MAIN', toWarehouse: 'MAIN', qty: 1 },
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', toWarehouse: 'BXL', qty: 1 },
      { type: 'Adjustment', item: 'A', warehouse: 'MAIN', qty: -2 },
      { type: 'Adjustment', item: 'A', warehouse: 'MAIN', qty: 0, reason: 'x' },
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: -1 },
      { type: 'Issue', item: 'NOPE', warehouse: 'MAIN', qty: 1 },
    );
    expect(res.inserted).toHaveLength(0);
    expect(res.errors.map((e) => `${e.ref} ${e.column}: ${e.message}`)).toEqual([
      'm6 item: No item "NOPE"',
      'm0 toWarehouse: Required for a transfer',
      'm1 toWarehouse: Must be a different warehouse',
      'm2 toWarehouse: Only used for transfers',
      'm3 reason: Required for an adjustment',
      'm4 qty: Use + to add stock, − to remove it',
      'm5 qty: Must be more than 0',
    ]);
  });

  it('costs a stock-count adjustment at the average both ways', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 5 });
    const res = await move(
      { type: 'Adjustment', item: 'A', warehouse: 'MAIN', qty: -3, reason: 'Count' },
      { type: 'Adjustment', item: 'A', warehouse: 'MAIN', qty: 1, reason: 'Found one' },
    );
    expect(res.inserted.map((i) => [i.row.values.unitCost, i.row.values.value])).toEqual([
      [5, -15],
      [5, 5],
    ]);
  });
});

describe('ledger rules', () => {
  it("doesn't allow editing or deleting a saved movement", async () => {
    const { inserted } = await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1 });
    const row = inserted[0]!.row;
    const res = await batch('stockMovements', {
      updates: [{ id: row.id, version: 1, set: { qty: 5 } }],
      deletes: [{ id: row.id, version: 1 }],
    });
    expect(res.errors.map((e) => e.op)).toEqual(['delete', 'update']);
    expect(res.errors[0]!.message).toMatch(/Reverse/);
    expect((await rows('stockMovements'))[0]!.values.qty).toBe(1);
  });

  it('reverses a movement exactly once and restores stock', async () => {
    const { inserted } = await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    const id = inserted[0]!.row.id;
    const res = await reverse(id);
    expect(res.statusCode).toBe(200);
    const [original, reversal] = (res.json() as { rows: Row[] }).rows;
    expect(original!.values.status).toBe('Reversed');
    expect(reversal!.values).toMatchObject({ status: 'Reversal', qty: -10, signedQty: -10, value: -40, reversalOf: id });
    expect((await item('A')).values).toMatchObject({ onHand: 0, stockValue: 0 });

    expect((await reverse(id)).json().message).toBe('This movement is already reversed');
    expect((await reverse(reversal!.id)).statusCode).toBe(409);
  });

  it("won't reverse a receipt whose stock was already used", async () => {
    const { inserted } = await move(
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 },
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 8 },
    );
    const res = await reverse(inserted[0]!.row.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("Can't reverse: only 2 left in MAIN");
  });

  it('reverses a transfer back to its source', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    const { inserted } = await move({ type: 'Transfer', item: 'A', warehouse: 'MAIN', toWarehouse: 'BXL', qty: 3 });
    expect((await reverse(inserted[0]!.row.id)).statusCode).toBe(200);
    expect((await rows('stockLevels')).map((r) => r.values.onHand)).toEqual([0, 10]); // BXL, MAIN
  });

  it('keeps items and warehouses that movements point at', async () => {
    await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1 });
    const [a, b] = [await item('A'), await item('B')];
    const res = await batch('items', { deletes: [{ id: a.id, version: a.version }, { id: b.id, version: b.version }] });
    expect(res.errors).toEqual([{ op: 'delete', ref: a.id, message: "Used in Stock movements, so it can't be deleted" }]);
    expect(res.deleted).toEqual([b.id]);
  });

  it('refuses edits to the calculated Stock levels sheet', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sheets/stockLevels/batch', payload: { inserts: [] } });
    expect(res.statusCode).toBe(400);
  });
});

describe('seed data', () => {
  it('posts the starter movements with the expected averages', async () => {
    const fresh = new MemoryStore();
    await fresh.init(sheets);
    app = buildApp(fresh);
    expect(await seedIfEmpty(fresh)).toEqual([
      'warehouses (2)',
      'items (12)',
      'stockMovements (9)',
      'suppliers (3)',
      'purchaseOrders (2)',
      'purchaseOrderLines (5)',
      'goodsReceipts (2)',
      'supplierBills (1)',
    ]);
    // BOLT-M8: 40 @ 6.20 + 20 @ 6.80 = 60 @ 6.40, 45 issued → 15 @ 6.40 (96), then PO-00001 brings 100 @ 6.50.
    expect((await item('BOLT-M8')).values).toMatchObject({ onHand: 115, stockValue: 746, stockStatus: 'OK', onOrder: 0 });
    expect((await item('NUT-M8')).values).toMatchObject({ onHand: 100, onOrder: 60 });
    expect((await item('PIPE-CU-15')).values).toMatchObject({ onHand: 120, avgCost: 7.5 });
  });
});

describe('review fixes', () => {
  it('saves only one reversal when Reverse is sent twice at once', async () => {
    const { inserted } = await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    const id = inserted[0]!.row.id;
    const results = await Promise.all([reverse(id), reverse(id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await rows('stockMovements')).filter((r) => r.values.reversalOf === id)).toHaveLength(1);
    expect((await item('A')).values).toMatchObject({ onHand: 0, stockValue: 0 });
  });

  it("refuses a reversal that would leave stock with a negative value", async () => {
    const { inserted } = await move(
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 1 },
      { type: 'Receipt', item: 'A', warehouse: 'BXL', qty: 10, unitCost: 100 },
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 5 },
    );
    const res = await reverse(inserted[1]!.row.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Adjustment/);
    expect((await item('A')).values.avgCost).toBe(50.5);
  });

  it('rejects batches that reuse a tempId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sheets/stockMovements/batch',
      payload: { inserts: [{ tempId: 'x', values: {} }, { tempId: 'x', values: {} }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('only runs declared actions', async () => {
    const { inserted } = await move({ type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1 });
    const id = inserted[0]!.row.id;
    for (const name of ['constructor', 'toString', '__proto__', 'nope']) {
      const res = await app.inject({ method: 'POST', url: `/api/sheets/stockMovements/rows/${id}/actions/${name}` });
      expect(res.statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: `/api/sheets/items/rows/${id}/actions/reverse` })).statusCode).toBe(404);
  });

  it("doesn't seed into a database that already has data", async () => {
    // beforeEach created items and warehouses, so seeding must add nothing (not even movements).
    expect(await seedIfEmpty(store)).toEqual([]);
    expect(await rows('stockMovements')).toEqual([]);
  });
});
