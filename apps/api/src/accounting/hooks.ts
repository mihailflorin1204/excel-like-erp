import type { SheetStore } from '@erp/db';
import { accountsSheet, type BatchError, type CellValue, journalEntriesSheet, type Row } from '@erp/schema';
import { ActionError, type HookContext, type SheetHooks } from '../hooks.ts';
import { commitOrConflict } from '../inventory/hooks.ts';
import { byId, eur, ids, money, num, postingContext, str, today, touchInBatch, updateAudit } from '../util.ts';
import {
  ACCOUNTS,
  CONTROL_ROLES,
  controlMessage,
  ENTRIES,
  entryNumbers,
  isRole,
  journalWriter,
  LINES,
  postedLines,
  postingAccounts,
  ROLES,
} from './posting.ts';

const entryState = (entry: Row | undefined): string => String(entry?.values.state ?? 'Draft');

function entryStatus(entry: Row, debit: number, credit: number): string {
  if (entryState(entry) === 'Draft') return debit !== credit ? 'Draft · unbalanced' : 'Draft';
  if (str(entry.values.reversedBy)) return 'Reversed';
  if (str(entry.values.reversalOf)) return 'Reversal';
  return 'Posted';
}

/** A line is a debit or a credit, never both or neither. */
function sideError(values: Record<string, CellValue>): string | null {
  const debit = num(values.debit) ?? 0;
  const credit = num(values.credit) ?? 0;
  return debit > 0 === credit > 0 ? 'Enter either a debit or a credit' : null;
}

/** Roles of the given accounts (only those that have one). */
async function rolesOf(store: SheetStore, accountIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await store.getRows(ACCOUNTS, [...new Set(accountIds)]);
  return new Map(rows.flatMap((r) => (isRole(r.values.role) ? [[r.id, r.values.role] as [string, string]] : [])));
}

async function totalsByEntry(store: SheetStore, entryIds: readonly string[]) {
  const lines = entryIds.length ? await store.listWhere(LINES, 'entry', entryIds) : [];
  const out = new Map<string, { debit: number; credit: number; count: number }>();
  for (const l of lines) {
    const key = String(l.values.entry);
    const t = out.get(key) ?? { debit: 0, credit: 0, count: 0 };
    t.debit = money(t.debit + (num(l.values.debit) ?? 0));
    t.credit = money(t.credit + (num(l.values.credit) ?? 0));
    t.count += 1;
    out.set(key, t);
  }
  return { lines, totals: out };
}

async function getEntry(store: SheetStore, id: string): Promise<Row> {
  const [entry] = await store.getRows(ENTRIES, [id]);
  if (!entry) throw new ActionError(404, 'Journal entry not found');
  return entry;
}

