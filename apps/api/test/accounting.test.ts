import { randomUUID } from 'node:crypto';
import { MemoryStore, type SheetStore } from '@erp/db';
import { type BatchRequest, type BatchResponse, type CellValue, getSheet, type Row, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillJournal } from '../src/accounting/backfill.ts';
import { buildApp } from '../src/app.ts';
import { runBatch } from '../src/batch.ts';
import { hooks } from '../src/hooks.ts';
import { seedIfEmpty } from '../src/seed.ts';

let app: FastifyInstance;
let store: MemoryStore;

const batch = async (sheet: string, body: BatchRequest) =>
  (await app.inject({ method: 'POST', url: `/api/sheets/${sheet}/batch`, payload: body })).json() as BatchResponse;
const insert = (sheet: string, ...rows: Record<string, string | number | null>[]) =>
  batch(sheet, { inserts: rows.map((values, i) => ({ tempId: `t${i}`, values })) });
const rows = async (sheet: string, query = '') =>
  ((await app.inject({ method: 'GET', url: `/api/sheets/${sheet}/rows${query}` })).json() as { rows: Row[] }).rows;
const find = async (sheet: string, column: string, value: string) => (await rows(sheet)).find((r) => r.values[column] === value)!;
const action = (sheet: string, id: string, name: string) =>
  app.inject({ method: 'POST', url: `/api/sheets/${sheet}/rows/${id}/actions/${name}` });
const ok = async (sheet: string, id: string, name: string) => {
  const res = await action(sheet, id, name);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { rows: Row[] }).rows;
};
const errorsOf = (res: BatchResponse) => res.errors.map((e) => `${e.ref} ${e.column ?? ''}: ${e.message}`);
const po = (number: string) => find('purchaseOrders', 'number', number);
const bill = (billNo: string) => find('supplierBills', 'billNo', billNo);

/** Balance (debit − credit) per account code, from the chart of accounts. */
async function balances(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const a of await rows('accounts')) if (a.values.balance !== 0) out[String(a.values.code)] = a.values.balance as number;
  return out;
}

/** Lines of an entry as "code Dr/Cr amount", sorted. */
async function linesOf(entryId: CellValue | undefined): Promise<string[]> {
  const accounts = new Map((await rows('accounts')).map((a) => [a.id, a.values.code]));
  return (await rows('journalLines'))
    .filter((l) => l.values.entry === entryId)
    .map((l) => `${accounts.get(String(l.values.account))} ${l.values.debit ? `Dr ${l.values.debit}` : `Cr ${l.values.credit}`}`)
    .sort();
}

const stockValue = async () => (await rows('items')).reduce((s, i) => s + ((i.values.stockValue as number) ?? 0), 0);

async function trialBalance(query = '') {
  const res = await rows('trialBalance', query);
  return { rows: res, total: res.find((r) => r.id === 'total')!.values };
}

beforeEach(async () => {
  store = new MemoryStore();
  await store.init(sheets);
  app = buildApp(store, { auth: false });
  await insert('warehouses', { code: 'MAIN', name: 'Main' }, { code: 'BXL', name: 'Brussels' });
  await insert('items', { sku: 'A', name: 'Item A', unit: 'pcs', cost: 5 }, { sku: 'B', name: 'Item B', unit: 'pcs' });
  await insert('suppliers', { code: 'SUP', name: 'Supplier', paymentTermsDays: 30 }, { code: 'OTHER', name: 'Other' });
});

/** A sent PO-00001 for 10 A @ 4 and 5 B @ 20 (total 140), delivered to MAIN. */
async function sentPo() {
  await insert('purchaseOrders', { supplier: 'SUP', warehouse: 'MAIN' });
  await insert('purchaseOrderLines', { po: 'PO-00001', item: 'A', qty: 10, unitPrice: 4 }, { po: 'PO-00001', item: 'B', qty: 5, unitPrice: 20 });
  await ok('purchaseOrders', (await po('PO-00001')).id, 'send');
}

