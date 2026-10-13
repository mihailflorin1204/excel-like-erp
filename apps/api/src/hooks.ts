import type { CommitPlan, SheetStore } from '@erp/db';
import type { BatchError, CellValue, Row } from '@erp/schema';
import { inventoryHooks } from './inventory/hooks.ts';
import { accountingHooks } from './accounting/hooks.ts';
import { payablesHooks } from './purchasing/payables.ts';
import { purchasingHooks } from './purchasing/hooks.ts';

/** Thrown by an action (e.g. Reverse) to send a clear message back with an HTTP status. */
export class ActionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface InsertDraft {
  tempId: string;
  /** Validated values with references resolved to ids. Posting rules may fill system columns here. */
  values: Record<string, CellValue>;
}

export interface UpdateDraft {
  id: string;
  current: Row;
  /** Validated changes (references resolved). */
  set: Record<string, CellValue>;
}

export interface HookContext {
  user: string;
  now: string;
  batchId: string;
  /**
   * Writes to other sheets saved in the same transaction as the batch. Each entry is called once the new rows
   * have ids, with a map from tempId to the new row's id.
   */
  related: ((idsByTempId: Map<string, string>) => CommitPlan | CommitPlan[])[];
  /** The whole batch, so a rule can look across rows (e.g. one item per PO across edits and new rows). */
  batch: { updates: UpdateDraft[]; inserts: InsertDraft[]; deletes: Row[] };
}

/** Module logic attached to a sheet. Each part is optional. */
export interface SheetHooks {
  /** Fills computed columns on rows about to be returned. */
  computed?: (store: SheetStore, rows: Row[]) => Promise<void>;
  /** Posting rules for new rows, run in order. Return errors for rows that must not be saved. */
  beforeInsert?: (store: SheetStore, inserts: InsertDraft[], ctx: HookContext) => Promise<BatchError[]>;
  /** Business checks on edits. An error with a column drops that cell; without one, the whole row's changes. */
  beforeUpdate?: (store: SheetStore, updates: UpdateDraft[], ctx: HookContext) => Promise<BatchError[]>;
  /** Checks on rows about to be deleted. An error keeps that row. */
  beforeDelete?: (store: SheetStore, rows: Row[], ctx: HookContext) => Promise<BatchError[]>;
  /** Rows of a virtual (report) sheet. `params` holds the sheet's declared params (e.g. from / to dates). */
  virtualRows?: (store: SheetStore, params: Record<string, string>) => Promise<Row[]>;
  /** Row actions such as Reverse. Return the rows created or changed. */
  actions?: Record<string, (store: SheetStore, rowId: string, user: string) => Promise<Row[]>>;
}

export const hooks: Record<string, SheetHooks> = {
  ...inventoryHooks,
  ...purchasingHooks,
  ...payablesHooks,
  ...accountingHooks,
};

export async function applyComputed(store: SheetStore, sheet: string, rows: Row[]): Promise<Row[]> {
  const compute = hooks[sheet]?.computed;
  if (compute && rows.length > 0) await compute(store, rows);
  return rows;
}
