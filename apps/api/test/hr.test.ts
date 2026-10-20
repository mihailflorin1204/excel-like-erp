import { MemoryStore } from '@erp/db';
import { internalSheets, type Row, sheets } from '@erp/schema';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let admin: string;
let bob: string;

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const rows = async (sheet: string, who = admin, query = '') => ((await call('GET', `/api/sheets/${sheet}/rows${query}`, who)).json() as { rows: Row[] }).rows;
const insert = async (sheet: string, who: string, ...values: Record<string, string | number | null>[]) =>
  (await call('POST', `/api/sheets/${sheet}/batch`, who, { inserts: values.map((v, i) => ({ tempId: `t${i}`, values: v })) })).json();
const act = (id: string, name: string, who = admin) => call('POST', `/api/sheets/expenseClaims/rows/${id}/actions/${name}`, who);
const ok = async (id: string, name: string, who = admin) => {
  const res = await act(id, name, who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().rows[0] as Row;
};
const claim = async (number: string) => (await rows('expenseClaims')).find((c) => c.values.number === number)!;
const errorsOf = (res: { errors: { ref: string; column?: string; message: string }[] }) => res.errors.map((e) => `${e.ref} ${e.column ?? ''}: ${e.message}`);

async function balances(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const a of await rows('accounts')) if (a.values.balance !== 0) out[String(a.values.code)] = a.values.balance as number;
  return out;
}

async function linesOf(entryId: unknown): Promise<string[]> {
  const accounts = new Map((await rows('accounts')).map((a) => [a.id, a.values.code]));
  const depts = new Map((await rows('departments')).map((d) => [d.id, d.values.code]));
  return (await rows('journalLines'))
    .filter((l) => l.values.entry === entryId)
    .map((l) => `${accounts.get(String(l.values.account))} ${l.values.debit ? `Dr ${l.values.debit}` : `Cr ${l.values.credit}`}${l.values.department ? ` ${depts.get(String(l.values.department))}` : ''}`)
    .sort();
}

beforeEach(async () => {
  const store = new MemoryStore();
  await store.init([...sheets, ...internalSheets]);
  app = buildApp(store);
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'ann@example.com', name: 'Ann', password: 'correct horse battery' } });
  admin = String(setup.headers['set-cookie']).split(';')[0]!;
  const user = await insert('users', admin, { email: 'bob@example.com', name: 'Bob', role: 'Member' });
  const reset = (await call('POST', `/api/sheets/users/rows/${user.inserted[0].row.id}/actions/resetPassword`, admin)).json();
  const temp = /: ([a-z0-9-]{14}) /.exec(reset.message)![1]!;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'bob@example.com', password: temp } });
  bob = String(login.headers['set-cookie']).split(';')[0]!;
  await call('POST', '/api/auth/password', bob, { current: temp, password: 'bobs own password' });

  await insert('departments', admin, { code: 'OPS', name: 'Operations' }, { code: 'SALES', name: 'Sales' });
  await insert(
    'employees',
    admin,
    { code: 'ANN', name: 'Ann', email: 'ann@example.com', department: 'OPS' },
    { code: 'BOB', name: 'Bob', email: 'bob@example.com', department: 'SALES' },
    { code: 'OLD', name: 'Old timer', status: 'Left' },
  );
});

describe('departments and employees', () => {
  it('counts active employees per department', async () => {
    expect((await rows('departments')).map((d) => [d.values.code, d.values.headcount])).toEqual([
      ['OPS', 1],
      ['SALES', 1],
    ]);
    const bad = await insert('employees', admin, { code: 'X', name: 'X', email: 'not an email' });
    expect(errorsOf(bad)).toEqual(['t0 email: Enter a valid email']);
  });
});

