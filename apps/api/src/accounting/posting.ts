import { randomUUID } from 'node:crypto';
import { type CommitPlan, ConflictError, DuplicateKeyError, type SheetStore } from '@erp/db';
import { accountsSheet, type CellValue, journalEntriesSheet, journalLinesSheet, type Row, uniqueKey } from '@erp/schema';
import { ActionError, type HookContext } from '../hooks.ts';
import { insertAudit, money, newRow, num, type PostingContext, postingContext, str, updateAudit } from '../util.ts';

export const ACCOUNTS = 'accounts';
export const ENTRIES = 'journalEntries';
export const LINES = 'journalLines';

/**
 * Accounts automatic posting uses, found by their role (so people can renumber or rename them).
 * Created on first use with these defaults.
 */
export const ROLES = {
  bank: { code: '1000', name: 'Bank', type: 'Asset', usedFor: 'Supplier payments' },
  inventory: { code: '1300', name: 'Inventory', type: 'Asset', usedFor: 'Stock value (control account)' },
  payable: { code: '2000', name: 'Accounts payable', type: 'Liability', usedFor: 'Bills and payments (control account)' },
  grni: { code: '2100', name: 'Goods received not invoiced', type: 'Liability', usedFor: 'Goods receipts and bills' },
  opening: { code: '3900', name: 'Opening balances', type: 'Equity', usedFor: 'Stock received without a PO' },
  cogs: { code: '5000', name: 'Cost of goods sold', type: 'Expense', usedFor: 'Stock issues' },
  stockAdjustment: { code: '5100', name: 'Stock adjustments', type: 'Expense', usedFor: 'Stock adjustments' },
  priceVariance: { code: '5200', name: 'Purchase price variance', type: 'Expense', usedFor: 'Bills above the received value' },
  employeePayable: { code: '2200', name: 'Employee payable', type: 'Liability', usedFor: 'Approved expense claims (control account)' },
  claimsExpense: { code: '6300', name: 'Travel and expenses', type: 'Expense', usedFor: 'Expense claims without an account' },
} as const;
export type Role = keyof typeof ROLES;
const ROLE_KEYS = Object.keys(ROLES) as Role[];
export const isRole = (v: CellValue | undefined): v is Role => typeof v === 'string' && v in ROLES;

/** Only their own documents may post to these, so the ledger always agrees with stock and open bills. */
export const CONTROL_ROLES: readonly Role[] = ['inventory', 'payable', 'employeePayable'];
export const controlMessage: Record<string, string> = {
  inventory: 'Inventory is a control account: change stock in Stock movements instead',
  payable: 'Accounts payable is a control account: use Supplier bills and Supplier payments instead',
  employeePayable: 'Employee payable is a control account: use Expense claims instead',
};

/** The rest of the simple generic chart, added only to an empty chart of accounts. */
const OTHER_ACCOUNTS: { code: string; name: string; type: string }[] = [
  { code: '1100', name: 'Cash', type: 'Asset' },
  { code: '1200', name: 'Accounts receivable', type: 'Asset' },
  { code: '1500', name: 'Equipment', type: 'Asset' },
  { code: '2300', name: 'Loans', type: 'Liability' },
  { code: '3000', name: "Owner's equity", type: 'Equity' },
  { code: '3100', name: 'Retained earnings', type: 'Equity' },
  { code: '4000', name: 'Sales', type: 'Income' },
  { code: '4900', name: 'Other income', type: 'Income' },
  { code: '6000', name: 'Rent', type: 'Expense' },
  { code: '6100', name: 'Utilities', type: 'Expense' },
  { code: '6200', name: 'Salaries', type: 'Expense' },
  { code: '6400', name: 'Office supplies', type: 'Expense' },
  { code: '6900', name: 'Bank charges', type: 'Expense' },
];

const ensuring = new WeakMap<SheetStore, Promise<Map<Role, string>>>();

/**
 * Account id per role. Creates whatever is missing: the whole generic chart when there are no accounts yet,
 * otherwise only the missing role accounts (taking over an unassigned account that already has the default code).
 */
export function postingAccounts(store: SheetStore): Promise<Map<Role, string>> {
  const running = ensuring.get(store);
  if (running) return running;
  const p = ensureAccounts(store).finally(() => ensuring.delete(store));
  ensuring.set(store, p);
  return p;
}