describe('chart of accounts', () => {
  it('is created on first start with the posting accounts', async () => {
    const accounts = await rows('accounts');
    expect(accounts.map((a) => a.values.code)).toEqual([
      '1000', '1100', '1200', '1300', '1500', '2000', '2100', '2200', '2300', '3000', '3100', '3900', '4000', '4900', '5000', '5100', '5200', '6000', '6100', '6200', '6300', '6400', '6900',
    ]);
    expect(accounts.find((a) => a.values.code === '1300')!.values).toMatchObject({ name: 'Inventory', type: 'Asset', role: 'inventory', balance: 0 });
    expect(accounts.find((a) => a.values.code === '1100')!.values.usedFor).toBeNull();
  });

  it("protects posting accounts: can't delete them or change their type, but can rename them", async () => {
    const inventory = await find('accounts', 'code', '1300');
    const res = await batch('accounts', {
      updates: [{ id: inventory.id, version: inventory.version, set: { type: 'Expense', name: 'Stock' } }],
    });
    expect(errorsOf(res)).toEqual([`${inventory.id} type: Automatic posting uses this account, so its type can't change`]);
    expect(res.updated[0]!.values).toMatchObject({ name: 'Stock', type: 'Asset' });
    const del = await batch('accounts', { deletes: [{ id: inventory.id, version: inventory.version + 1 }] });
    expect(errorsOf(del)).toEqual([`${inventory.id} : 1300 is used by automatic posting, so it can't be deleted`]);
  });

  it('adds missing posting accounts to an existing chart, taking over a matching code', async () => {
    const fresh = new MemoryStore();
    await fresh.init(sheets);
    const now = new Date().toISOString();
    const row = (values: Record<string, CellValue>): Row => ({ id: randomUUID(), version: 1, createdAt: now, updatedAt: now, values });
    await fresh.commit({
      sheet: sheets.find((s) => s.key === 'accounts')!,
      inserts: [row({ code: '1300', name: 'My stock', type: 'Asset' }), row({ code: '2000', name: 'Payroll', type: 'Liability', role: null })],
      updates: [],
      deletes: [],
      audit: [],
    });
    await backfillJournal(fresh);
    const accounts = await fresh.listWhere('accounts', 'code');
    // Only the posting accounts are added (no full chart), the existing 1300 is reused.
    expect(accounts).toHaveLength(10);
    expect(accounts.find((a) => a.values.code === '1300')!.values).toMatchObject({ name: 'My stock', role: 'inventory' });
    expect(accounts.find((a) => a.values.role === 'payable')!.values.code).toBe('2000');
    expect(accounts.find((a) => a.values.code === '2000')!.values.role).toBe('payable');
  });
});

describe('stock movements post to the ledger', () => {
  it('posts receipts, issues and adjustments; transfers post nothing; Inventory equals stock value', async () => {
    const res = await insert(
      'stockMovements',
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4, date: '2026-10-01' },
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 3, date: '2026-10-02' },
      { type: 'Adjustment', item: 'A', warehouse: 'MAIN', qty: -1, reason: 'Broken', date: '2026-10-03' },
      { type: 'Adjustment', item: 'A', warehouse: 'MAIN', qty: 2, unitCost: 4, reason: 'Found', date: '2026-10-03' },
      { type: 'Transfer', item: 'A', warehouse: 'MAIN', toWarehouse: 'BXL', qty: 2, date: '2026-10-04' },
    );
    expect(res.errors).toEqual([]);
    const [receipt, issue, minus, plus, transfer] = res.inserted.map((i) => i.row.values.journalEntry);
    expect(await linesOf(receipt)).toEqual(['1300 Dr 40', '3900 Cr 40']);
    expect(await linesOf(issue)).toEqual(['1300 Cr 12', '5000 Dr 12']);
    expect(await linesOf(minus)).toEqual(['1300 Cr 4', '5100 Dr 4']);
    expect(await linesOf(plus)).toEqual(['1300 Dr 8', '5100 Cr 8']);
    expect(transfer).toBeNull();

    const entries = await rows('journalEntries');
    expect(entries).toHaveLength(4);
    expect(entries[0]!.values).toMatchObject({
      number: 'JE-00001',
      date: '2026-10-01',
      origin: 'Stock movement',
      memo: 'Receipt A × 10',
      status: 'Posted',
      debit: 40,
      credit: 40,
      lineCount: 2,
    });
    expect(entries[1]!.values.memo).toBe('Issue A × 3');
    expect(await balances()).toEqual({ '1300': 32, '3900': -40, '5000': 12, '5100': -4 });
    expect(await stockValue()).toBe(32);
  });

  it('keeps Inventory equal to stock value to the cent, even with averages that need rounding', async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1, unitCost: 10 }, { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 2, unitCost: 0 });
      for (let i = 0; i < 3; i++) await insert('stockMovements', { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 1 });
      const inventory = (await rows('accounts')).find((a) => a.values.code === '1300')!.values.balance;
      expect(inventory).toBe(0);
      expect(await stockValue()).toBe(0);
    }
    await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 3, unitCost: 1 }, { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 1 });
    const inventory = (await rows('accounts')).find((a) => a.values.code === '1300')!.values.balance as number;
    expect(inventory).toBe(await stockValue());
  });

  it("won't reverse a receipt if that would empty the item but leave value behind", async () => {
    const res = await insert(
      'stockMovements',
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1, unitCost: 10 },
      { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1, unitCost: 0 },
      { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 1 },
    );
    const blocked = await action('stockMovements', res.inserted[1]!.row.id, 'reverse');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/blended cost/);
  });

  it('a movement that fails its checks posts no entry', async () => {
    const res = await insert('stockMovements', { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 3 });
    expect(res.errors).toHaveLength(1);
    expect(await rows('journalEntries')).toEqual([]);
  });

  it('Reverse posts the opposite entry and links the two', async () => {
    const res = await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    const [, reversal] = await ok('stockMovements', res.inserted[0]!.row.id, 'reverse');
    expect(await linesOf(reversal!.values.journalEntry)).toEqual(['1300 Cr 40', '3900 Dr 40']);
    const entries = await rows('journalEntries');
    expect(entries.map((e) => e.values.status)).toEqual(['Reversed', 'Reversal']);
    expect(entries[1]!.values.memo).toBe('Reversal of JE-00001: Receipt A × 10');
    expect(await balances()).toEqual({});
  });
});