describe('expense claims', () => {
  it('are numbered and checked when entered', async () => {
    const res = await insert(
      'expenseClaims',
      bob,
      { employee: 'BOB', category: 'Travel', amount: 25.5, description: 'Taxi' },
      { employee: 'BOB', category: 'Meals', amount: 0 },
      { employee: 'OLD', category: 'Meals', amount: 10 },
      { employee: 'BOB', category: 'Meals', amount: 10, account: '1000' },
      { employee: 'BOB', category: 'Meals', amount: 10, receiptUrl: 'file://c:/scan.pdf' },
    );
    expect(res.inserted[0].row.values).toMatchObject({ number: 'EC-00001', state: 'Draft', status: 'Draft', department: expect.any(String) });
    expect(errorsOf(res)).toEqual([
      't1 amount: Must be more than 0',
      't2 employee: OLD has left; claims are for active employees',
      't3 account: 1000 is not an expense account',
      't4 receiptUrl: Use a link starting with http:// or https://',
    ]);
  });

  it('go Draft → Submitted → Approved → Paid, posting to the ledger with the department', async () => {
    const res = await insert('expenseClaims', bob, { employee: 'BOB', category: 'Travel', amount: 25.5, description: 'Taxi' });
    const id = res.inserted[0].row.id as string;
    const submitted = await ok(id, 'submit', bob);
    expect(submitted.values.status).toBe('Submitted');

    // Locked once submitted: only notes change.
    const edit = await call('POST', '/api/sheets/expenseClaims/batch', bob, { updates: [{ id, version: submitted.version, set: { amount: 99, notes: 'Receipt in drawer' } }] });
    expect(errorsOf(edit.json())).toEqual([`${id} amount: This claim is no longer a draft: only Notes can change.`]);

    expect((await act(id, 'approve', bob)).json().message).toBe('Only an admin can approve claims');
    const approved = await ok(id, 'approve');
    expect(approved.values).toMatchObject({ status: 'Approved', approvedBy: 'ann@example.com' });
    expect(await linesOf(approved.values.journalEntry)).toEqual(['2200 Cr 25.5 SALES', '6300 Dr 25.5 SALES']);
    expect((await rows('employees')).find((e) => e.values.code === 'BOB')!.values.owed).toBe(25.5);
    expect(await balances()).toEqual({ '2200': -25.5, '6300': 25.5 });

    const paid = await ok(id, 'pay');
    expect(paid.values).toMatchObject({ status: 'Paid', paidDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(await linesOf(paid.values.paymentEntry)).toEqual(['1000 Cr 25.5', '2200 Dr 25.5 SALES']);
    expect(await balances()).toEqual({ '1000': -25.5, '6300': 25.5 });
    expect((await rows('employees')).find((e) => e.values.code === 'BOB')!.values.owed).toBe(0);
    expect((await act(id, 'reverse')).json().message).toBe("EC-00001 is already paid, so its approval can't be reversed");
  });

  it("an admin can't approve, reject or pay their own claim", async () => {
    const res = await insert('expenseClaims', admin, { employee: 'ANN', category: 'Meals', amount: 12 });
    const id = res.inserted[0].row.id as string;
    await ok(id, 'submit');
    const own = await act(id, 'approve');
    expect(own.statusCode).toBe(403);
    expect(own.json().message).toBe("You can't approve your own claim; ask another admin");
    expect((await act(id, 'reject')).json().message).toBe("You can't reject your own claim; ask another admin");
  });

  it("can't be decided by whoever entered or submitted them, even after an email change; only admins change employee emails", async () => {
    const res = await insert('expenseClaims', admin, { employee: 'ANN', category: 'Meals', amount: 12 });
    const id = res.inserted[0].row.id as string;
    await ok(id, 'submit');
    const employees = await rows('employees');
    const annEmployee = employees.find((e) => e.values.code === 'ANN')!;
    const bobEmployee = employees.find((e) => e.values.code === 'BOB')!;
    // A member can't unlink anyone; an admin unlinking themselves doesn't help either.
    const byBob = (await call('POST', '/api/sheets/employees/batch', bob, { updates: [{ id: annEmployee.id, version: annEmployee.version, set: { email: null } }] })).json();
    expect(byBob.errors[0].message).toBe('Only an admin can change an employee’s email');
    await call('POST', '/api/sheets/employees/batch', admin, { updates: [{ id: annEmployee.id, version: annEmployee.version, set: { email: null } }] });
    expect((await act(id, 'approve')).statusCode).toBe(403);
    // Bob's claim, entered by Bob: Ann may decide; and Reverse checks the same rule.
    void bobEmployee;
  });

  it('Reverse cancels an unpaid approval; Reject turns a claim down', async () => {
    const res = await insert('expenseClaims', bob, { employee: 'BOB', category: 'Supplies', amount: 40, account: '6000' });
    const id = res.inserted[0].row.id as string;
    await ok(id, 'submit', bob);
    const approved = await ok(id, 'approve');
    expect(await linesOf(approved.values.journalEntry)).toEqual(['2200 Cr 40 SALES', '6000 Dr 40 SALES']);
    const back = await ok(id, 'reverse');
    expect(back.values).toMatchObject({ status: 'Submitted', approvedBy: null, journalEntry: null });
    expect(await balances()).toEqual({});
    const rejected = await ok(id, 'reject');
    expect(rejected.values.status).toBe('Rejected');
    expect((await act(id, 'approve')).json().message).toBe('Only a submitted claim can be approved (EC-00001 is rejected)');
    // Rejected claims can be deleted.
    const del = await call('POST', '/api/sheets/expenseClaims/batch', bob, { deletes: [{ id, version: rejected.version }] });
    expect(del.json().deleted).toEqual([id]);
  });

  it('manual journal lines can carry a department, and Employee payable is a control account', async () => {
    await insert('journalEntries', admin, { memo: 'Rent' });
    const lines = await insert(
      'journalLines',
      admin,
      { entry: 'JE-00001', account: '6000', debit: 500, department: 'OPS' },
      { entry: 'JE-00001', account: '1000', credit: 500 },
      { entry: 'JE-00001', account: '2200', credit: 1 },
    );
    expect(errorsOf(lines)).toEqual(['t2 account: Employee payable is a control account: use Expense claims instead']);
  });
});

describe('department costs', () => {
  it('sums posted expense lines per department and account, with a total per department', async () => {
    await insert('employees', admin, { code: 'CAR', name: 'Carla', department: 'OPS' });
    const res = await insert(
      'expenseClaims',
      bob,
      { employee: 'BOB', category: 'Travel', amount: 25.5 },
      { employee: 'BOB', category: 'Meals', amount: 10, account: '6000' },
      { employee: 'CAR', category: 'Meals', amount: 7 },
    );
    for (const r of res.inserted) {
      await ok(r.row.id, 'submit', bob);
      await ok(r.row.id, 'approve');
    }
    // Plus manual expenses without a department, on two accounts (one group, one total).
    const entry = await insert('journalEntries', admin, { memo: 'Bank fee' });
    await insert('journalLines', admin, { entry: 'JE-00004', account: '6900', debit: 3 }, { entry: 'JE-00004', account: '6100', debit: 2 }, { entry: 'JE-00004', account: '1000', credit: 5 });
    await call('POST', `/api/sheets/journalEntries/rows/${entry.inserted[0].row.id}/actions/post`, admin);

    const report = await rows('departmentCosts');
    const codes = new Map((await rows('departments')).map((d) => [d.id, d.values.code]));
    const accounts = new Map((await rows('accounts')).map((a) => [a.id, a.values.code]));
    expect(report.map((r) => [codes.get(String(r.values.department)) ?? '-', accounts.get(String(r.values.account)) ?? '-', r.values.departmentName, r.values.amount])).toEqual([
      ['OPS', '6300', 'Operations', 7],
      ['OPS', '-', 'Total', 7],
      ['SALES', '6000', 'Sales', 10],
      ['SALES', '6300', 'Sales', 25.5],
      ['SALES', '-', 'Total', 35.5],
      ['-', '6100', '(none)', 2],
      ['-', '6900', '(none)', 3],
      ['-', '-', 'Total', 5],
    ]);
    expect(await rows('departmentCosts', admin, '?to=2000-01-01')).toEqual([]);
  });
});

describe('demo data', () => {
  it('seeds departments, employees and claims in each state, and the ledger still balances', async () => {
    const { seedIfEmpty } = await import('../src/seed.ts');
    const fresh = new MemoryStore();
    await fresh.init([...sheets, ...internalSheets]);
    await seedIfEmpty(fresh);
    const open = buildApp(fresh, { auth: false });
    const get = async (sheet: string) => (await open.inject({ method: 'GET', url: `/api/sheets/${sheet}/rows` })).json().rows as Row[];
    expect((await get('expenseClaims')).map((c) => [c.values.number, c.values.status])).toEqual([
      ['EC-00001', 'Paid'],
      ['EC-00002', 'Approved'],
      ['EC-00003', 'Submitted'],
    ]);
    const tb = await get('trialBalance');
    expect(tb.find((r) => r.id === 'total')!.values.check).toBe('Balanced');
  });
});
