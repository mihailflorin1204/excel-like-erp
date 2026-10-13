import type { AuditEntry, CellValue, Row, RowsResponse, SheetDef } from '@erp/schema';

/** Everything one batch writes. The store applies it all in one transaction, or nothing. */
export interface CommitPlan {
  sheet: SheetDef;
  inserts: Row[];
  updates: { id: string; expectedVersion: number; set: Record<string, CellValue>; updatedAt: string }[];
  deletes: { id: string; expectedVersion: number }[];
  audit: AuditEntry[];
  /** All or nothing: if any update or delete hits a changed row, save nothing and throw ConflictError. */
  atomic?: boolean;
  /**
   * Writes to other sheets in the same transaction (e.g. a goods receipt and its stock movement).
   * These are always all-or-nothing: a conflict in any of them saves nothing and throws ConflictError.
   */
  related?: CommitPlan[];
}

/** An atomic commit found a row changed since it was read. Nothing was saved. */
export class ConflictError extends Error {
  constructor(public readonly ids: string[]) {
    super('Rows changed since they were read');
    this.name = 'ConflictError';
  }
}

export interface CommitResult {
  /** Updates and deletes skipped because the row's version moved on (or the row vanished). */
  conflictIds: string[];
}

/** Thrown when a write would break a unique column. The whole batch is rolled back. */
export class DuplicateKeyError extends Error {
  constructor(
    public readonly sheet: string,
    public readonly column: string,
  ) {
    super(`Duplicate value in ${sheet}.${column}`);
    this.name = 'DuplicateKeyError';
  }
}

export interface ListOptions {
  offset: number;
  limit: number;
}

/**
 * The only way the API touches data. Two implementations:
 * MongoStore (real database, transactions) and MemoryStore (no setup, for demos and tests).
 */
export interface SheetStore {
  /** Creates collections and indexes for the given sheets. Safe to call on every start. */
  init(sheets: readonly SheetDef[]): Promise<void>;
  listRows(sheet: string, options: ListOptions): Promise<RowsResponse>;
  getRows(sheet: string, ids: readonly string[]): Promise<Row[]>;
  /** Rows whose unique column matches any of the keys (lower-cased text, see uniqueKey). */
  findByUnique(sheet: string, column: string, keys: readonly string[]): Promise<Row[]>;
  commit(plan: CommitPlan): Promise<CommitResult>;
  /** Rows whose `column` equals any of `values`, in insertion order. Omit `values` for every row of the sheet. */
  listWhere(sheet: string, column: string, values?: readonly string[]): Promise<Row[]>;
  listAudit(sheet: string, rowId: string, limit: number): Promise<AuditEntry[]>;
  isEmpty(sheet: string): Promise<boolean>;
  close(): Promise<void>;
}