describe('purchasing posts to the ledger', () => {
  it('a goods receipt posts Dr Inventory / Cr GRNI, and its reversal the opposite', async () => {
    await sentPo();
    const res = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 4, reference: 'DN-1' });
    expect(res.errors).toEqual([]);
    const [movement] = await rows('stockMovements');
    expect(await linesOf(movement!.values.journalEntry)).toEqual(['1300 Dr 16', '2100 Cr 16']);
    expect((await rows('journalEntries'))[0]!.values).toMatchObject({ origin: 'Goods receipt', memo: 'Receipt A × 4 · PO-00001 / DN-1' });

    await ok('goodsReceipts', res.inserted[0]!.row.id, 'reverse');
    expect(await balances()).toEqual({});
    expect((await rows('journalEntries')).map((e) => e.values.status)).toEqual(['Reversed', 'Reversal']);
  });

  it('a goods receipt rejected by its checks posts nothing', async () => {
    await sentPo();
    const res = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 4 }, { po: 'PO-00001', item: 'A', qty: 99 });
    expect(res.errors).toHaveLength(1);
    expect(await rows('journalEntries')).toHaveLength(1);
  });

  it("Receive all posts one entry per receipt; manual journal entries can't be used to reverse them", async () => {
    await sentPo();
    await ok('purchaseOrders', (await po('PO-00001')).id, 'receiveAll');
    const entries = await rows('journalEntries');
    expect(entries.map((e) => [e.values.origin, e.values.debit])).toEqual([
      ['Goods receipt', 40],
      ['Goods receipt', 100],
    ]);
    const res = await action('journalEntries', entries[0]!.id, 'reverse');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('JE-00001 was posted by a goods receipt. Reverse that goods receipt instead.');
    expect(await balances()).toEqual({ '1300': 140, '2100': -140 });
  });

  it('a bill starts as a draft and Post books Dr GRNI / Cr Accounts payable, then locks it', async () => {
    await sentPo();
    await ok('purchaseOrders', (await po('PO-00001')).id, 'receiveAll');
    const res = await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 140, date: '2026-10-10' });
    expect(res.inserted[0]!.row.values).toMatchObject({ state: 'Draft', status: 'Draft', paid: null, open: null });
    const draft = await bill('F-1');
    const edited = await batch('supplierBills', { updates: [{ id: draft.id, version: draft.version, set: { amount: 141 } }] });
    expect(edited.errors).toEqual([]);
    const fixed = await batch('supplierBills', { updates: [{ id: draft.id, version: draft.version + 1, set: { amount: 140 } }] });
    expect(fixed.errors).toEqual([]);

    const [posted] = await ok('supplierBills', draft.id, 'post');
    expect(posted!.values).toMatchObject({ state: 'Posted', status: 'Unpaid', paid: 0, open: 140, grniCleared: 140, variance: 0, dueDate: '2026-11-09' });
    expect(await linesOf(posted!.values.journalEntry)).toEqual(['2000 Cr 140', '2100 Dr 140']);
    expect((await rows('journalEntries')).at(-1)!.values).toMatchObject({ origin: 'Supplier bill', memo: 'Bill F-1 · PO-00001 · SUP', date: '2026-10-10' });
    expect(await balances()).toEqual({ '1300': 140, '2000': -140 });

    const locked = await batch('supplierBills', {
      updates: [{ id: posted!.id, version: posted!.version, set: { amount: 100, notes: 'Checked' } }],
      deletes: [],
    });
    expect(errorsOf(locked)).toEqual([`${posted!.id} amount: This bill is posted: only Notes can change. Use Reverse to cancel it.`]);
    expect(locked.updated[0]!.values.notes).toBe('Checked');
    const again = await action('supplierBills', posted!.id, 'post');
    expect(again.json().message).toBe('Bill F-1 is already posted');
  });

  it('a bill above what was received waits for the rest of the delivery, then books the excess as price variance', async () => {
    await sentPo();
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 }); // 40 received, B still outstanding
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 45 });
    const res = await action('supplierBills', (await bill('F-1')).id, 'post');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      'Bill F-1 is €5.00 more than what was received on PO-00001 and not yet billed (€40.00). Receive the rest first, or Close the PO if nothing more is coming.',
    );

    await ok('purchaseOrders', (await po('PO-00001')).id, 'close');
    const [posted] = await ok('supplierBills', (await bill('F-1')).id, 'post');
    expect(posted!.values).toMatchObject({ grniCleared: 40, variance: 5 });
    expect(await linesOf(posted!.values.journalEntry)).toEqual(['2000 Cr 45', '2100 Dr 40', '5200 Dr 5']);
    expect(await balances()).toEqual({ '1300': 40, '2000': -45, '5200': 5 });
  });

  it('bills below the received value clear only their amount; later bills clear the rest', async () => {
    await sentPo();
    await ok('purchaseOrders', (await po('PO-00001')).id, 'receiveAll');
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 100 }, { billNo: 'F-2', po: 'PO-00001', amount: 50 });
    await ok('supplierBills', (await bill('F-1')).id, 'post');
    expect(await balances()).toMatchObject({ '2100': -40 });
    const [second] = await ok('supplierBills', (await bill('F-2')).id, 'post');
    expect(second!.values).toMatchObject({ grniCleared: 40, variance: 10 });
    expect(await balances()).toEqual({ '1300': 140, '2000': -150, '5200': 10 });
  });

  it('Reverse cancels a posted bill without payments; its number can be entered again', async () => {
    await sentPo();
    await ok('purchaseOrders', (await po('PO-00001')).id, 'receiveAll');
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 140 });
    const draft = await bill('F-1');
    const notPosted = await action('supplierBills', draft.id, 'reverse');
    expect(notPosted.json().message).toBe('Only a posted bill can be reversed (bill F-1 is draft)');
    await ok('supplierBills', draft.id, 'post');
    const [reversed] = await ok('supplierBills', draft.id, 'reverse');
    expect(reversed!.values).toMatchObject({ state: 'Reversed', status: 'Reversed', open: null });
    expect(await balances()).toEqual({ '1300': 140, '2100': -140 });
    expect((await po('PO-00001')).values.billed).toBe(0);

    const again = await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 140 });
    expect(again.errors).toEqual([]);
    const [reposted] = await ok('supplierBills', again.inserted[0]!.row.id, 'post');
    expect(reposted!.values.grniCleared).toBe(140);
  });
});

