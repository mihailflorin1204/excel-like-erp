import { MemoryStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, itemsSheet, sheets } from '@erp/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../api/src/app.ts';
import { type BatchApi, SheetModel } from './sheet-model.ts';

/** Runs the model against the real API on an in-memory store, so client and server logic are tested together. */
async function setup() {
  const store = new MemoryStore();
  await store.init(sheets);
  const app = buildApp(store, { auth: false });
  const calls: BatchRequest[] = [];
  let gate: Promise<void> | null = null;
  const api: BatchApi & { hold(): () => void } = {
    async batch(sheet, body): Promise<BatchResponse> {
      calls.push(structuredClone(body));
      if (gate) await gate;
      const res = await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body });
      if (res.statusCode !== 200) throw new Error(res.body);
      return res.json();
    },
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
  const model = new SheetModel(itemsSheet, api, { debounceMs: 1 });
  return { model, calls, api, app };
}

const row = (sku: string) => [sku, `Name ${sku}`, 'pcs', 'Cat', '1,50', '3'];

describe('SheetModel', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('pastes 500 rows into an empty sheet in one batch and flags bad cells', async () => {
    const block = Array.from({ length: 500 }, (_, i) => row(`P-${i}`));
    block[5]![2] = 'crate';
    block[6]![4] = 'abc';
    block[7]![0] = 'p-1';
    ctx.model.paste(0, 0, block);

    let s = ctx.model.getSnapshot();
    expect(s.rows).toHaveLength(500);
    expect(s.errorCells).toBe(2); // unit + cost caught in the browser, before saving

    await ctx.model.flush();
    s = ctx.model.getSnapshot();
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]!.inserts).toHaveLength(498);
    expect(s.rows.filter((r) => r.id).length).toBe(497); // the duplicate SKU is rejected by the server
    expect(s.rows[7]!.cells.sku).toMatchObject({ state: 'error', raw: 'p-1' });
    expect(s.errorCells).toBe(3);
    expect(s.rows[0]!.values.onHand).toBe(0);
  });

  it('saves a fixed draft row after its error is corrected', async () => {
    ctx.model.paste(0, 0, [row('A'), ['A', 'Dup', 'pcs']]);
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows[1]!.cells.sku?.state).toBe('error');

    ctx.model.editCells([{ rowIndex: 1, column: 'sku', raw: 'B' }]);
    await ctx.model.flush();
    const r = ctx.model.getSnapshot().rows[1]!;
    expect(r.id).not.toBeNull();
    expect(r.values.sku).toBe('B');
  });

  it('keeps edits made while a save is in flight and sends them next', async () => {
    ctx.model.paste(0, 0, [row('A')]);
    await ctx.model.flush();

    const release = ctx.api.hold();
    ctx.model.editCells([{ rowIndex: 0, column: 'name', raw: 'First' }]);
    const saving = ctx.model.flush();
    ctx.model.editCells([{ rowIndex: 0, column: 'name', raw: 'Second' }]);
    expect(ctx.model.getSnapshot().rows[0]!.values.name).toBe('Second');
    release();
    await saving;
    await ctx.model.flush();

    expect(ctx.calls.map((c) => c.updates?.[0]?.set.name)).toEqual([undefined, 'First', 'Second']);
    const r = ctx.model.getSnapshot().rows[0]!;
    expect(r.values.name).toBe('Second');
    expect(r.version).toBe(3);
    expect(ctx.model.getSnapshot().unsaved).toBe(0);
  });

  it('undoes and redoes a paste as one step', async () => {
    ctx.model.paste(0, 0, [row('A')]);
    await ctx.model.flush();
    ctx.model.paste(1, 0, [['Changed', 'kg']]);
    await ctx.model.flush();

    ctx.model.undo();
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows[0]!.values).toMatchObject({ name: 'Name A', unit: 'pcs' });
    ctx.model.redo();
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows[0]!.values).toMatchObject({ name: 'Changed', unit: 'kg' });
  });

  it('undo removes rows a paste added (also on the server) and redo brings them back', async () => {
    ctx.model.paste(0, 0, [row('A')]);
    await ctx.model.flush();
    // Paste over the existing row and two new rows below it.
    ctx.model.paste(0, 0, [row('A2'), row('B'), row('C')]);
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows).toHaveLength(3);

    ctx.model.undo();
    await ctx.model.flush();
    let s = ctx.model.getSnapshot();
    expect(s.rows.map((r) => r.values.sku)).toEqual(['A']);
    expect(s.errorCells).toBe(0);
    expect(ctx.calls.at(-1)!.deletes).toHaveLength(2);

    ctx.model.redo();
    await ctx.model.flush();
    s = ctx.model.getSnapshot();
    expect(s.rows.map((r) => r.values.sku)).toEqual(['A2', 'B', 'C']);
    expect(s.rows.every((r) => r.id)).toBe(true);
    expect(s.unsaved).toBe(0);
  });

  it('treats a blank "Add a row" row filled by a paste as part of that paste', async () => {
    ctx.model.appendRow();
    ctx.model.paste(0, 0, [row('A'), ['B', 'Bad', 'crate']]);
    await ctx.model.flush();
    ctx.model.undo();
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows).toHaveLength(0);

    ctx.model.redo();
    const s = ctx.model.getSnapshot();
    expect(s.rows).toHaveLength(2);
    expect(s.rows[1]!.cells.unit).toMatchObject({ state: 'error', raw: 'crate' });
  });

  it('redoes a later fix on a row that a redone paste put back', async () => {
    ctx.model.paste(0, 0, [['B', 'Bad', 'crate']]);
    ctx.model.editCells([{ rowIndex: 0, column: 'unit', raw: 'kg' }]);
    ctx.model.undo();
    ctx.model.undo();
    ctx.model.redo();
    ctx.model.redo();
    await ctx.model.flush();
    const r = ctx.model.getSnapshot().rows[0]!;
    expect(r.values.unit).toBe('kg');
    expect(r.id).not.toBeNull();
  });

  it('refuses to clear a required cell on a saved row', async () => {
    ctx.model.paste(0, 0, [row('A')]);
    await ctx.model.flush();
    ctx.model.editCells([{ rowIndex: 0, column: 'name', raw: '' }]);
    const r = ctx.model.getSnapshot().rows[0]!;
    expect(r.cells.name).toMatchObject({ state: 'error', message: 'Required' });
    expect(r.values.name).toBe('Name A');
  });

  it('shows the latest value when the row changed elsewhere', async () => {
    ctx.model.paste(0, 0, [row('A')]);
    await ctx.model.flush();
    const id = ctx.model.getSnapshot().rows[0]!.id!;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/sheets/items/batch',
      payload: { updates: [{ id, version: 1, set: { name: 'Other user' } }] },
    });

    ctx.model.editCells([{ rowIndex: 0, column: 'name', raw: 'Mine' }]);
    await ctx.model.flush();
    const r = ctx.model.getSnapshot().rows[0]!;
    expect(r.values.name).toBe('Other user');
    expect(r.cells.name?.state).toBe('conflict');
    expect(r.version).toBe(2);
  });

  it('deletes rows and keeps the queue empty afterwards', async () => {
    ctx.model.paste(0, 0, [row('A'), row('B'), row('C')]);
    await ctx.model.flush();
    ctx.model.deleteRows([0, 2]);
    await ctx.model.flush();
    expect(ctx.model.getSnapshot().rows.map((r) => r.values.sku)).toEqual(['B']);
    expect(ctx.calls.at(-1)!.deletes).toHaveLength(2);
    expect(ctx.model.getSnapshot().unsaved).toBe(0);
  });

  it('keeps edits queued after a failed save and retries on demand', async () => {
    ctx.model.paste(0, 0, [row('A')]);
    await ctx.model.flush();
    const realBatch = ctx.api.batch;
    ctx.api.batch = async () => {
      throw new Error('Network down');
    };
    ctx.model.editCells([{ rowIndex: 0, column: 'name', raw: 'Offline edit' }]);
    await ctx.model.flush();
    expect(ctx.model.getSnapshot()).toMatchObject({ lastError: 'Network down', unsaved: 1 });

    ctx.api.batch = realBatch;
    await ctx.model.flush();
    expect(ctx.model.getSnapshot()).toMatchObject({ lastError: null, unsaved: 0 });
  });
});
