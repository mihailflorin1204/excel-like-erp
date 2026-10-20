/**
 * The same core scenarios against a real MongoDB. Skipped unless MONGO_TEST_URL is set, e.g. in PowerShell:
 *   $env:MONGO_TEST_URL="mongodb://localhost:27017/erp_test?replicaSet=rs0&directConnection=true"; pnpm test
 * Uses (and empties) the database named in the URL, so never point it at your real data.
 */
import { MongoStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, internalSheets, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const url = process.env.MONGO_TEST_URL;

describe.skipIf(!url)('MongoStore (real MongoDB)', () => {
  let store: MongoStore;
  let app: FastifyInstance;

  beforeAll(async () => {
    const admin = new MongoClient(url!);
    await admin.connect();
    await admin.db().dropDatabase();
    await admin.close();
    store = new MongoStore(url!);
    await store.init([...sheets, ...internalSheets]);
    app = buildApp(store, { auth: false });
  });
  afterAll(async () => {
    await app?.close();
    await store?.close();
  });

  const batch = async (body: BatchRequest) => {
    const res = await app.inject({ method: 'POST', url: '/api/sheets/items/batch', payload: body });
    expect(res.statusCode).toBe(200);
    return res.json() as BatchResponse;
  };
  const item = (n: number) => ({ sku: `M-${n}`, name: `Item ${n}`, unit: 'pcs', cost: n });

  it('saves a 500-row paste in one transaction, keeps paste order and rejects bad rows', async () => {
    const inserts = Array.from({ length: 500 }, (_, i) => ({ tempId: `t${i}`, values: item(i) as Record<string, string | number | null> }));
    inserts[3]!.values.unit = 'crate';
    inserts[4]!.values.sku = 'm-0';
    const res = await batch({ inserts });
    expect(res.inserted).toHaveLength(498);
    expect(res.errors.map((e) => e.column)).toEqual(['unit', 'sku']);

    const listed = (await app.inject({ method: 'GET', url: '/api/sheets/items/rows?limit=3' })).json();
    expect(listed.total).toBe(498);
    expect(listed.rows.map((r: { values: { sku: string } }) => r.values.sku)).toEqual(['M-0', 'M-1', 'M-2']);
  });

  it('enforces the unique index case-insensitively, but allows a swap within one batch', async () => {
    const res = await batch({ inserts: [{ tempId: 'a', values: item(1000) }, { tempId: 'b', values: item(1001) }] });
    const [a, b] = res.inserted.map((i) => i.row);
    const swap = await batch({
      updates: [
        { id: a!.id, version: 1, set: { sku: 'M-1001' } },
        { id: b!.id, version: 1, set: { sku: 'm-1000' } },
      ],
    });
    expect(swap.errors).toEqual([]);
    expect(swap.updated.map((r) => r.values.sku)).toEqual(['M-1001', 'm-1000']);
  });

  it('frees a unique value for reuse in the same batch (delete + insert, rename + insert)', async () => {
    const res = await batch({ inserts: [{ tempId: 'a', values: item(3000) }, { tempId: 'b', values: item(3001) }] });
    const [a, b] = res.inserted.map((i) => i.row);
    const reuse = await batch({
      deletes: [{ id: a!.id, version: 1 }],
      updates: [{ id: b!.id, version: 1, set: { sku: 'M-3002' } }],
      inserts: [
        { tempId: 'c', values: item(3000) },
        { tempId: 'd', values: item(3001) },
      ],
    });
    expect(reuse.errors).toEqual([]);
    expect(reuse.inserted).toHaveLength(2);
    expect(reuse.deleted).toEqual([a!.id]);
  });

  it('posts stock movements in a transaction and allows only one Reverse', async () => {
    const setup = async (sheet: string, body: BatchRequest) =>
      (await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body })).json() as BatchResponse;
    await setup('warehouses', { inserts: [{ tempId: 'w', values: { code: 'MT', name: 'Mongo test' } }] });
    const moved = await setup('stockMovements', {
      inserts: [
        { tempId: 'r', values: { type: 'Receipt', item: 'M-0', warehouse: 'MT', qty: 10, unitCost: 2 } },
        { tempId: 'i', values: { type: 'Issue', item: 'M-0', warehouse: 'MT', qty: 11 } },
      ],
    });
    expect(moved.inserted).toHaveLength(1);
    expect(moved.errors[0]!.message).toBe('Only 10 in stock in MT');

    const id = moved.inserted[0]!.row.id;
    const url = `/api/sheets/stockMovements/rows/${id}/actions/reverse`;
    const results = await Promise.all([app.inject({ method: 'POST', url }), app.inject({ method: 'POST', url })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const levels = (await app.inject({ method: 'GET', url: '/api/sheets/stockLevels/rows' })).json();
    expect(levels.rows.map((r: { values: { onHand: number } }) => r.values.onHand)).toEqual([0]);
  });

  it('detects version conflicts and writes audit rows', async () => {
    const res = await batch({ inserts: [{ tempId: 'a', values: item(2000) }] });
    const id = res.inserted[0]!.row.id;
    await batch({ updates: [{ id, version: 1, set: { name: 'First' } }] });
    const stale = await batch({ updates: [{ id, version: 1, set: { name: 'Stale' } }] });
    expect(stale.conflicts[0]!.current!.values.name).toBe('First');

    const audit = (await app.inject({ method: 'GET', url: `/api/sheets/items/rows/${id}/audit` })).json();
    expect(audit.entries[0]).toMatchObject({ op: 'update', column: 'name', oldValue: 'Item 2000', newValue: 'First' });
  });

  it('posts a purchase-to-payment flow to a balanced ledger, and posts a bill only once', async () => {
    const call = async (sheet: string, body: BatchRequest) =>
      (await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body })).json() as BatchResponse;
    const act = (sheet: string, id: string, name: string) =>
      app.inject({ method: 'POST', url: `/api/sheets/${sheet}/rows/${id}/actions/${name}` });
    await call('suppliers', { inserts: [{ tempId: 's', values: { code: 'MSUP', name: 'Mongo supplier' } }] });
    const order = await call('purchaseOrders', { inserts: [{ tempId: 'p', values: { supplier: 'MSUP', warehouse: 'MT' } }] });
    const poId = order.inserted[0]!.row.id;
    const poNo = String(order.inserted[0]!.row.values.number);
    await call('purchaseOrderLines', { inserts: [{ tempId: 'l', values: { po: poNo, item: 'M-1', qty: 4, unitPrice: 2.5 } }] });
    expect((await act('purchaseOrders', poId, 'send')).statusCode).toBe(200);
    expect((await act('purchaseOrders', poId, 'receiveAll')).statusCode).toBe(200);
    const bills = await call('supplierBills', { inserts: [{ tempId: 'b', values: { billNo: 'MB-1', po: poNo, amount: 10 } }] });
    const billId = bills.inserted[0]!.row.id;
    const posts = await Promise.all([act('supplierBills', billId, 'post'), act('supplierBills', billId, 'post')]);
    expect(posts.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const paid = await call('supplierPayments', { inserts: [{ tempId: 'x', values: { supplier: 'MSUP', billNo: 'MB-1', amount: 10 } }] });
    expect(paid.errors).toEqual([]);

    const tb = (await app.inject({ method: 'GET', url: '/api/sheets/trialBalance/rows' })).json();
    const total = tb.rows.find((r: { id: string }) => r.id === 'total').values;
    expect(total.check).toBe('Balanced');
    const bill = (await app.inject({ method: 'GET', url: '/api/sheets/supplierBills/rows' })).json().rows[0].values;
    expect(bill).toMatchObject({ state: 'Posted', status: 'Paid', open: 0 });
  });

  it('signs in with sessions in the database, posts an expense claim and saves a view', async () => {
    const secured = buildApp(store);
    const setup = await secured.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'mongo@example.com', name: 'Mongo admin', password: 'correct horse battery' } });
    expect(setup.statusCode, setup.body).toBe(200);
    const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
    const call = (method: 'GET' | 'POST', url: string, payload?: object) => secured.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    expect((await call('GET', '/api/auth/me')).json().user.email).toBe('mongo@example.com');

    await call('POST', '/api/sheets/departments/batch', { inserts: [{ tempId: 'd', values: { code: 'MDEP', name: 'Mongo dept' } }] });
    await call('POST', '/api/sheets/employees/batch', { inserts: [{ tempId: 'e', values: { code: 'MEMP', name: 'Someone', department: 'MDEP' } }] });
    const claim = (await call('POST', '/api/sheets/expenseClaims/batch', { inserts: [{ tempId: 'c', values: { employee: 'MEMP', category: 'Travel', amount: 12.5 } }] })).json();
    const id = claim.inserted[0].row.id;
    for (const action of ['submit', 'approve', 'pay']) {
      const res = await call('POST', `/api/sheets/expenseClaims/rows/${id}/actions/${action}`);
      expect(res.statusCode, res.body).toBe(200);
    }
    const tb = (await call('GET', '/api/sheets/trialBalance/rows')).json();
    expect(tb.rows.find((r: { id: string }) => r.id === 'total').values.check).toBe('Balanced');

    const view = await call('POST', '/api/views', { sheet: 'items', name: 'Mongo view', config: { query: '', sort: null, hidden: [], frozen: 1, formulas: [] } });
    expect(view.statusCode, view.body).toBe(200);
    expect((await call('GET', '/api/views?sheet=items')).json().views.map((v: { name: string }) => v.name)).toEqual(['Mongo view']);
    await call('POST', '/api/auth/logout');
    expect((await call('GET', '/api/sheets')).statusCode).toBe(401);
    await secured.close();
  });
});
