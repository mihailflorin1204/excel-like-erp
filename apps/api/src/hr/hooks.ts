import type { SheetStore } from '@erp/db';
import { type BatchError, type CellValue, expenseClaimsSheet, type Row, uniqueKey } from '@erp/schema';
import { ACCOUNTS, journalWriter, postedLines } from '../accounting/posting.ts';
import { actorOf, requireAdmin } from '../auth.ts';
import { ActionError, type SheetHooks } from '../hooks.ts';
import { commitOrConflict } from '../inventory/hooks.ts';
import { byId, ids, money, num, postingContext, str, today, updateAudit } from '../util.ts';

const CLAIMS = 'expenseClaims';
const EMPLOYEES = 'employees';
const DEPARTMENTS = 'departments';
const URL_PATTERN = /^https?:\/\/\S+$/i;

const claimState = (claim: Row): string => str(claim.values.state) ?? 'Draft';
const employeeStatus = (e: Row | undefined) => str(e?.values.status) ?? 'Active';

async function getClaim(store: SheetStore, id: string): Promise<Row> {
  const [claim] = await store.getRows(CLAIMS, [id]);
  if (!claim) throw new ActionError(404, 'Expense claim not found');
  return claim;
}

async function reloadClaim(store: SheetStore, id: string): Promise<Row[]> {
  const rows = await store.getRows(CLAIMS, [id]);
  await hrHooks.expenseClaims!.computed!(store, rows);
  return rows;
}

/** Changes a claim (state and posting links) atomically, with any journal plans in the same transaction. */
async function saveClaim(store: SheetStore, claim: Row, set: Record<string, CellValue>, user: string, related: Awaited<ReturnType<typeof journalWriter>> | null) {
  const ctx = postingContext(user);
  await commitOrConflict(store, {
    sheet: expenseClaimsSheet,
    inserts: [],
    updates: [{ id: claim.id, expectedVersion: claim.version, set, updatedAt: ctx.now }],
    deletes: [],
    audit: updateAudit(ctx, CLAIMS, claim, set),
    atomic: true,
    related: related?.plans() ?? [],
  });
}

/**
 * Approve, reject, pay and reverse are for admins, and nobody decides on their own claim: not the person who
 * entered or submitted it, and not the employee (their email now, or when the claim was submitted).
 */
async function decider(store: SheetStore, claim: Row, user: string, what: string) {
  const actor = await requireAdmin(store, user, what);
  const [employee] = await store.getRows(EMPLOYEES, [String(claim.values.employee)]);
  const me = uniqueKey(actor.email);
  const involved = [claim.values.createdBy, claim.values.submittedBy, claim.values.employeeEmail, employee?.values.email];
  // System users (seeding, or sign-in switched off) stand for nobody in particular.
  if (actor.userId && involved.some((v) => str(v) && uniqueKey(v ?? null) === me)) {
    throw new ActionError(403, `You can't ${what.split(' ')[0]} your own claim; ask another admin`);
  }
  return { actor, employee };
}