async function ensureAccounts(store: SheetStore, attempt = 0): Promise<Map<Role, string>> {
  const all = await store.listWhere(ACCOUNTS, 'code');
  const byRole = new Map<Role, string>();
  for (const r of all) if (isRole(r.values.role) && !byRole.has(r.values.role)) byRole.set(r.values.role, r.id);
  const missing = ROLE_KEYS.filter((k) => !byRole.has(k));
  if (missing.length === 0) return byRole;

  const ctx = postingContext('system');
  const byCode = new Map(all.map((r) => [uniqueKey(r.values.code ?? null), r]));
  const wanted = [
    ...missing.map((role) => ({ ...ROLES[role], role: role as Role | null })),
    ...(all.length === 0 ? OTHER_ACCOUNTS.map((a) => ({ ...a, role: null })) : []),
  ].sort((a, b) => a.code.localeCompare(b.code));

  const plan: CommitPlan = { sheet: accountsSheet, inserts: [], updates: [], deletes: [], audit: [], atomic: true };
  for (const def of wanted) {
    const existing = byCode.get(uniqueKey(def.code));
    if (existing && def.role && !str(existing.values.role)) {
      plan.updates.push({ id: existing.id, expectedVersion: existing.version, set: { role: def.role }, updatedAt: ctx.now });
      plan.audit.push(...updateAudit(ctx, ACCOUNTS, existing, { role: def.role }));
      byRole.set(def.role, existing.id);
      continue;
    }
    let code = def.code;
    for (let i = 1; byCode.has(uniqueKey(code)); i++) code = `${def.code}-${i}`;
    const row = newRow(ctx, { code, name: def.name, type: def.type, role: def.role });
    byCode.set(uniqueKey(code), row);
    plan.inserts.push(row);
    plan.audit.push(...insertAudit(ctx, ACCOUNTS, row));
    if (def.role) byRole.set(def.role, row.id);
  }
  try {
    await store.commit(plan);
  } catch (err) {
    // Another process created them at the same moment: read again.
    if ((err instanceof ConflictError || err instanceof DuplicateKeyError) && attempt < 2) return ensureAccounts(store, attempt + 1);
    throw err;
  }
  return byRole;
}

/** Next free entry numbers, JE-00001, JE-00002… */
export async function entryNumbers(store: SheetStore, extra: readonly CellValue[] = [], exclude: ReadonlySet<string> = new Set()) {
  const numbers = [
    ...(await store.listWhere(ENTRIES, 'number')).filter((r) => !exclude.has(r.id)).map((r) => r.values.number ?? null),
    ...extra,
  ];
  const taken = new Set(numbers.map((n) => uniqueKey(n)).filter(Boolean));
  // Only up to 9 digits count towards the sequence, so a huge typed number can't break it.
  let next = Math.max(0, ...numbers.map((n) => Number(/^JE-(\d{1,9})$/i.exec(String(n ?? ''))?.[1] ?? 0))) + 1;
  return () => {
    let candidate = `JE-${String(next++).padStart(5, '0')}`;
    while (taken.has(uniqueKey(candidate))) candidate = `JE-${String(next++).padStart(5, '0')}`;
    taken.add(uniqueKey(candidate));
    return candidate;
  };
}

export interface EntryLine {
  account: string;
  debit?: number;
  credit?: number;
  memo?: string | null;
  /** Cost centre (a department id). */
  department?: string | null;
}

export interface NewEntry {
  date: string;
  memo: string;
  /** Shown in Journal entries, e.g. "Goods receipt". */
  origin: string;
  /** The document that posts it: its sheet (null for manual entries), and its id (or, for a row being inserted in this batch, its tempId). */
  source: string | null;
  sourceId?: string;
  sourceTempId?: string;
  /** Save the entry only if the batch row with this tempId is saved (when the source id is already known). */
  keepIfTempId?: string;
  lines: EntryLine[];
  /** The entry this one cancels. If that entry is also new in this writer, it is marked reversed here. */
  reversalOf?: string | null;
}

interface Draft {
  id: string;
  /** Saved only if this batch row is saved; with `resolveSource`, its new id becomes the entry's sourceId. */
  tempId?: string;
  resolveSource: boolean;
  values: Record<string, CellValue>;
  lines: Record<string, CellValue>[];
}

/**
 * Collects automatic journal entries for one save and turns them into commit plans (entries + lines), so they
 * are written in the same transaction as the documents that post them. Entries are always balanced and posted.
 */
export class JournalWriter {
  private drafts: Draft[] = [];
  private updates: { row: Row; set: Record<string, CellValue> }[] = [];