describe('supplier payments', () => {
  async function postedBill(amount = 140) {
    await sentPo();
    await ok('purchaseOrders', (await po('PO-00001')).id, 'receiveAll');
    await ok('purchaseOrders', (await po('PO-00001')).id, 'close');
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount, date: '2026-10-10' });
    return (await ok('supplierBills', (await bill('F-1')).id, 'post'))[0]!;
  }

  it('pays a posted bill: Dr Accounts payable / Cr Bank, and the bill shows what is open', async () => {
    await postedBill();
    const res = await insert(
      'supplierPayments',
      { supplier: 'SUP', billNo: 'f-1', amount: 100, reference: 'Transfer 1' },
      { supplier: 'SUP', billNo: 'F-1', amount: 50 },
      { supplier: 'SUP', billNo: 'F-1', amount: 0 },
      { supplier: 'OTHER', billNo: 'F-1', amount: 1 },
    );
    expect(errorsOf(res)).toEqual(['t1 amount: Only €40.00 is open on bill F-1', 't2 amount: Must be more than 0', 't3 billNo: No bill F-1 from OTHER']);
    expect(res.inserted[0]!.row.values).toMatchObject({ amount: 100, status: 'Posted' });
    expect(await linesOf(res.inserted[0]!.row.values.journalEntry)).toEqual(['1000 Cr 100', '2000 Dr 100']);
    expect((await rows('journalEntries')).at(-1)!.values).toMatchObject({ origin: 'Supplier payment', memo: 'Payment bill F-1 · SUP · Transfer 1' });
    expect((await bill('F-1')).values).toMatchObject({ paid: 100, open: 40 });
    expect(['Part paid', 'Overdue']).toContain((await bill('F-1')).values.status);

    const [paid] = await ok('supplierBills', (await bill('F-1')).id, 'payInFull');
    expect(paid!.values).toMatchObject({ paid: 140, open: 0, status: 'Paid' });
    expect(await balances()).toEqual({ '1000': -140, '1300': 140 });
    const twice = await action('supplierBills', paid!.id, 'payInFull');
    expect(twice.json().message).toBe('Bill F-1 is already paid');
  });

  it("can't pay a draft bill", async () => {
    await sentPo();
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 10 });
    const res = await insert('supplierPayments', { supplier: 'SUP', billNo: 'F-1', amount: 10 });
    expect(errorsOf(res)).toEqual(['t0 billNo: Bill F-1 is still a draft. Post it first.']);
    const pay = await action('supplierBills', (await bill('F-1')).id, 'payInFull');
    expect(pay.json().message).toBe('Bill F-1 must be posted before it can be paid');
  });

  it('Reverse cancels a payment and opens the bill again; a bill with payments must have them reversed first', async () => {
    const posted = await postedBill();
    const res = await insert('supplierPayments', { supplier: 'SUP', billNo: 'F-1', amount: 140 });
    const blocked = await action('supplierBills', posted.id, 'reverse');
    expect(blocked.json().message).toBe('Bill F-1 has payments of €140.00. Reverse them in Supplier payments first.');

    const [original, reversal] = await ok('supplierPayments', res.inserted[0]!.row.id, 'reverse');
    expect(original!.values.status).toBe('Reversed');
    expect(reversal!.values).toMatchObject({ amount: -140, status: 'Reversal' });
    expect(await linesOf(reversal!.values.journalEntry)).toEqual(['1000 Dr 140', '2000 Cr 140']);
    expect((await bill('F-1')).values).toMatchObject({ paid: 0, open: 140 });
    const twice = await action('supplierPayments', res.inserted[0]!.row.id, 'reverse');
    expect(twice.json().message).toBe('This payment is already reversed');

    await ok('supplierBills', posted.id, 'reverse');
    expect(await balances()).toEqual({ '1300': 140, '2100': -140 });
  });

  it('payments are a ledger: saved rows are locked', async () => {
    await postedBill();
    const res = await insert('supplierPayments', { supplier: 'SUP', billNo: 'F-1', amount: 10 });
    const row = res.inserted[0]!.row;
    const edit = await batch('supplierPayments', { updates: [{ id: row.id, version: row.version, set: { amount: 20 } }] });
    expect(edit.errors[0]!.message).toMatch(/Reverse/);
  });
});