/** Accounts typed on claims must be expense accounts. Returns an error message per bad account id. */
async function checkAccounts(store: SheetStore, accountIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const a of await store.getRows(ACCOUNTS, [...new Set(accountIds)])) {
    if (a.values.type !== 'Expense') out.set(a.id, `${a.values.code} is not an expense account`);
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const hrHooks: Record<string, SheetHooks> = {
  departments: {
    async computed(store, rows) {
      const employees = await store.listWhere(EMPLOYEES, 'department', rows.map((r) => r.id));
      for (const r of rows) {
        r.values.headcount = employees.filter((e) => e.values.department === r.id && employeeStatus(e) === 'Active').length;
      }
    },
  },

  employees: {
    async beforeInsert(_store, inserts) {
      const errors: BatchError[] = [];
      for (const ins of inserts) {
        const email = str(ins.values.email);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ op: 'insert', ref: ins.tempId, column: 'email', message: 'Enter a valid email' });
          continue;
        }
        ins.values.status = str(ins.values.status) ?? 'Active';
      }
      return errors;
    },

    /** Emails link employees to logins (no deciding on your own claims), so only admins change them. */
    async beforeUpdate(store, updates, ctx) {
      const admin = (await actorOf(store, ctx.user)).role === 'Admin';
      return updates
        .filter((u) => 'email' in u.set)
        .flatMap((u) => {
          if (!admin) return [{ op: 'update' as const, ref: u.id, column: 'email', message: 'Only an admin can change an employee’s email' }];
          if (str(u.set.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.set.email))) {
            return [{ op: 'update' as const, ref: u.id, column: 'email', message: 'Enter a valid email' }];
          }
          return [];
        });
    },

    async computed(store, rows) {
      const claims = await store.listWhere(CLAIMS, 'employee', rows.map((r) => r.id));
      for (const r of rows) {
        const owed = claims
          .filter((c) => c.values.employee === r.id && claimState(c) === 'Approved')
          .reduce((sum, c) => sum + (num(c.values.amount) ?? 0), 0);
        r.values.owed = money(owed);
      }
    },
  },

  expenseClaims: {
    /** Numbers new claims EC-00001… unless one was typed; checks the employee, amount, account and link. */
    async beforeInsert(store, inserts, ctx) {
      const errors: BatchError[] = [];
      const employees = byId(await store.getRows(EMPLOYEES, [...new Set(inserts.map((i) => String(i.values.employee)))]));
      const badAccounts = await checkAccounts(store, inserts.flatMap((i) => (str(i.values.account) ? [String(i.values.account)] : [])));
      const renamed = new Map(ctx.batch.updates.filter((u) => 'number' in u.set).map((u) => [u.id, u.set.number]));
      const deleted = new Set(ctx.batch.deletes.map((r) => r.id));
      const numbers = [
        ...(await store.listWhere(CLAIMS, 'number')).filter((r) => !deleted.has(r.id)).map((r) => (renamed.has(r.id) ? renamed.get(r.id) : r.values.number)),
        ...inserts.map((i) => i.values.number),
      ];
      const taken = new Set(numbers.map((n) => uniqueKey(n ?? null)).filter(Boolean));
      let next = Math.max(0, ...numbers.map((n) => Number(/^EC-(\d{1,9})$/i.exec(String(n ?? ''))?.[1] ?? 0))) + 1;

      for (const ins of inserts) {
        const v = ins.values;
        const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
        const employee = employees.get(String(v.employee));
        if (employeeStatus(employee) !== 'Active') {
          err('employee', `${employee?.values.code ?? 'This employee'} has left; claims are for active employees`);
          continue;
        }
        if ((num(v.amount) ?? 0) <= 0) {
          err('amount', 'Must be more than 0');
          continue;
        }
        const bad = str(v.account) ? badAccounts.get(String(v.account)) : undefined;
        if (bad) {
          err('account', bad);
          continue;
        }
        if (str(v.receiptUrl) && !URL_PATTERN.test(String(v.receiptUrl))) {
          err('receiptUrl', 'Use a link starting with http:// or https://');
          continue;
        }
        if (!str(v.number)) {
          let candidate = `EC-${String(next++).padStart(5, '0')}`;
          while (taken.has(uniqueKey(candidate))) candidate = `EC-${String(next++).padStart(5, '0')}`;
          v.number = candidate;
          taken.add(uniqueKey(candidate));
        }
        Object.assign(v, {
          state: 'Draft',
          createdBy: ctx.user,
          submittedBy: null,
          employeeEmail: null,
          approvedBy: null,
          paidDate: null,
          journalEntry: null,
          paymentEntry: null,
        });
      }
      return errors;
    },

    async beforeUpdate(store, updates) {
      const errors: BatchError[] = [];
      const badAccounts = await checkAccounts(store, updates.flatMap((u) => (str(u.set.account) ? [String(u.set.account)] : [])));
      const employees = byId(await store.getRows(EMPLOYEES, updates.flatMap((u) => ('employee' in u.set ? [String(u.set.employee)] : []))));
      for (const u of updates) {
        const err = (column: string, message: string) => errors.push({ op: 'update', ref: u.id, column, message });
        if ('number' in u.set && !str(u.set.number)) err('number', 'A claim needs a number');
        if ('amount' in u.set && (num(u.set.amount) ?? 0) <= 0) err('amount', 'Must be more than 0');
        if (str(u.set.account) && badAccounts.has(String(u.set.account))) err('account', badAccounts.get(String(u.set.account))!);
        if (str(u.set.receiptUrl) && !URL_PATTERN.test(String(u.set.receiptUrl))) err('receiptUrl', 'Use a link starting with http:// or https://');
        if ('employee' in u.set && employeeStatus(employees.get(String(u.set.employee))) !== 'Active') err('employee', 'Claims are for active employees');
      }
      return errors;
    },

    async computed(store, rows) {
      const employees = byId(await store.getRows(EMPLOYEES, ids(rows, 'employee')));
      for (const r of rows) {
        r.values.status = claimState(r);
        r.values.department = employees.get(String(r.values.employee))?.values.department ?? null;
      }
    },

    actions: {
      async submit(store, id, user) {
        const claim = await getClaim(store, id);
        if (claimState(claim) !== 'Draft') throw new ActionError(409, `${claim.values.number} is already ${claimState(claim).toLowerCase()}`);
        const [employee] = await store.getRows(EMPLOYEES, [String(claim.values.employee)]);
        await saveClaim(store, claim, { state: 'Submitted', submittedBy: user, employeeEmail: str(employee?.values.email) }, user, null);
        return reloadClaim(store, id);
      },

      /** Dr the expense account (tagged with the employee's department) / Cr Employee payable. */
      async approve(store, id, user) {
        const claim = await getClaim(store, id);
        const v = claim.values;
        if (claimState(claim) !== 'Submitted') throw new ActionError(409, `Only a submitted claim can be approved (${v.number} is ${claimState(claim).toLowerCase()})`);
        const { actor, employee } = await decider(store, claim, user, 'approve claims');
        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        const amount = money(num(v.amount) ?? 0);
        const department = str(employee?.values.department);
        const entry = journal.add({
          date: today(),
          memo: [`Claim ${v.number} · ${employee?.values.code ?? ''}`, str(v.category), str(v.description)].filter(Boolean).join(' · '),
          origin: 'Expense claim',
          source: CLAIMS,
          sourceId: id,
          lines: [
            { account: str(v.account) ?? journal.account('claimsExpense'), debit: amount, department },
            { account: journal.account('employeePayable'), credit: amount, department },
          ],
        });
        await saveClaim(store, claim, { state: 'Approved', approvedBy: actor.email, journalEntry: entry }, user, journal);
        return reloadClaim(store, id);
      },

      async reject(store, id, user) {
        const claim = await getClaim(store, id);
        if (claimState(claim) !== 'Submitted') throw new ActionError(409, `Only a submitted claim can be rejected (${claim.values.number} is ${claimState(claim).toLowerCase()})`);
        await decider(store, claim, user, 'reject claims');
        await saveClaim(store, claim, { state: 'Rejected' }, user, null);
        return reloadClaim(store, id);
      },

      /** Dr Employee payable / Cr Bank, dated today. */
      async pay(store, id, user) {
        const claim = await getClaim(store, id);
        const v = claim.values;
        if (claimState(claim) !== 'Approved') throw new ActionError(409, `Only an approved claim can be paid (${v.number} is ${claimState(claim).toLowerCase()})`);
        const { employee } = await decider(store, claim, user, 'pay claims');
        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        const amount = money(num(v.amount) ?? 0);
        const department = str(employee?.values.department);
        const date = today();
        const entry = journal.add({
          date,
          memo: `Payment claim ${v.number} · ${employee?.values.code ?? ''}`,
          origin: 'Expense claim',
          source: CLAIMS,
          sourceId: id,
          lines: [
            { account: journal.account('employeePayable'), debit: amount, department },
            { account: journal.account('bank'), credit: amount },
          ],
        });
        await saveClaim(store, claim, { state: 'Paid', paidDate: date, paymentEntry: entry }, user, journal);
        return reloadClaim(store, id);
      },

      /** Cancels an approval that hasn't been paid: the opposite entry, and the claim is Submitted again. */
      async reverse(store, id, user) {
        const claim = await getClaim(store, id);
        const v = claim.values;
        if (claimState(claim) !== 'Approved') {
          throw new ActionError(409, claimState(claim) === 'Paid' ? `${v.number} is already paid, so its approval can't be reversed` : `Only an approved claim can be reversed (${v.number} is ${claimState(claim).toLowerCase()})`);
        }
        await decider(store, claim, user, 'reverse approvals of claims');
        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        await journal.reverse(store, str(v.journalEntry), { date: today(), origin: 'Expense claim', source: CLAIMS, sourceId: id });
        await saveClaim(store, claim, { state: 'Submitted', approvedBy: null, journalEntry: null }, user, journal);
        return reloadClaim(store, id);
      },
    },
  },

  departmentCosts: {
    /** Expense lines per department and account (debits − credits), with a total per department. */
    async virtualRows(store, params) {
      const from = params.from && ISO_DATE.test(params.from) ? params.from : null;
      const to = params.to && ISO_DATE.test(params.to) ? params.to : null;
      const accounts = byId(await store.listWhere(ACCOUNTS, 'code'));
      const departments = byId(await store.listWhere(DEPARTMENTS, 'code'));
      const sums = new Map<string, number>();
      for (const l of await postedLines(store)) {
        if ((from && l.date < from) || (to && l.date > to)) continue;
        if (accounts.get(l.account)?.values.type !== 'Expense') continue;
        const key = `${l.department ?? ''}|${l.account}`;
        sums.set(key, (sums.get(key) ?? 0) + l.debit - l.credit);
      }
      const code = (deptId: string) => String(departments.get(deptId)?.values.code ?? '?');
      // Departments by code, lines without a department last; accounts by code within each.
      const keys = [...sums.keys()].sort((a, b) => {
        const [da, aa] = a.split('|') as [string, string];
        const [db, ab] = b.split('|') as [string, string];
        if (!da !== !db) return da ? -1 : 1;
        return code(da).localeCompare(code(db)) || String(accounts.get(aa)?.values.code).localeCompare(String(accounts.get(ab)?.values.code));
      });
      const rows: Row[] = [];
      const totals = new Map<string, number>();
      for (const key of keys) {
        const [dept, account] = key.split('|') as [string, string];
        const amount = money(sums.get(key)!);
        if (amount === 0) continue;
        totals.set(dept, money((totals.get(dept) ?? 0) + amount));
        rows.push(report(key, {
          department: dept || null,
          departmentName: dept ? (departments.get(dept)?.values.name ?? null) : '(none)',
          account,
          accountName: accounts.get(account)?.values.name ?? null,
          amount,
        }));
      }
      const withTotals: Row[] = [];
      for (const [i, r] of rows.entries()) {
        withTotals.push(r);
        const dept = String(r.values.department ?? '');
        const next = rows[i + 1];
        if (!next || String(next.values.department ?? '') !== dept) {
          withTotals.push(report(`total-${dept}`, { department: r.values.department ?? null, departmentName: 'Total', account: null, accountName: null, amount: totals.get(dept) ?? 0 }));
        }
      }
      return withTotals;
    },
  },
};

const report = (id: string, values: Record<string, CellValue>): Row => ({ id, version: 0, createdAt: '', updatedAt: '', values });