  constructor(
    readonly accounts: Map<Role, string>,
    private readonly nextNumber: () => string,
    private readonly ctx: PostingContext,
  ) {}

  account(role: Role): string {
    const id = this.accounts.get(role);
    if (!id) throw new Error(`No account for ${role}`);
    return id;
  }

  /** Adds a posted entry; returns its id, or null if every line is zero. Lines must balance. */
  add(e: NewEntry): string | null {
    const lines = e.lines
      .map((l) => {
        const net = money((l.debit ?? 0) - (l.credit ?? 0));
        return { account: l.account, debit: net > 0 ? net : null, credit: net < 0 ? -net : null, memo: l.memo ?? null, department: l.department ?? null };
      })
      .filter((l) => l.debit !== null || l.credit !== null);
    if (lines.length === 0) return null;
    const debit = money(lines.reduce((s, l) => s + (l.debit ?? 0), 0));
    const credit = money(lines.reduce((s, l) => s + (l.credit ?? 0), 0));
    if (debit !== credit) throw new Error(`Unbalanced automatic entry (${debit} ≠ ${credit}): ${e.memo}`);

    const id = randomUUID();
    const reversalOf = e.reversalOf ?? null;
    if (reversalOf) {
      const original = this.drafts.find((d) => d.id === reversalOf);
      if (original) original.values.reversedBy = id;
    }
    this.drafts.push({
      id,
      tempId: e.sourceTempId ?? e.keepIfTempId,
      resolveSource: !!e.sourceTempId,
      values: {
        number: this.nextNumber(),
        date: e.date,
        memo: e.memo.slice(0, 200),
        origin: e.origin,
        state: 'Posted',
        source: e.source,
        sourceId: e.sourceId ?? null,
        reversalOf,
        reversedBy: null,
      },
      lines: lines.map((l) => ({ entry: id, account: l.account, debit: l.debit, credit: l.credit, memo: l.memo, department: l.department })),
    });
    return id;
  }

  /**
   * Adds the exact opposite of a saved posted entry and marks that entry reversed. Returns the new entry's id,
   * or null when there is no such entry.
   */
  async reverse(
    store: SheetStore,
    entryId: string | null,
    e: Omit<NewEntry, 'lines' | 'reversalOf' | 'memo'> & { memo?: string },
  ): Promise<string | null> {
    if (!entryId) return null;
    const [entry] = await store.getRows(ENTRIES, [entryId]);
    if (!entry) return null;
    if (str(entry.values.reversedBy)) throw new ActionError(409, `${entry.values.number} is already reversed`);
    const lines = await store.listWhere(LINES, 'entry', [entryId]);
    const id = this.add({
      ...e,
      memo: e.memo ?? `Reversal of ${entry.values.number}${str(entry.values.memo) ? `: ${entry.values.memo}` : ''}`,
      reversalOf: entryId,
      lines: lines.map((l) => ({
        account: String(l.values.account),
        debit: num(l.values.credit) ?? 0,
        credit: num(l.values.debit) ?? 0,
        memo: str(l.values.memo),
        department: str(l.values.department),
      })),
    });
    if (id) this.markReversed(entry, id);
    return id;
  }

  /** Marks a saved entry as reversed by an entry added to this writer. */
  markReversed(entry: Row, by: string): void {
    this.updates.push({ row: entry, set: { reversedBy: by } });
  }

  /** Whether this writer holds a new entry with that id. */
  has(entryId: string): boolean {
    return this.drafts.some((d) => d.id === entryId);
  }

  get isEmpty(): boolean {
    return this.drafts.length === 0 && this.updates.length === 0;
  }

  /** The writes, once new documents have ids. Entries whose document was not saved are left out. */
  plans(idsByTempId: ReadonlyMap<string, string> = new Map()): CommitPlan[] {
    const kept = this.drafts.filter((d) => !d.tempId || idsByTempId.has(d.tempId));
    if (kept.length === 0 && this.updates.length === 0) return [];
    const entries = kept.map((d) =>
      newRow(this.ctx, { ...d.values, sourceId: d.resolveSource ? idsByTempId.get(d.tempId!)! : (d.values.sourceId ?? null) }, d.id),
    );
    const lines = kept.flatMap((d) => d.lines.map((l) => newRow(this.ctx, l)));
    return [
      {
        sheet: journalEntriesSheet,
        inserts: entries,
        updates: this.updates.map((u) => ({ id: u.row.id, expectedVersion: u.row.version, set: u.set, updatedAt: this.ctx.now })),
        deletes: [],
        audit: [
          ...entries.flatMap((r) => insertAudit(this.ctx, ENTRIES, r)),
          ...this.updates.flatMap((u) => updateAudit(this.ctx, ENTRIES, u.row, u.set)),
        ],
      },
      { sheet: journalLinesSheet, inserts: lines, updates: [], deletes: [], audit: lines.flatMap((r) => insertAudit(this.ctx, LINES, r)) },
    ];
  }
}