async function reloadEntries(store: SheetStore, entryIds: readonly string[]): Promise<Row[]> {
  const rows = await store.getRows(ENTRIES, entryIds);
  await accountingHooks.journalEntries!.computed!(store, rows);
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Bumps the accounts new lines point at, so deleting one of them at the same moment conflicts. */
async function touchAccounts(store: SheetStore, ctx: HookContext, accountIds: readonly string[]) {
  if (accountIds.length > 0) touchInBatch(ctx, accountsSheet, await store.getRows(ACCOUNTS, [...new Set(accountIds)]));
}

export const accountingHooks: Record<string, SheetHooks> = {
  accounts: {
    async computed(store, rows) {
      const wanted = new Set(rows.map((r) => r.id));
      const totals = new Map<string, { debit: number; credit: number }>();
      for (const l of await postedLines(store)) {
        if (!wanted.has(l.account)) continue;
        const t = totals.get(l.account) ?? { debit: 0, credit: 0 };
        t.debit += l.debit;
        t.credit += l.credit;
        totals.set(l.account, t);
      }
      for (const r of rows) {
        const t = totals.get(r.id) ?? { debit: 0, credit: 0 };
        r.values.usedFor = isRole(r.values.role) ? ROLES[r.values.role].usedFor : null;
        r.values.debit = money(t.debit);
        r.values.credit = money(t.credit);
        r.values.balance = money(t.debit - t.credit);
      }
    },

    async beforeUpdate(_store, updates) {
      return updates
        .filter((u) => 'type' in u.set && isRole(u.current.values.role))
        .map((u) => ({ op: 'update' as const, ref: u.id, column: 'type', message: "Automatic posting uses this account, so its type can't change" }));
    },

    async beforeDelete(_store, rows) {
      return rows
        .filter((r) => isRole(r.values.role))
        .map((r) => ({ op: 'delete' as const, ref: r.id, message: `${r.values.code} is used by automatic posting, so it can't be deleted` }));
    },
  },

  journalEntries: {
    /** Numbers new entries JE-00001, JE-00002… unless one was typed. Manual entries start as drafts. */
    async beforeInsert(store, inserts, ctx) {
      const renamed = ctx.batch.updates.filter((u) => 'number' in u.set);
      const next = await entryNumbers(
        store,
        [...renamed.map((u) => u.set.number ?? null), ...inserts.map((i) => i.values.number ?? null)],
        new Set([...ctx.batch.deletes.map((r) => r.id), ...renamed.map((u) => u.id)]),
      );
      for (const ins of inserts) {
        if (!str(ins.values.number)) ins.values.number = next();
        Object.assign(ins.values, { origin: 'Manual', state: 'Draft', source: null, sourceId: null, reversalOf: null, reversedBy: null });
      }
      return [];
    },

    async beforeUpdate(_store, updates) {
      return updates
        .filter((u) => 'number' in u.set && !str(u.set.number))
        .map((u) => ({ op: 'update' as const, ref: u.id, column: 'number', message: 'An entry needs a number' }));
    },

    async computed(store, rows) {
      const { totals } = await totalsByEntry(store, rows.map((r) => r.id));
      for (const r of rows) {
        const t = totals.get(r.id) ?? { debit: 0, credit: 0, count: 0 };
        r.values.debit = t.debit;
        r.values.credit = t.credit;
        r.values.lineCount = t.count;
        r.values.status = entryStatus(r, t.debit, t.credit);
      }
    },

    actions: {
      /** Posts a balanced draft: at least two lines, each a debit or a credit, debits = credits. */
      async post(store, id, user) {
        const entry = await getEntry(store, id);
        const n = entry.values.number;
        if (entryState(entry) !== 'Draft') throw new ActionError(409, `${n} is already posted`);
        const { lines, totals } = await totalsByEntry(store, [id]);
        const t = totals.get(id) ?? { debit: 0, credit: 0, count: 0 };
        if (t.count < 2) throw new ActionError(409, `${n} needs at least two lines. Add them in Journal lines.`);
        if (lines.some((l) => sideError(l.values))) throw new ActionError(409, `Every line of ${n} needs either a debit or a credit`);
        if (t.debit !== t.credit) {
          throw new ActionError(409, `${n} doesn't balance: debits ${eur(t.debit)}, credits ${eur(t.credit)} (difference ${eur(t.debit - t.credit)})`);
        }
        const roles = await rolesOf(store, lines.map((l) => String(l.values.account)));
        const control = [...roles.values()].find((r) => CONTROL_ROLES.includes(r as never));
        if (control) throw new ActionError(409, controlMessage[control]!);
        const ctx = postingContext(user);
        const set = { state: 'Posted', date: str(entry.values.date) ?? today() };
        // Line edits bump the entry's version, so an edit at the same moment makes this conflict instead.
        await commitOrConflict(store, {
          sheet: journalEntriesSheet,
          inserts: [],
          updates: [{ id, expectedVersion: entry.version, set, updatedAt: ctx.now }],
          deletes: [],
          audit: updateAudit(ctx, ENTRIES, entry, set),
          atomic: true,
        });
        return reloadEntries(store, [id]);
      },

      /** Posts the opposite of a posted manual entry. Entries posted by documents are reversed from the document. */
      async reverse(store, id, user) {
        const entry = await getEntry(store, id);
        const v = entry.values;
        if (entryState(entry) !== 'Posted') throw new ActionError(409, `${v.number} is a draft: change or delete it instead`);
        if (str(v.reversedBy)) throw new ActionError(409, `${v.number} is already reversed`);
        if (str(v.reversalOf)) throw new ActionError(409, `${v.number} is a reversal; post a new entry instead`);
        if (str(v.source)) {
          const origin = String(v.origin ?? 'document').toLowerCase();
          throw new ActionError(409, `${v.number} was posted by a ${origin}. Reverse that ${origin} instead.`);
        }
        const ctx = postingContext(user);
        const journal = await journalWriter(store, ctx);
        const reversal = await journal.reverse(store, id, { date: today(), origin: 'Manual', source: null });
        const [entries, ...lines] = journal.plans();
        await commitOrConflict(store, { ...entries!, atomic: true, related: lines });
        return reloadEntries(store, [id, reversal!]);
      },
    },
  },

  journalLines: {
    async beforeInsert(store, inserts, ctx) {
      const errors: BatchError[] = [];
      const entries = byId(await store.getRows(ENTRIES, [...new Set(inserts.map((i) => String(i.values.entry)))]));
      const roles = await rolesOf(store, inserts.map((i) => String(i.values.account)));
      const accepted: Row[] = [];
      for (const ins of inserts) {
        const v = ins.values;
        const err = (column: string, message: string) => errors.push({ op: 'insert', ref: ins.tempId, column, message });
        const entry = entries.get(String(v.entry));
        if (!entry) {
          err('entry', 'This entry no longer exists');
          continue;
        }
        if (entryState(entry) !== 'Draft') {
          err('entry', `${entry.values.number} is posted, so lines can't be added. Start a new entry.`);
          continue;
        }
        const side = sideError(v);
        if (side) {
          err(num(v.debit) ? 'credit' : 'debit', side);
          continue;
        }
        const role = roles.get(String(v.account));
        if (role && CONTROL_ROLES.includes(role as never)) {
          err('account', controlMessage[role]!);
          continue;
        }
        accepted.push(entry);
      }
      touchInBatch(ctx, journalEntriesSheet, accepted);
      await touchAccounts(store, ctx, inserts.filter((i) => !errors.some((e) => e.ref === i.tempId)).map((i) => String(i.values.account)));
      return errors;
    },

    async beforeUpdate(store, updates, ctx) {
      const errors: BatchError[] = [];
      const roles = await rolesOf(store, updates.flatMap((u) => ('account' in u.set ? [String(u.set.account)] : [])));
      // Read the entries once: the state checked here is the version bumped below, so a Post that lands in
      // between makes this save conflict instead of changing a posted entry.
      const entries = await store.getRows(ENTRIES, [...new Set(updates.map((u) => String(u.current.values.entry)))]);
      const draft = new Set(entries.filter((e) => entryState(e) === 'Draft').map((e) => e.id));
      for (const u of updates) {
        if (!draft.has(String(u.current.values.entry))) {
          errors.push({ op: 'update', ref: u.id, message: 'The entry is posted, so its lines are locked.' });
          continue;
        }
        if ('debit' in u.set || 'credit' in u.set) {
          const side = sideError({ ...u.current.values, ...u.set });
          if (side) errors.push({ op: 'update', ref: u.id, column: 'debit' in u.set ? 'debit' : 'credit', message: side });
        }
        const role = 'account' in u.set ? roles.get(String(u.set.account)) : undefined;
        if (role && CONTROL_ROLES.includes(role as never)) errors.push({ op: 'update', ref: u.id, column: 'account', message: controlMessage[role]! });
      }
      touchInBatch(ctx, journalEntriesSheet, entries);
      await touchAccounts(store, ctx, updates.flatMap((u) => ('account' in u.set ? [String(u.set.account)] : [])));
      return errors;
    },

    async beforeDelete(store, rows, ctx) {
      // Deleting a line also changes its (draft) entry, so it can't race with Post.
      const entries = await store.getRows(ENTRIES, ids(rows, 'entry'));
      const draft = new Set(entries.filter((e) => entryState(e) === 'Draft').map((e) => e.id));
      touchInBatch(ctx, journalEntriesSheet, entries);
      return rows
        .filter((r) => !draft.has(String(r.values.entry)))
        .map((r) => ({ op: 'delete' as const, ref: r.id, message: 'The entry is posted, so its lines are locked.' }));
    },

    async computed(store, rows) {
      const entryIds = ids(rows, 'entry');
      const entries = byId(await store.getRows(ENTRIES, entryIds));
      const accounts = byId(await store.getRows(ACCOUNTS, ids(rows, 'account')));
      const { totals } = await totalsByEntry(store, entryIds);
      for (const r of rows) {
        const entry = entries.get(String(r.values.entry));
        const t = totals.get(String(r.values.entry)) ?? { debit: 0, credit: 0 };
        r.values.accountName = accounts.get(String(r.values.account))?.values.name ?? null;
        r.values.date = entry?.values.date ?? null;
        r.values.entryState = entryState(entry);
        r.values.status = entry ? entryStatus(entry, t.debit, t.credit) : null;
      }
    },
  },

  trialBalance: {
    async virtualRows(store, params) {
      const from = params.from && ISO_DATE.test(params.from) ? params.from : null;
      const to = params.to && ISO_DATE.test(params.to) ? params.to : null;
      await postingAccounts(store);
      const accounts = await store.listWhere(ACCOUNTS, 'code');
      const sums = new Map<string, { opening: number; debit: number; credit: number }>();
      for (const l of await postedLines(store)) {
        if (to && l.date > to) continue;
        const t = sums.get(l.account) ?? { opening: 0, debit: 0, credit: 0 };
        if (from && l.date < from) t.opening += l.debit - l.credit;
        else {
          t.debit += l.debit;
          t.credit += l.credit;
        }
        sums.set(l.account, t);
      }
      const total = { opening: 0, debit: 0, credit: 0, closing: 0 };
      const rows: Row[] = accounts
        .filter((a) => sums.has(a.id))
        .sort((a, b) => String(a.values.code).localeCompare(String(b.values.code)))
        .map((a) => {
          const t = sums.get(a.id)!;
          const closing = money(t.opening + t.debit - t.credit);
          total.opening += t.opening;
          total.debit += t.debit;
          total.credit += t.credit;
          total.closing += closing;
          return report(a.id, {
            account: a.id,
            name: a.values.name ?? null,
            type: a.values.type ?? null,
            opening: money(t.opening),
            debit: money(t.debit),
            credit: money(t.credit),
            closing,
            check: null,
          });
        });
      const balanced = money(total.debit) === money(total.credit) && money(total.closing) === 0 && money(total.opening) === 0;
      rows.push(
        report('total', {
          account: null,
          name: 'Total',
          type: null,
          opening: money(total.opening),
          debit: money(total.debit),
          credit: money(total.credit),
          closing: money(total.closing),
          check: balanced ? 'Balanced' : 'Out of balance',
        }),
      );
      return rows;
    },
  },
};

const report = (id: string, values: Record<string, CellValue>): Row => ({ id, version: 0, createdAt: '', updatedAt: '', values });