describe('manual journal entries', () => {
  async function draftEntry() {
    const res = await insert('journalEntries', { date: '2026-10-05', memo: 'Owner puts money in' });
    return res.inserted[0]!.row;
  }

  it('are numbered, start as drafts, and post once balanced', async () => {
    const entry = await draftEntry();
    expect(entry.values).toMatchObject({ number: 'JE-00001', state: 'Draft', origin: 'Manual', status: 'Draft' });

    const lines = await insert(
      'journalLines',
      { entry: 'JE-00001', account: '1000', debit: 1000 },
      { entry: 'JE-00001', account: '3000', credit: 900 },
      { entry: 'JE-00001', account: '3000', debit: 1, credit: 1 },
      { entry: 'JE-00001', account: '3000' },
      { entry: 'JE-00001', account: '1300', debit: 5 },
      { entry: 'JE-00001', account: '2000', credit: 5 },
    );
    expect(errorsOf(lines)).toEqual([
      't2 credit: Enter either a debit or a credit',
      't3 debit: Enter either a debit or a credit',
      't4 account: Inventory is a control account: change stock in Stock movements instead',
      't5 account: Accounts payable is a control account: use Supplier bills and Supplier payments instead',
    ]);
    expect((await rows('journalEntries'))[0]!.values.status).toBe('Draft · unbalanced');

    const unbalanced = await action('journalEntries', entry.id, 'post');
    expect(unbalanced.json().message).toBe("JE-00001 doesn't balance: debits €1,000.00, credits €900.00 (difference €100.00)");

    const second = lines.inserted[1]!.row;
    await batch('journalLines', { updates: [{ id: second.id, version: second.version, set: { credit: 1000 } }] });
    const [posted] = await ok('journalEntries', entry.id, 'post');
    expect(posted!.values).toMatchObject({ state: 'Posted', status: 'Posted', debit: 1000, credit: 1000, lineCount: 2 });
    expect(await balances()).toEqual({ '1000': 1000, '3000': -1000 });

    // Locked: no edits, no new lines, no deletes.
    const first = (await rows('journalLines'))[0]!;
    const edit = await batch('journalLines', { updates: [{ id: first.id, version: first.version, set: { debit: 1 } }], deletes: [] });
    expect(edit.errors[0]!.message).toBe('The entry is posted, so its lines are locked.');
    const add = await insert('journalLines', { entry: 'JE-00001', account: '1100', debit: 1 });
    expect(errorsOf(add)).toEqual(["t0 entry: JE-00001 is posted, so lines can't be added. Start a new entry."]);
    const header = (await rows('journalEntries'))[0]!;
    const del = await batch('journalEntries', { deletes: [{ id: header.id, version: header.version }] });
    expect(del.errors[0]!.message).toBe('This entry is posted and locked. Use Reverse to cancel it.');
  });

  it("can't post with fewer than two lines; a line edit and Post can't both win", async () => {
    const entry = await draftEntry();
    expect((await action('journalEntries', entry.id, 'post')).json().message).toBe('JE-00001 needs at least two lines. Add them in Journal lines.');
    await insert('journalLines', { entry: 'JE-00001', account: '1000', debit: 10 }, { entry: 'JE-00001', account: '3000', credit: 10 });
    // Adding lines bumped the entry's version.
    expect((await rows('journalEntries'))[0]!.version).toBe(2);
  });

  it('Reverse posts the opposite of a manual entry, once', async () => {
    const entry = await draftEntry();
    await insert('journalLines', { entry: 'JE-00001', account: '1000', debit: 10 }, { entry: 'JE-00001', account: '3000', credit: 10 });
    const draft = await action('journalEntries', entry.id, 'reverse');
    expect(draft.json().message).toBe('JE-00001 is a draft: change or delete it instead');
    await ok('journalEntries', entry.id, 'post');
    const [original, reversal] = await ok('journalEntries', entry.id, 'reverse');
    expect(original!.values.status).toBe('Reversed');
    expect(reversal!.values).toMatchObject({ number: 'JE-00002', status: 'Reversal', origin: 'Manual', memo: 'Reversal of JE-00001: Owner puts money in' });
    expect(await linesOf(reversal!.id)).toEqual(['1000 Cr 10', '3000 Dr 10']);
    expect(await balances()).toEqual({});
    expect((await action('journalEntries', entry.id, 'reverse')).json().message).toBe('JE-00001 is already reversed');
    expect((await action('journalEntries', reversal!.id, 'reverse')).json().message).toBe('JE-00002 is a reversal; post a new entry instead');
  });

  it('an account with posted lines cannot be deleted', async () => {
    const entry = await draftEntry();
    await insert('journalLines', { entry: 'JE-00001', account: '1100', debit: 10 }, { entry: 'JE-00001', account: '3000', credit: 10 });
    await ok('journalEntries', entry.id, 'post');
    const cash = await find('accounts', 'code', '1100');
    const res = await batch('accounts', { deletes: [{ id: cash.id, version: cash.version }] });
    expect(res.errors[0]!.message).toBe("Used in Journal lines, so it can't be deleted");
  });
});

