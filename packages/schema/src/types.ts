/** Column types a sheet can use. `ref` (lookup into another sheet) arrives with Purchasing in Phase 3. */
export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'enum';

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
  /** Calculated by the server; read-only in the grid. */
  computed?: boolean;
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

export interface SheetDef {
  key: string;
  label: string;
  module: ModuleKey;
  description?: string;
  columns: readonly ColumnDef[];
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

export const editableColumns = (sheet: SheetDef): ColumnDef[] =>
  sheet.columns.filter((c) => !c.computed);

export const uniqueColumns = (sheet: SheetDef): ColumnDef[] =>
  sheet.columns.filter((c) => c.unique && !c.computed);
