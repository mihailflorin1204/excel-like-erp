/**
 * The same core scenarios against a real MongoDB. Skipped unless MONGO_TEST_URL is set, e.g. in PowerShell:
 *   $env:MONGO_TEST_URL="mongodb://localhost:27017/erp_test?replicaSet=rs0&directConnection=true"; pnpm test
 * Uses (and empties) the database named in the URL, so never point it at your real data.
 */
import { MongoStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, sheets } from '@erp/schema';
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
    await store.init(sheets);
    app = buildApp(store);
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

  it('detects version conflicts and writes audit rows', async () => {
    const res = await batch({ inserts: [{ tempId: 'a', values: item(2000) }] });
    const id = res.inserted[0]!.row.id;
    await batch({ updates: [{ id, version: 1, set: { name: 'First' } }] });
    const stale = await batch({ updates: [{ id, version: 1, set: { name: 'Stale' } }] });
    expect(stale.conflicts[0]!.current!.values.name).toBe('First');

    const audit = (await app.inject({ method: 'GET', url: `/api/sheets/items/rows/${id}/audit` })).json();
    expect(audit.entries[0]).toMatchObject({ op: 'update', column: 'name', oldValue: 'Item 2000', newValue: 'First' });
  });
});
