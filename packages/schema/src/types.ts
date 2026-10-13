/** Column types a sheet can use. `ref` points at a row in another sheet (stored as its id, shown as e.g. its SKU). */
export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'enum' | 'ref';

/** What a single cell holds once parsed: text, a number, an ISO date string, or empty. */
export type CellValue = string | number | null;

export type ModuleKey = 'inventory' | 'purchasing' | 'accounting' | 'hr';

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  /** Must have a value on every row. */
  required?: boolean;
  /** No two rows may share a value (checked case-insensitively for text). */
  unique?: boolean;
  /** Calculated by the server when rows are read; never stored, read-only in the grid. */
  computed?: boolean;
  /** Stored, but filled in by the server's posting rules (e.g. a movement's cost); read-only in the grid. */
  system?: boolean;
  /** Kept on the row but not shown in the grid (bookkeeping fields). */
  hidden?: boolean;
  /** Typed when the row is created, then read-only (e.g. which PO a bill belongs to). */
  immutable?: boolean;
  /** For `date` columns: a new row left blank gets today's date (the user's local date, filled by the browser). */
  defaultToday?: boolean;
  /** For `ref` columns: the sheet it points at and the unique column people type to pick a row. */
  ref?: { sheet: string; display: string };
  /** Allowed values for `enum` columns. */
  options?: readonly string[];
  /** Lowest allowed number for `number` / `currency`. */
  min?: number;
  /** Whole numbers only. */
  integer?: boolean;
  /** Longest allowed text. Defaults to 500. */
  maxLength?: number;
  /** Looked up often by the server (e.g. a status), so the database indexes it. Reference columns always are. */
  indexed?: boolean;
  /** Initial column width in pixels. */
  width?: number;
}

export interface SheetAction {
  key: string;
  label: string;
  description: string;
}

/**
 * Locks saved rows depending on one of their values (a status). The value may be computed, e.g. a PO line
 * reads its order's status.
 */
export interface LockRule {
  column: string;
  /** Values of `column` in which the row can be edited (and deleted, unless `deletableWhen` says otherwise). */
  editableWhen: readonly string[];
  /** Columns that stay editable whatever the status (e.g. notes). */
  alwaysEditable?: readonly string[];
  deletableWhen?: readonly string[];
  /** Shown when someone tries to change a locked row. */
  message: string;
}

export interface SheetDef {
  key: string;
  label: string;
  module: ModuleKey;
  description?: string;
  columns: readonly ColumnDef[];
  /** Saved rows can't be edited or deleted (a ledger); mistakes are fixed with an action such as Reverse. */
  appendOnly?: boolean;
  /** Rows are calculated by the server (a report); nothing can be typed in. */
  virtual?: boolean;
  /** Buttons that act on selected saved rows. */
  actions?: readonly SheetAction[];
  lockRule?: LockRule;
  /** Reload this sheet after each save, because rows' computed values depend on other rows (e.g. bill totals). */
  refreshAfterSave?: boolean;
  /** A button that opens another sheet filtered on the selected rows' `column` value (e.g. a PO's lines). */
  drillDown?: { label: string; sheet: string; column: string };
  /**
   * Groups of columns where a new row needs a value in at least one (e.g. a journal line's Debit or Credit).
   * The grid waits for it before saving a new row.
   */
  requireOneOf?: readonly (readonly string[])[];
  /** For virtual (report) sheets: date inputs shown above the grid and sent as query parameters (e.g. from / to). */
  params?: readonly { key: string; label: string }[];
}

/** A stored row as the API returns it. */
export interface Row {
  id: string;
  version: number;
  values: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
}

/** Identity helper that keeps literal types and documents intent. */
export const defineSheet = <const T extends SheetDef>(sheet: T): T => sheet;

/** Columns people can type into. */
export const editableColumns = (sheet: SheetDef): ColumnDef[] =>
  sheet.columns.filter((c) => !c.computed && !c.system);

/** Columns kept in the database (typed or filled by posting rules). */
export const storedColumns = (sheet: SheetDef): ColumnDef[] => sheet.columns.filter((c) => !c.computed);

export const uniqueColumns = (sheet: SheetDef): ColumnDef[] =>
  sheet.columns.filter((c) => c.unique && !c.computed);

export const isReadOnlyColumn = (c: ColumnDef): boolean => !!(c.computed || c.system);

/** Why a saved row's cell can't be edited, or null if it can. `values` should include computed columns. */
export function editBlockedReason(sheet: SheetDef, values: Record<string, CellValue>, column: ColumnDef): string | null {
  if (isReadOnlyColumn(column)) return 'Read-only column';
  if (sheet.virtual) return 'This is a calculated report';
  if (sheet.appendOnly) return "Saved rows can't be changed here. Select the row and use Reverse instead.";
  if (column.immutable) return `${column.label} can't be changed after the row is saved`;
  const rule = sheet.lockRule;
  if (rule && !rule.alwaysEditable?.includes(column.key) && !rule.editableWhen.includes(String(values[rule.column] ?? ''))) {
    return rule.message;
  }
  return null;
}

/** Why a saved row can't be deleted, or null if it can. */
export function deleteBlockedReason(sheet: SheetDef, values: Record<string, CellValue>): string | null {
  if (sheet.virtual) return 'This is a calculated report';
  if (sheet.appendOnly) return "Saved rows can't be deleted here. Select the row and use Reverse instead.";
  const rule = sheet.lockRule;
  if (rule && !(rule.deletableWhen ?? rule.editableWhen).includes(String(values[rule.column] ?? ''))) return rule.message;
  return null;
}