export async function journalWriter(store: SheetStore, ctx: PostingContext): Promise<JournalWriter> {
  const [accounts, next] = await Promise.all([postingAccounts(store), entryNumbers(store)]);
  return new JournalWriter(accounts, next, ctx);
}

/** Writers that share one account lookup and one numbering sequence (for long runs such as the backfill). */
export async function journalWriters(store: SheetStore): Promise<(ctx: PostingContext) => JournalWriter> {
  const [accounts, next] = await Promise.all([postingAccounts(store), entryNumbers(store)]);
  return (ctx) => new JournalWriter(accounts, next, ctx);
}

const writers = new WeakMap<HookContext, Promise<JournalWriter>>();

/** The journal writer of a grid save; its entries are saved with the batch (ctx.related). One per batch. */
export function journalFor(store: SheetStore, ctx: HookContext): Promise<JournalWriter> {
  let w = writers.get(ctx);
  if (!w) {
    const holder: { writer?: JournalWriter } = {};
    // Resolves only once the holder is filled, so the plans below always see the writer.
    w = journalWriter(store, ctx).then((x) => (holder.writer = x));
    writers.set(ctx, w);
    ctx.related.push((idsByTempId) => holder.writer?.plans(idsByTempId) ?? []);
  }
  return w;
}

/**
 * The journal entry for a stock movement (values as posted), or null for transfers and zero values:
 * stock coming in is debited to Inventory, stock going out credited, against an account that depends on why.
 * Sets `journalEntry` on the values.
 */
export function postMovementEntry(
  writer: JournalWriter,
  v: Record<string, CellValue>,
  ref: { id?: string; tempId?: string; keepIfTempId?: string; sku?: string | null; reversalOf?: string | null },
): string | null {
  const amount = money(num(v.value) ?? 0);
  if (v.type === 'Transfer' || amount === 0) {
    v.journalEntry = null;
    return null;
  }
  const fromReceipt = v.source === 'goodsReceipts';
  const contra: Role =
    v.type === 'Receipt' ? (fromReceipt ? 'grni' : 'opening') : v.type === 'Issue' ? 'cogs' : 'stockAdjustment';
  const inventory = writer.account('inventory');
  const other = writer.account(contra);
  const qty = num(v.qty) ?? 0;
  const memo = [`${v.type}${ref.sku ? ` ${ref.sku}` : ''} × ${qty}`, str(v.reference), str(v.reason)].filter(Boolean).join(' · ');
  const id = writer.add({
    date: str(v.date) ?? new Date().toISOString().slice(0, 10),
    memo,
    origin: fromReceipt ? 'Goods receipt' : 'Stock movement',
    source: 'stockMovements',
    sourceId: ref.id,
    sourceTempId: ref.tempId,
    keepIfTempId: ref.keepIfTempId,
    reversalOf: ref.reversalOf ?? null,
    lines:
      amount > 0
        ? [{ account: inventory, debit: amount }, { account: other, credit: amount }]
        : [{ account: other, debit: -amount }, { account: inventory, credit: -amount }],
  });
  v.journalEntry = id;
  return id;
}

/** Posted lines with their entry's date, for balances and the trial balance. */
export async function postedLines(
  store: SheetStore,
): Promise<{ account: string; date: string; debit: number; credit: number; department: string | null }[]> {
  const entries = await store.listWhere(ENTRIES, 'state', ['Posted']);
  if (entries.length === 0) return [];
  const dates = new Map(entries.map((e) => [e.id, String(e.values.date ?? '')]));
  // All lines, filtered here: a query listing every posted entry id would outgrow the database's limits.
  const lines = (await store.listWhere(LINES, 'entry')).filter((l) => dates.has(String(l.values.entry)));
  return lines.map((l) => ({
    account: String(l.values.account),
    date: dates.get(String(l.values.entry)) ?? '',
    debit: num(l.values.debit) ?? 0,
    credit: num(l.values.credit) ?? 0,
    department: str(l.values.department),
  }));
}
