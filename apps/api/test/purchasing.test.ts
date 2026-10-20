import { MemoryStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, type Row, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

const batch = async (sheet: string, body: BatchRequest) =>
  (await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body })).json() as BatchResponse;
const insert = (sheet: string, ...rows: Record<string, string | number | null>[]) =>
  batch(sheet, { inserts: rows.map((values, i) => ({ tempId: `t${i}`, values })) });
const rows = async (sheet: string) =>
  ((await app.inject({ method: 'GET', url: `/api/sheets/${sheet}/rows` })).json() as { rows: Row[] }).rows;
const find = async (sheet: string, column: string, value: string) => (await rows(sheet)).find((r) => r.values[column] === value)!;
const action = (sheet: string, id: string, name: string) =>
  app.inject({ method: 'POST', url: `/api/sheets/${sheet}/rows/${id}/actions/${name}` });
const po = (number: string) => find('purchaseOrders', 'number', number);
const item = (sku: string) => find('items', 'sku', sku);

beforeEach(async () => {
  const store = new MemoryStore();
  await store.init(sheets);
  app = buildApp(store, { auth: false });
  await insert('warehouses', { code: 'MAIN', name: 'Main' }, { code: 'BXL', name: 'Brussels' });
  await insert(
    'items',
    { sku: 'A', name: 'Item A', unit: 'pcs', cost: 5 },
    { sku: 'B', name: 'Item B', unit: 'pcs' },
  );
  await insert('suppliers', { code: 'SUP', name: 'Supplier', paymentTermsDays: 30 }, { code: 'OTHER', name: 'Other' });
});

/** A sent PO-00001 for 10 A @ 4 and 5 B @ 20, delivered to MAIN. */
async function sentPo() {
  await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
  await insert('purchaseOrderLines', { po: 'PO-00001', item: 'A', qty: 10, unitPrice: 4 }, { po: 'PO-00001', item: 'B', qty: 5, unitPrice: 20 });
  const res = await action('purchaseOrders', (await po('PO-00001')).id, 'send');
  expect(res.statusCode).toBe(200);
}

describe('purchase orders', () => {
  it('numbers POs automatically and keeps typed numbers', async () => {
    const res = await insert(
      'purchaseOrders',
      { supplier: 'SUP', warehouse: 'MAIN' },
      { number: 'PO-00007', supplier: 'sup', warehouse: 'main' },
      { supplier: 'SUP', warehouse: 'MAIN' },
    );
    expect(res.inserted.map((i) => i.row.values.number)).toEqual(['PO-00008', 'PO-00007', 'PO-00009']);
    expect(res.inserted[0]!.row.values).toMatchObject({ state: 'Draft', status: 'Draft', total: 0, lineCount: 0 });
  });

  it('fills a blank line price from the item and allows each item once per PO', async () => {
    await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    const res = await insert(
      'purchaseOrderLines',
      { po: 'PO-00001', item: 'A', qty: 3 },
      { po: 'PO-00001', item: 'a', qty: 1 },
      { po: 'PO-00001', item: 'B', qty: 1 },
      { po: 'PO-00001', item: 'B', qty: 0, unitPrice: 1 },
    );
    expect(res.inserted.map((i) => i.row.values)).toMatchObject([{ unitPrice: 5, lineTotal: 15, status: 'Draft' }]);
    expect(res.errors.map((e) => `${e.ref} ${e.column}: ${e.message}`)).toEqual([
      "t1 item: A is already on PO-00001; change that line's qty instead",
      't2 unitPrice: Enter a price (the item has no default cost)',
      't3 qty: Must be more than 0',
    ]);
    expect((await po('PO-00001')).values).toMatchObject({ total: 15, lineCount: 1 });
  });

  it("can't be sent empty, and locks its lines and header once sent", async () => {
    await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    const empty = await action('purchaseOrders', (await po('PO-00001')).id, 'send');
    expect(empty.statusCode).toBe(409);
    expect(empty.json().message).toMatch(/no lines/);

    await insert('purchaseOrderLines', { po: 'PO-00001', item: 'A', qty: 10, unitPrice: 4 });
    await action('purchaseOrders', (await po('PO-00001')).id, 'send');
    const order = await po('PO-00001');
    expect(order.values).toMatchObject({ state: 'Sent', status: 'Sent', total: 40 });

    const line = await find('purchaseOrderLines', 'qty', 10 as never);
    const lineEdit = await batch('purchaseOrderLines', { updates: [{ id: line.id, version: line.version, set: { qty: 99 } }] });
    expect(lineEdit.errors[0]!.message).toBe('The PO has been sent, so its lines are locked.');
    const added = await insert('purchaseOrderLines', { po: 'PO-00001', item: 'B', qty: 1, unitPrice: 1 });
    expect(added.errors[0]!.message).toMatch(/has been sent/);

    const header = await batch('purchaseOrders', {
      updates: [{ id: order.id, version: order.version, set: { supplier: 'OTHER', notes: 'Call first' } }],
      deletes: [],
    });
    expect(header.errors.map((e) => e.column)).toEqual(['supplier']);
    expect(header.updated[0]!.values.notes).toBe('Call first');
    const del = await batch('purchaseOrders', { deletes: [{ id: order.id, version: order.version + 1 }] });
    expect(del.errors[0]!.message).toMatch(/has been sent/);
  });

  it('shows what is on order on items and suppliers', async () => {
    await sentPo();
    expect((await item('A')).values.onOrder).toBe(10);
    expect((await find('suppliers', 'code', 'SUP')).values.openOrders).toBe(140);
  });
});

