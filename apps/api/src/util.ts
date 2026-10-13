import { randomUUID } from 'node:crypto';
import type { CommitPlan } from '@erp/db';
import { type AuditEntry, type CellValue, roundTo, type Row, type SheetDef } from '@erp/schema';
import type { HookContext } from './hooks.ts';

/** Today's date on the server, in its own time zone (the browser normally fills the date itself). */
export const today = () => new Date().toLocaleDateString('sv-SE');
export const str = (v: CellValue | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const num = (v: CellValue | undefined): number | null => (typeof v === 'number' ? v : null);
export const fmtQty = (n: number) => String(roundTo(n, 6));
export const money = (n: number) => roundTo(n, 2);
/** Amount as shown in messages, e.g. 1234.5 → "€1,234.50". */
export const eur = (n: number) => `€${money(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Who is posting, and when (shared by everything saved in one go). */
export interface PostingContext {
  user: string;
  now: string;
  batchId: string;
}

export const postingContext = (user: string): PostingContext => ({ user, now: new Date().toISOString(), batchId: randomUUID() });

export const auditEntry = (
  ctx: PostingContext,
  sheet: string,
  rowId: string,
  op: AuditEntry['op'],
  column: string | null,
  oldValue: CellValue,
  newValue: CellValue,
): AuditEntry => ({ id: randomUUID(), sheet, rowId, op, column, oldValue, newValue, user: ctx.user, batchId: ctx.batchId, at: ctx.now });

/** Audit entries for a newly created row (one per filled column). */
export const insertAudit = (ctx: PostingContext, sheet: string, row: Row): AuditEntry[] =>
  Object.entries(row.values)
    .filter(([, value]) => value !== null)
    .map(([column, value]) => auditEntry(ctx, sheet, row.id, 'insert', column, null, value));

/** Audit entries for changes to a saved row. */
export const updateAudit = (ctx: PostingContext, sheet: string, row: Row, set: Record<string, CellValue>): AuditEntry[] =>
  Object.entries(set).map(([column, value]) => auditEntry(ctx, sheet, row.id, 'update', column, row.values[column] ?? null, value));

export const newRow = (ctx: PostingContext, values: Record<string, CellValue>, id: string = randomUUID()): Row => ({
  id,
  version: 1,
  createdAt: ctx.now,
  updatedAt: ctx.now,
  values,
});

/** A plan that only bumps rows' versions: a later write that read them before this one then conflicts. */
export const touchPlan = (sheet: SheetDef, rows: readonly Row[], now: string): CommitPlan => ({
  sheet,
  inserts: [],
  updates: [...new Map(rows.map((r) => [r.id, r])).values()].map((r) => ({ id: r.id, expectedVersion: r.version, set: {}, updatedAt: now })),
  deletes: [],
  audit: [],
});

/**
 * Bumps the version of rows a batch depends on (e.g. the bill a payment is for), in the same transaction, so
 * two requests that read the same row can't both save. Each row once per batch.
 */
const touched = new WeakMap<HookContext, Set<string>>();
export function touchInBatch(ctx: HookContext, sheet: SheetDef, rows: readonly Row[]): void {
  const done = touched.get(ctx) ?? new Set<string>();
  touched.set(ctx, done);
  const fresh = rows.filter((r) => !done.has(`${sheet.key}|${r.id}`));
  if (fresh.length === 0) return;
  for (const r of fresh) done.add(`${sheet.key}|${r.id}`);
  ctx.related.push(() => touchPlan(sheet, fresh, ctx.now));
}

export const ids = (rows: readonly Row[], column: string) => [
  ...new Set(rows.map((r) => str(r.values[column])).filter((v): v is string => !!v)),
];
export const byId = (rows: readonly Row[]) => new Map(rows.map((r) => [r.id, r]));
export const groupBy = (rows: readonly Row[], column: string) => {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.values[column] ?? '');
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  return map;
};
