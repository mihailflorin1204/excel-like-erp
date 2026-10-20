import { type CellValue, type ColumnDef, formatCell, type ViewConfig } from '@erp/schema';
import type { RefLookups } from './lookups.ts';

export type FormulaDef = ViewConfig['formulas'][number];

/** A column as the grid shows it: a sheet column, or a scratch formula column from the view. */
export type ShownColumn = { kind: 'data'; column: ColumnDef } | { kind: 'formula'; formula: FormulaDef; column: ColumnDef };

export const DEFAULT_VIEW: ViewConfig = { query: '', sort: null, hidden: [], frozen: 1, formulas: [] };

/** A stand-in column definition for a formula column: read-only, shown like a computed column. */
const formulaColumn = (f: FormulaDef): ColumnDef => ({ key: f.key, label: f.label, type: 'text', computed: true, width: 140 });

export function shownColumns(columns: readonly ColumnDef[], config: ViewConfig): ShownColumn[] {
  const hidden = new Set(config.hidden);
  return [
    ...columns.filter((c) => !hidden.has(c.key)).map((column) => ({ kind: 'data' as const, column })),
    ...config.formulas.map((formula) => ({ kind: 'formula' as const, formula, column: formulaColumn(formula) })),
  ];
}

/** Next free formula key: f1, f2… */
export const nextFormulaKey = (formulas: readonly FormulaDef[]) =>
  `f${Math.max(0, ...formulas.map((f) => Number(f.key.slice(1)) || 0)) + 1}`;

/** Spreadsheet column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * Turns `=[Qty]*[Unit price]` into `=D5*E5` for spreadsheet row 5. Names match a column's label or key, case
 * insensitive. Returns an error message for unknown names.
 */
export function translateFormula(formula: string, letters: ReadonlyMap<string, string>, row: number): { ok: true; text: string } | { ok: false; error: string } {
  const body = formula.trim().startsWith('=') ? formula.trim() : `=${formula.trim()}`;
  let unknown: string | null = null;
  // Leave text in quotes alone: "[a]" inside a string is not a column.
  const text = body.replace(/("(?:[^"]|"")*")|\[([^\]]+)\]/g, (match, quoted: string | undefined, name: string | undefined) => {
    if (quoted) return quoted;
    const letter = letters.get(name!.trim().toLowerCase());
    if (!letter) {
      unknown ??= name!;
      return match;
    }
    return `${letter}${row}`;
  });
  return unknown ? { ok: false, error: `No column [${unknown}]` } : { ok: true, text };
}

/** What the formula engine gets for a cell: numbers stay numbers, references their display text. */
function engineValue(column: ColumnDef, value: CellValue, locale: string, refs?: RefLookups): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const text = column.type === 'ref' ? formatCell(column, value, locale, refs) : String(value);
  // A leading = would be read as a formula; a leading apostrophe keeps it text, as in Excel.
  return text.startsWith('=') ? `'${text}` : text;
}

export type FormulaResult = number | string | boolean | null;

/**
 * Calculates every formula column for every row with HyperFormula (an Excel-compatible engine, loaded on
 * first use). Formula columns may use each other. Results are only shown, never saved.
 * Returns, per formula key, one value per row (an error shows as e.g. "#DIV/0!" or "No column [x]").
 */
export async function computeFormulas(
  columns: readonly ColumnDef[],
  rows: readonly Record<string, CellValue>[],
  formulas: readonly FormulaDef[],
  locale: string,
  refs?: RefLookups,
): Promise<Map<string, FormulaResult[]>> {
  const out = new Map<string, FormulaResult[]>();
  if (formulas.length === 0) return out;
  const { HyperFormula } = await import('hyperformula');
  const letters = new Map<string, string>();
  const add = (name: string, letter: string) => {
    if (!letters.has(name.toLowerCase())) letters.set(name.toLowerCase(), letter);
  };
  columns.forEach((c, i) => add(c.label, columnLetter(i)));
  formulas.forEach((f, i) => add(f.label, columnLetter(columns.length + i)));
  columns.forEach((c, i) => add(c.key, columnLetter(i)));
  formulas.forEach((f, i) => add(f.key, columnLetter(columns.length + i)));

  const problems = new Map<string, string>();
  const data = rows.map((values, r) => [
    ...columns.map((c) => engineValue(c, values[c.key] ?? null, locale, refs)),
    ...formulas.map((f) => {
      const t = translateFormula(f.formula, letters, r + 1);
      if (!t.ok) {
        problems.set(f.key, t.error);
        return null;
      }
      return t.text;
    }),
  ]);
  const hf = HyperFormula.buildFromArray(data.length > 0 ? data : [[]], {
    licenseKey: 'gpl-v3',
    dateFormats: ['YYYY-MM-DD', 'DD/MM/YYYY'],
    useColumnIndex: false,
  });
  try {
    const values = hf.getSheetValues(0);
    formulas.forEach((f, i) => {
      const col = columns.length + i;
      const problem = problems.get(f.key);
      out.set(
        f.key,
        rows.map((_, r) => {
          if (problem) return problem;
          const v = values[r]?.[col] ?? null;
          if (v !== null && typeof v === 'object') return String((v as { value?: unknown }).value ?? '#ERROR!');
          return v as FormulaResult;
        }),
      );
    });
  } finally {
    hf.destroy();
  }
  return out;
}

export function formatResult(v: FormulaResult, locale: string): string {
  if (v === null) return '';
  if (typeof v === 'number') return v.toLocaleString(locale, { maximumFractionDigits: 4 });
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

/** Sort key of a cell: numbers compare as numbers, everything else as text; blanks always go last. */
export type SortValue = number | string | null;

export function compareSortValues(a: SortValue, b: SortValue, dir: 'asc' | 'desc'): number {
  if (a === null || a === '') return b === null || b === '' ? 0 : 1;
  if (b === null || b === '') return -1;
  const order =
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? order : -order;
}

/** Orders row indices by a sort key; ties keep their original order. */
export function sortIndices(indices: readonly number[], key: (i: number) => SortValue, dir: 'asc' | 'desc'): number[] {
  return indices
    .map((i, pos) => ({ i, pos, k: key(i) }))
    .sort((x, y) => compareSortValues(x.k, y.k, dir) || x.pos - y.pos)
    .map((x) => x.i);
}