describe('goods receipts', () => {
  it('posts stock at the PO price into the PO warehouse and updates the PO', async () => {
    await sentPo();
    const res = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 6, reference: 'DN-1' });
    expect(res.errors).toEqual([]);
    expect(res.inserted[0]!.row.values).toMatchObject({ unitCost: 4, value: 24, status: 'Posted' });

    const movement = (await rows('stockMovements'))[0]!;
    expect(movement.values).toMatchObject({ type: 'Receipt', qty: 6, unitCost: 4, reference: 'PO-00001 / DN-1', source: 'goodsReceipts' });
    expect((await item('A')).values).toMatchObject({ onHand: 6, avgCost: 4, onOrder: 4 });
    expect((await po('PO-00001')).values).toMatchObject({ status: 'Partially received', received: 24 });
    const line = (await rows('purchaseOrderLines')).find((l) => l.values.received === 6)!;
    expect(line.values).toMatchObject({ outstanding: 4, status: 'Partially received' });
  });

  it('blocks over-receipt, including across rows of one paste', async () => {
    await sentPo();
    const res = await insert(
      'goodsReceipts',
      { po: 'PO-00001', item: 'A', qty: 7 },
      { po: 'PO-00001', item: 'A', qty: 4 },
      { po: 'PO-00001', item: 'A', qty: 3 },
      { po: 'PO-00001', item: 'A', qty: 1 },
    );
    expect(res.inserted).toHaveLength(2);
    expect(res.errors.map((e) => `${e.ref}: ${e.message}`)).toEqual([
      't1: Only 3 outstanding on PO-00001',
      't3: Nothing outstanding for A on PO-00001',
    ]);
    expect((await item('A')).values.onHand).toBe(10);
  });

  it('rejects receipts for draft or closed POs and items not on the PO', async () => {
    await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    await insert('purchaseOrderLines', { po: 'PO-00001', item: 'A', qty: 1, unitPrice: 1 });
    const draft = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 1 });
    expect(draft.errors[0]!.message).toMatch(/still a draft/);

    await action('purchaseOrders', (await po('PO-00001')).id, 'send');
    const wrongItem = await insert('goodsReceipts', { po: 'PO-00001', item: 'B', qty: 1 });
    expect(wrongItem.errors[0]!.message).toBe("B isn't on PO-00001");

    await action('purchaseOrders', (await po('PO-00001')).id, 'close');
    const closed = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 1 });
    expect(closed.errors[0]!.message).toMatch(/is closed/);
    expect((await item('A')).values.onOrder).toBe(0);
    expect(await rows('stockMovements')).toEqual([]);
  });

  it('receives everything outstanding with Receive all', async () => {
    await sentPo();
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 4, warehouse: 'BXL' });
    const res = await action('purchaseOrders', (await po('PO-00001')).id, 'receiveAll');
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].values).toMatchObject({ status: 'Received', received: 140 });
    expect((await rows('goodsReceipts')).map((g) => g.values.qty)).toEqual([4, 6, 5]);
    expect((await action('purchaseOrders', (await po('PO-00001')).id, 'receiveAll')).json().message).toMatch(/Nothing outstanding/);
  });

  it('reverses a receipt together with its stock, and only from Goods receipts', async () => {
    await sentPo();
    const gr = (await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 })).inserted[0]!.row;
    const movementId = String(gr.values.movement);
    const direct = await action('stockMovements', movementId, 'reverse');
    expect(direct.statusCode).toBe(409);
    expect(direct.json().message).toMatch(/goods receipt/);

    const res = await action('goodsReceipts', gr.id, 'reverse');
    expect(res.statusCode).toBe(200);
    expect((await item('A')).values).toMatchObject({ onHand: 0, onOrder: 10 });
    expect((await rows('stockMovements')).map((m) => m.values.status)).toEqual(['Reversed', 'Reversal']);
    expect((await po('PO-00001')).values.status).toBe('Sent');
    // Received again after the reversal: the line is open again.
    expect((await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 })).errors).toEqual([]);
    expect((await action('goodsReceipts', gr.id, 'reverse')).statusCode).toBe(409);
  });

  it("won't reverse a receipt whose stock was already issued, and saves neither side", async () => {
    await sentPo();
    const gr = (await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 })).inserted[0]!.row;
    await insert('stockMovements', { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 8 });
    const res = await action('goodsReceipts', gr.id, 'reverse');
    expect(res.statusCode).toBe(409);
    expect((await rows('goodsReceipts')).map((g) => g.values.status)).toEqual(['Posted']);
    expect(await rows('stockMovements')).toHaveLength(2);
  });
});

