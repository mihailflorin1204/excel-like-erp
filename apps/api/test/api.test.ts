import { MemoryStore, type SheetStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, type RowsResponse, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

let store: SheetStore;
let app: FastifyInstance;

beforeEach(async () => {
  store = new MemoryStore();
  await store.init(sheets);
  app = buildApp(store);
});
afterEach(async () => {
  await app.close();
});

const batch = async (body: BatchRequest, sheet = 'items') => {
  const res = await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body });
  return { status: res.statusCode, body: res.json() as BatchResponse };
};
const rows = async (sheet = 'items') =>
  (await app.inject({ method: 'GET', url: `/api/sheets/${sheet}/rows` })).json() as RowsResponse;

const item = (n: number) => ({ sku: `SKU-${n}`, name: `Item ${n}`, unit: 'pcs', cost: n / 10, reorderPoint: n % 7 });

describe('Phase 1 gate: paste 500 rows', () => {
  it('saves the valid rows and flags each invalid cell', async () => {
    const inserts = Array.from({ length: 500 }, (_, i) => ({ tempId: `t${i}`, values: item(i) as Record<string, string | number | null> }));
    inserts[10]!.values.unit = 'crate'; // not an option
    inserts[20]!.values.cost = 'twelve'; // not a number
    inserts[30]!.values.name = ''; // required
    inserts[40]!.values.sku = 'sku-1'; // duplicate of row 1 (case-insensitive)

    const { status, body } = await batch({ inserts });
    expect(status).toBe(200);
    expect(body.inserted).toHaveLength(496);
    expect(body.errors.map((e) => [e.ref, e.column])).toEqual([
      ['t10', 'unit'],
      ['t20', 'cost'],
      ['t30', 'name'],
      ['t40', 'sku'],
    ]);
    expect(body.errors[3]!.message).toMatch(/appears more than once/);

    const listed = await rows();
    expect(listed.total).toBe(496);
    expect(listed.rows[0]!.values).toMatchObject({ sku: 'SKU-0', onHand: 0, category: null });
    // Pasted order is kept.
    expect(listed.rows.slice(0, 3).map((r) => r.values.sku)).toEqual(['SKU-0', 'SKU-1', 'SKU-2']);
  });
});

describe('updates', () => {
  it('saves valid cells, rejects invalid ones, and writes the audit trail', async () => {
    const { body } = await batch({ inserts: [{ tempId: 'a', values: item(1) }] });
    const row = body.inserted[0]!.row;

    const res = await batch({ updates: [{ id: row.id, version: 1, set: { cost: '1.234,50', reorderPoint: -3 } }] });
    expect(res.body.updated[0]!.values.cost).toBe(1234.5);
    expect(res.body.updated[0]!.version).toBe(2);
    expect(res.body.errors).toEqual([{ op: 'update', ref: row.id, column: 'reorderPoint', message: 'Must be 0 or more' }]);

    const audit = (await app.inject({ method: 'GET', url: `/api/sheets/items/rows/${row.id}/audit` })).json() as {
      entries: { op: string; column: string; oldValue: unknown; newValue: unknown }[];
    };
    expect(audit.entries[0]).toMatchObject({ op: 'update', column: 'cost', oldValue: 0.1, newValue: 1234.5 });
    expect(audit.entries.filter((e) => e.op === 'insert').map((e) => e.column).sort()).toEqual(
      ['cost', 'name', 'reorderPoint', 'sku', 'unit'],
    );
  });

  it('reports a conflict when the row changed since it was loaded', async () => {
    const { body } = await batch({ inserts: [{ tempId: 'a', values: item(1) }] });
    const id = body.inserted[0]!.row.id;
    await batch({ updates: [{ id, version: 1, set: { name: 'First edit' } }] });

    const stale = await batch({ updates: [{ id, version: 1, set: { name: 'Stale edit' } }] });
    expect(stale.body.updated).toEqual([]);
    expect(stale.body.conflicts[0]!.current!.values.name).toBe('First edit');
    expect(stale.body.conflicts[0]!.current!.version).toBe(2);
  });

  it('blocks a duplicate SKU against existing rows but allows swapping values in one batch', async () => {
    const { body } = await batch({ inserts: [{ tempId: 'a', values: item(1) }, { tempId: 'b', values: item(2) }] });
    const [a, b] = body.inserted.map((i) => i.row);

    const dup = await batch({ updates: [{ id: b!.id, version: 1, set: { sku: 'SKU-1', name: 'Renamed' } }] });
    expect(dup.body.errors[0]).toMatchObject({ column: 'sku', message: 'SKU "SKU-1" is already used by another row' });
    expect(dup.body.updated[0]!.values).toMatchObject({ sku: 'SKU-2', name: 'Renamed' });

    const swap = await batch({
      updates: [
        { id: a!.id, version: 1, set: { sku: 'SKU-2' } },
        { id: b!.id, version: 2, set: { sku: 'SKU-1' } },
      ],
    });
    expect(swap.body.errors).toEqual([]);
    expect(swap.body.updated.map((r) => r.values.sku)).toEqual(['SKU-2', 'SKU-1']);
  });

  it('skips cells that did not change', async () => {
    const { body } = await batch({ inserts: [{ tempId: 'a', values: item(1) }] });
    const row = body.inserted[0]!.row;
    const res = await batch({ updates: [{ id: row.id, version: 1, set: { name: 'Item 1' } }] });
    expect(res.body.updated[0]!.version).toBe(1);
  });
});

describe('deletes and errors', () => {
  it('deletes a row and frees its unique value', async () => {
    const { body } = await batch({ inserts: [{ tempId: 'a', values: item(1) }] });
    const row = body.inserted[0]!.row;
    const res = await batch({ deletes: [{ id: row.id, version: 1 }], inserts: [{ tempId: 'b', values: item(1) }] });
    expect(res.body.deleted).toEqual([row.id]);
    expect(res.body.inserted).toHaveLength(1);
    expect((await rows()).total).toBe(1);
  });

  it('rejects unknown sheets and malformed batches', async () => {
    expect((await batch({ inserts: [] }, 'nope')).status).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/api/sheets/items/batch', payload: { inserts: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('serves sheet definitions', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/sheets' })).json() as { sheets: { key: string }[] };
    expect(res.sheets.map((s) => s.key)).toEqual(['items', 'warehouses']);
  });
});
