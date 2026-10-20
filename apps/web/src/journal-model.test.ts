import { MemoryStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, journalEntriesSheet, journalLinesSheet, sheets } from '@erp/schema';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../api/src/app.ts';
import { type BatchApi, SheetModel } from './sheet-model.ts';

/** The grid model against the real API on an in-memory store, for the accounting sheets. */
async function setup() {
  const store = new MemoryStore();
  await store.init(sheets);
  const app = buildApp(store, { auth: false });
  const calls: BatchRequest[] = [];
  const api: BatchApi = {
    async batch(sheet, body): Promise<BatchResponse> {
      calls.push(structuredClone(body));
      const res = await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body });
      if (res.statusCode !== 200) throw new Error(res.body);
      return res.json();
    },
  };
  return { app, calls, api };
}

describe('accounting sheets in the grid', () => {
  it('never saves a blank "Add a row" row, even on a sheet with no required columns', async () => {
    const { api, calls } = await setup();
    const entries = new SheetModel(journalEntriesSheet, api, { debounceMs: 1 });
    entries.appendRow();
    await entries.flush();
    expect(calls).toHaveLength(0);
    expect(entries.missingRequired(entries.getSnapshot().rows[0]!)).toEqual([]);
    expect(entries.isComplete(entries.getSnapshot().rows[0]!)).toBe(false);

    entries.editCells([{ rowIndex: 0, column: 'memo', raw: 'Owner puts money in' }]);
    await entries.flush();
    expect(calls).toHaveLength(1);
    expect(entries.getSnapshot().rows[0]!.values).toMatchObject({ number: 'JE-00001', status: 'Draft' });
  });

  it('waits for a debit or a credit before saving a new journal line', async () => {
    const { api, calls } = await setup();
    const entries = new SheetModel(journalEntriesSheet, api, { debounceMs: 1 });
    entries.editCells([{ rowIndex: 0, column: 'memo', raw: 'x' }]);
    await entries.flush();
    const lines = new SheetModel(journalLinesSheet, api, { debounceMs: 1 });
    // Entry and account typed as ids would need lookups; the API also accepts the display values.
    lines.editCells([
      { rowIndex: 0, column: 'entry', raw: 'JE-00001' },
      { rowIndex: 0, column: 'account', raw: '1000' },
    ]);
    await lines.flush();
    expect(calls).toHaveLength(1); // only the entry header
    expect(lines.missingRequired(lines.getSnapshot().rows[0]!)).toEqual(['Debit or Credit']);

    lines.editCells([{ rowIndex: 0, column: 'credit', raw: '25' }]);
    await lines.flush();
    expect(calls).toHaveLength(2);
    expect(lines.getSnapshot().rows[0]!).toMatchObject({ draft: false, values: { credit: 25, debit: null } });
  });
});