describe('trial balance', () => {
  it('balances after the whole purchase-to-payment flow, with an optional date range', async () => {
    await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4, date: '2026-09-30' });
    await sentPo();
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10, date: '2026-10-02' }, { po: 'PO-00001', item: 'B', qty: 5, date: '2026-10-02' });
    await insert('stockMovements', { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 5, date: '2026-10-03' });
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 150, date: '2026-10-04' });
    await ok('supplierBills', (await bill('F-1')).id, 'post');
    await insert('supplierPayments', { supplier: 'SUP', billNo: 'F-1', amount: 150, date: '2026-10-05' });

    const all = await trialBalance();
    expect(all.total).toMatchObject({ debit: 500, credit: 500, closing: 0, check: 'Balanced' });
    const closing = Object.fromEntries(all.rows.filter((r) => r.id !== 'total').map((r) => [r.values.name, r.values.closing]));
    expect(closing).toEqual({
      Bank: -150,
      Inventory: 160,
      'Accounts payable': 0,
      'Goods received not invoiced': 0,
      'Opening balances': -40,
      'Cost of goods sold': 20,
      'Purchase price variance': 10,
    });
    expect(await stockValue()).toBe(160);

    const october = await trialBalance('?from=2026-10-01&to=2026-10-03');
    const inv = october.rows.find((r) => r.values.name === 'Inventory')!.values;
    expect(inv).toMatchObject({ opening: 40, debit: 140, credit: 20, closing: 160 });
    expect(october.rows.some((r) => r.values.name === 'Bank')).toBe(false);
    expect(october.total).toMatchObject({ opening: 0, debit: 160, credit: 160, check: 'Balanced' });

    const bad = await app.inject({ method: 'GET', url: '/api/sheets/trialBalance/rows?from=yesterday' });
    expect(bad.statusCode).toBe(400);
  });

  it('only counts posted entries', async () => {
    await insert('journalEntries', { memo: 'draft' });
    await insert('journalLines', { entry: 'JE-00001', account: '1000', debit: 10 });
    const tb = await trialBalance();
    expect(tb.rows).toHaveLength(1);
    expect(tb.total).toMatchObject({ debit: 0, credit: 0, check: 'Balanced' });
  });
});