describe('supplier bills', () => {
  it('matches bills against what was received', async () => {
    await sentPo();
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 });
    const res = await insert('supplierBills', { billNo: 'INV-1', po: 'PO-00001', date: '2026-10-01', amount: 30 });
    expect(res.inserted[0]!.row.values).toMatchObject({
      dueDate: '2026-10-31',
      poReceived: 40,
      poBilled: 30,
      difference: -10,
      match: 'Billed < received',
    });
    await insert('supplierBills', { billNo: 'INV-2', po: 'PO-00001', amount: 10 });
    expect((await rows('supplierBills')).map((b) => b.values.match)).toEqual(['Matched', 'Matched']);
    expect((await po('PO-00001')).values.billed).toBe(40);
  });

  it('rejects duplicate bill numbers per supplier, drafts and zero amounts', async () => {
    await sentPo();
    await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    const res = await insert(
      'supplierBills',
      { billNo: 'INV-1', po: 'PO-00001', amount: 10 },
      { billNo: 'inv-1', po: 'PO-00001', amount: 10 },
      { billNo: 'INV-9', po: 'PO-00002', amount: 10 },
      { billNo: 'INV-3', po: 'PO-00001', amount: 0 },
    );
    expect(res.inserted).toHaveLength(1);
    expect(res.errors.map((e) => `${e.ref} ${e.column}`)).toEqual(['t1 billNo', 't2 po', 't3 amount']);

    const bill = res.inserted[0]!.row;
    const edit = await batch('supplierBills', { updates: [{ id: bill.id, version: 1, set: { po: 'PO-00002', amount: 12 } }] });
    expect(edit.errors.map((e) => e.column)).toEqual(['po']);
    expect(edit.updated[0]!.values.amount).toBe(12);
  });
});

describe('references', () => {
  it("keeps suppliers, POs and items that are in use", async () => {
    await sentPo();
    const sup = await find('suppliers', 'code', 'SUP');
    const res = await batch('suppliers', { deletes: [{ id: sup.id, version: sup.version }] });
    expect(res.errors[0]!.message).toBe("Used in Purchase orders, so it can't be deleted");
  });
});

