import type { SheetStore } from '@erp/db';
import type { BatchError, CellValue, Row } from '@erp/schema';
import { inventoryHooks } from './inventory/hooks.ts';

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

/** Module logic attached to a sheet. Each part is optional. */
export interface SheetHooks {
  /** Fills computed columns on rows about to be returned. */
  computed?: (store: SheetStore, rows: Row[]) => Promise<void>;
  /** Posting rules for new rows, run in order. Return errors for rows that must not be saved. */
  beforeInsert?: (store: SheetStore, inserts: InsertDraft[]) => Promise<BatchError[]>;
  /** Rows of a virtual (report) sheet. */
  virtualRows?: (store: SheetStore) => Promise<Row[]>;
  /** Row actions such as Reverse. Return the rows created or changed. */
  actions?: Record<string, (store: SheetStore, rowId: string, user: string) => Promise<Row[]>>;
}

export const hooks: Record<string, SheetHooks> = {
  ...inventoryHooks,
};

export async function applyComputed(store: SheetStore, sheet: string, rows: Row[]): Promise<Row[]> {
  const compute = hooks[sheet]?.computed;
  if (compute && rows.length > 0) await compute(store, rows);
  return rows;
}