describe('backfill of data saved before accounting', () => {
  /** Strips everything Phase 4 added, as if the rows had been saved by Phase 3. */
  function makeLegacy(s: MemoryStore) {
    const tables = (s as unknown as { tables: Map<string, Map<string, Row>> }).tables;
    const added: [string, string[]][] = [
      ['stockMovements', ['journalEntry']],
      ['supplierBills', ['state', 'journalEntry', 'grniCleared', 'variance', 'reversalEntry']],
    ];
    for (const [sheet, keys] of added) for (const r of tables.get(sheet)!.values()) for (const k of keys) delete r.values[k];
    tables.set('journalEntries', new Map());
    tables.set('journalLines', new Map());
  }

  it('posts earlier movements and bills once; a bill that cannot be posted becomes a draft', async () => {
    await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    const issue = await insert('stockMovements', { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 2 });
    await ok('stockMovements', issue.inserted[0]!.row.id, 'reverse');
    await insert('stockMovements', { type: 'Transfer', item: 'A', warehouse: 'MAIN', toWarehouse: 'BXL', qty: 1 });
    await sentPo();
    await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 10 });
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 40 }, { billNo: 'F-2', po: 'PO-00001', amount: 999 });
    expect(await balances()).toEqual({ '1300': 80, '2100': -40, '3900': -40 });
    makeLegacy(store);
    expect(await balances()).toEqual({});

    const summary = await backfillJournal(store);
    expect(summary).toBe("4 journal entries for 5 earlier stock movements; 1 earlier bills posted; left as draft (can't be posted yet): F-2");
    expect(await balances()).toEqual({ '1300': 80, '2000': -40, '3900': -40 });
    const entries = await rows('journalEntries');
    expect(entries.map((e) => e.values.status)).toEqual(['Posted', 'Reversed', 'Reversal', 'Posted', 'Posted']);
    expect((await bill('F-1')).values).toMatchObject({ state: 'Posted', status: expect.any(String) });
    expect((await bill('F-2')).values).toMatchObject({ state: 'Draft', status: 'Draft' });
    expect((await trialBalance()).total.check).toBe('Balanced');

    expect(await backfillJournal(store)).toBe('');
    expect(await rows('journalEntries')).toHaveLength(5);
  });

  it('reversing an earlier movement before the backfill ran posts both entries on the spot', async () => {
    const receipt = await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    await insert('stockMovements', { type: 'Receipt', item: 'B', warehouse: 'MAIN', qty: 1, unitCost: 7 });
    makeLegacy(store);
    const [original, reversal] = await ok('stockMovements', receipt.inserted[0]!.row.id, 'reverse');
    expect(await linesOf(original!.values.journalEntry)).toEqual(['1300 Dr 40', '3900 Cr 40']);
    expect(await linesOf(reversal!.values.journalEntry)).toEqual(['1300 Cr 40', '3900 Dr 40']);
    expect((await rows('journalEntries')).map((e) => e.values.status)).toEqual(['Reversed', 'Reversal']);

    expect(await backfillJournal(store)).toBe('1 journal entries for 1 earlier stock movements');
    expect(await balances()).toEqual({ '1300': 7, '3900': -7 });
    expect(await stockValue()).toBe(7);
  });

  it('links a reversal to an original that an earlier run already posted', async () => {
    const receipt = await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    makeLegacy(store);
    await backfillJournal(store);
    // Simulate a reversal saved by Phase 3 code after the first run (no journal link yet).
    const [, reversal] = await ok('stockMovements', receipt.inserted[0]!.row.id, 'reverse');
    const tables = (store as unknown as { tables: Map<string, Map<string, Row>> }).tables;
    const reversalEntry = reversal!.values.journalEntry as string;
    delete tables.get('stockMovements')!.get(reversal!.id)!.values.journalEntry;
    tables.get('journalEntries')!.delete(reversalEntry);
    for (const [id, l] of tables.get('journalLines')!) if (l.values.entry === reversalEntry) tables.get('journalLines')!.delete(id);
    const original = [...tables.get('journalEntries')!.values()][0]!;
    original.values.reversedBy = null;

    await backfillJournal(store);
    expect((await rows('journalEntries')).map((e) => e.values.status)).toEqual(['Reversed', 'Reversal']);
    expect(await balances()).toEqual({});
  });
});

describe('demo data', () => {
  it('seeds a balanced ledger with a posted, part-paid bill', async () => {
    const fresh = new MemoryStore();
    await fresh.init(sheets);
    await seedIfEmpty(fresh);
    store = fresh;
    app = buildApp(fresh, { auth: false });
    const b = await bill('F-2026-1187');
    expect(b.values).toMatchObject({ state: 'Posted', paid: 500, open: 272 });
    expect((await trialBalance()).total.check).toBe('Balanced');
    const inventory = (await rows('accounts')).find((a) => a.values.code === '1300')!.values.balance as number;
    expect(Math.abs(inventory - (await stockValue()))).toBeLessThan(0.01);
  });
});

