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
  /** Initial column width in pixels. */
  width?: number;
}

export interface SheetAction {
  key: string;
  label: string;
  description: string;
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