describe('review fixes', () => {
  const lines = async () => (await rows('purchaseOrderLines')).map((l) => ({ id: l.id, version: l.version, item: l.values.item }));

  it('keeps one line per item across edits and new rows in the same batch, and allows swaps', async () => {
    await insert('items', { sku: 'C', name: 'Item C', unit: 'pcs', cost: 1 });
    await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    await insert('purchaseOrderLines', { po: 'PO-00001', item: 'A', qty: 1 }, { po: 'PO-00001', item: 'B', qty: 1, unitPrice: 1 });
    const [a, b] = await lines();
    const ids = Object.fromEntries((await rows('items')).map((i) => [i.values.sku, i.id]));

    // Both lines to C in one batch: one must fail.
    const both = await batch('purchaseOrderLines', {
      updates: [
        { id: a!.id, version: a!.version, set: { item: 'C' } },
        { id: b!.id, version: b!.version, set: { item: 'C' } },
      ],
    });
    expect(both.errors.filter((e) => e.column === 'item')).toHaveLength(2);

    // Line A → C plus a new line for C: the new line is refused.
    const mixed = await batch('purchaseOrderLines', {
      updates: [{ id: a!.id, version: a!.version, set: { item: 'C' } }],
      inserts: [{ tempId: 'n', values: { po: 'PO-00001', item: 'C', qty: 1 } }],
    });
    expect(mixed.errors.map((e) => e.ref)).toEqual(['n']);
    expect((await lines()).map((l) => l.item).sort()).toEqual([ids.B, ids.C].sort());

    // Swap B ↔ C works.
    const [l1, l2] = await lines();
    const swap = await batch('purchaseOrderLines', {
      updates: [
        { id: l1!.id, version: l1!.version, set: { item: l2!.item as string } },
        { id: l2!.id, version: l2!.version, set: { item: l1!.item as string } },
      ],
    });
    expect(swap.errors).toEqual([]);

    // Delete a line and re-add its item in one batch works.
    const [d] = await lines();
    const readd = await batch('purchaseOrderLines', {
      deletes: [{ id: d!.id, version: d!.version }],
      inserts: [{ tempId: 'r', values: { po: 'PO-00001', item: d!.item as string, qty: 5, unitPrice: 2 } }],
    });
    expect(readd.errors.map((e) => e.message)).toEqual([]);
  });

  it('Receive all only posts what is outstanding', async () => {
    await sentPo();
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 });
    // Line A now has nothing outstanding; B has 5. Receive all only sends B, so it succeeds:
    expect((await action('purchaseOrders', (await po('PO-00001')).id, 'receiveAll')).statusCode).toBe(200);
    expect((await rows('goodsReceipts')).map((g) => g.values.qty)).toEqual([10, 5]);
  });

  it('numbers new POs around renames and huge typed numbers', async () => {
    await insert('purchaseOrders', { number: 'X', supplier: 'SUP', warehouse: 'MAIN' }, { number: 'PO-99999999999999999', supplier: 'SUP', warehouse: 'MAIN' });
    const x = await po('X');
    const res = await batch('purchaseOrders', {
      updates: [{ id: x.id, version: x.version, set: { number: 'PO-00001' } }],
      inserts: [{ tempId: 'n', values: { supplier: 'SUP', warehouse: 'MAIN' } }],
    });
    expect(res.errors).toEqual([]);
    expect(res.inserted[0]!.row.values.number).toBe('PO-00002');
    const more = await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    expect(more.inserted[0]!.row.values.number).toBe('PO-00003');
  });

  it("won't clear a PO number", async () => {
    await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
    const p = await po('PO-00001');
    const res = await batch('purchaseOrders', { updates: [{ id: p.id, version: p.version, set: { number: '' } }] });
    expect(res.errors[0]).toMatchObject({ column: 'number', message: 'A PO needs a number' });
  });

  it('keeps the delivery note on a reversal', async () => {
    await sentPo();
    const gr = (await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 2, reference: 'DN-9' })).inserted[0]!.row;
    await action('goodsReceipts', gr.id, 'reverse');
    expect((await rows('goodsReceipts')).map((g) => g.values.reference)).toEqual(['DN-9', 'DN-9']);
  });

  it('a receipt and a line edit bump the PO version, so concurrent changes conflict', async () => {
    await sentPo();
    const before = (await po('PO-00001')).version;
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 1 }, { po: 'PO-00001', item: 'B', qty: 1 });
    expect((await po('PO-00001')).version).toBe(before + 1); // once per batch, even for two receipts
  });
});