/** A store that runs `meanwhile` once, just before the n-th read of `sheet`: another request landing mid-save. */
function interrupted(base: MemoryStore, sheet: string, n: number, meanwhile: () => Promise<unknown>): SheetStore {
  let reads = 0;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'getRows') {
        return async (s: string, ids: readonly string[]) => {
          if (s === sheet && ++reads === n) await meanwhile();
          return target.getRows(s, ids);
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('saves that land at the same moment', () => {
  it('two issues of the last unit at the same moment: one is saved, the other sees there is no stock left', async () => {
    // Zero cost, so no journal entries: the two saves can't clash on an entry number, only the stock guard stops them.
    await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1, unitCost: 0 });
    const issue = { updates: [], deletes: [], inserts: [{ tempId: 'a', values: { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 1 } }] };
    // The other issue saves after this one has read the stock (the 2nd read of items comes right after it).
    const racing = interrupted(store, 'items', 2, () => runBatch(store, getSheet('stockMovements')!, issue, 'other'));
    const res = (await buildApp(racing, { auth: false }).inject({ method: 'POST', url: '/api/sheets/stockMovements/batch', payload: issue })).json() as BatchResponse;
    expect(res.inserted).toEqual([]);
    expect(res.errors.map((e) => e.message)).toEqual(['Only 0 in stock in MAIN']);
    expect((await rows('items')).find((i) => i.values.sku === 'A')!.values.onHand).toBe(0);
  });

  it('a reversal and an issue of the same stock at the same moment can not both pass', async () => {
    const receipt = await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 1, unitCost: 4 });
    const racing = interrupted(store, 'warehouses', 1, () =>
      runBatch(store, getSheet('stockMovements')!, { updates: [], deletes: [], inserts: [{ tempId: 'x', values: { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 1 } }] }, 'other'),
    );
    const res = await buildApp(racing, { auth: false }).inject({ method: 'POST', url: `/api/sheets/stockMovements/rows/${receipt.inserted[0]!.row.id}/actions/reverse` });
    expect(res.statusCode).toBe(409);
    expect((await rows('items')).find((i) => i.values.sku === 'A')!.values.onHand).toBe(0);
    expect(await balances()).toEqual({ '3900': -4, '5000': 4 });
  });

  it('a line edit racing Post is rejected, so a posted entry can never become unbalanced', async () => {
    const entry = (await insert('journalEntries', { memo: 'x' })).inserted[0]!.row;
    const lines = await insert('journalLines', { entry: 'JE-00001', account: '1000', debit: 10 }, { entry: 'JE-00001', account: '3000', credit: 10 });
    const line = lines.inserted[0]!.row;
    const racing = interrupted(store, 'journalEntries', 2, () => hooks.journalEntries!.actions!.post!(store, entry.id, 'other'));
    const res = await runBatch(racing, getSheet('journalLines')!, { inserts: [], deletes: [], updates: [{ id: line.id, version: line.version, set: { debit: 999 } }] }, 'u');
    expect(res.updated[0]!.values.debit).toBe(10);
    expect((await trialBalance()).total.check).toBe('Balanced');
    expect((await rows('journalEntries'))[0]!.values).toMatchObject({ state: 'Posted', debit: 10, credit: 10 });
  });

  it('two saves that post at the same moment both succeed, with different entry numbers', async () => {
    await insert('stockMovements', { type: 'Receipt', item: 'A', warehouse: 'MAIN', qty: 10, unitCost: 4 });
    const issue = { inserts: [{ tempId: 'a', values: { type: 'Issue', item: 'A', warehouse: 'MAIN', qty: 1 } }] };
    const res = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/sheets/stockMovements/batch', payload: issue })));
    expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await rows('journalEntries')).map((e) => e.values.number)).toEqual(['JE-00001', 'JE-00002', 'JE-00003']);
  });

  it('a goods receipt reversed while a bill on the same PO is being posted makes the bill post fail', async () => {
    await sentPo();
    const gr = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 5 });
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 20 });
    const draft = await bill('F-1');
    const racing = buildApp(interrupted(store, 'suppliers', 1, () => hooks.goodsReceipts!.actions!.reverse!(store, gr.inserted[0]!.row.id, 'other')), { auth: false });
    const res = await racing.inject({ method: 'POST', url: `/api/sheets/supplierBills/rows/${draft.id}/actions/post` });
    // Nothing of the first try is saved; the retry sees the receipt gone and refuses.
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/^Bill F-1 is €20.00 more than what was received/);
    expect(await balances()).toEqual({});
  });

  it("won't reverse a goods receipt that is already billed", async () => {
    await sentPo();
    const gr = await insert('goodsReceipts', { po: 'PO-00001', item: 'A', qty: 5 });
    await insert('supplierBills', { billNo: 'F-1', po: 'PO-00001', amount: 20 });
    await ok('supplierBills', (await bill('F-1')).id, 'post');
    const res = await action('goodsReceipts', gr.inserted[0]!.row.id, 'reverse');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('This receipt is already billed (F-1). Reverse the bill first, or post a stock adjustment instead.');
    await ok('supplierBills', (await bill('F-1')).id, 'reverse');
    await ok('goodsReceipts', gr.inserted[0]!.row.id, 'reverse');
    expect(await balances()).toEqual({});
  });
});
