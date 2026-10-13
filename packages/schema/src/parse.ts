import type { CellValue, ColumnDef } from './types.ts';

export type ParseResult = { ok: true; value: CellValue } | { ok: false; error: string };

/**
 * Turns what people type in a `ref` column (a SKU, a warehouse code) into the row id it stands for, and back.
 * The browser builds one from the referenced sheets it has loaded. Without one (on the server) the typed text
 * is kept as is and the API resolves it.
 */
export interface RefLookup {
  resolve(sheet: string, text: string): string | null;
  display(sheet: string, id: string): string | null;
}

/**
 * Day/month order used when a typed or pasted date is ambiguous (03/04/2026).
 * 'DMY' matches Belgian and most European Excel exports; switch to 'MDY' for US data.
 */
export const DATE_ORDER: 'DMY' | 'MDY' = 'DMY';

const DEFAULT_MAX_LENGTH = 500;
const CURRENCY_SCALE = 2;

/**
 * Turns what a person typed or pasted into a cell into a typed value.
 * Handles both "1,234.50" and "1.234,50", currency symbols, (negatives) and European dates.
 * Required-ness is not checked here: an empty cell parses to null and the row validator decides.
 */
export function parseCellInput(column: ColumnDef, raw: string, refs?: RefLookup): ParseResult {
  const text = raw.replace(/[  ]/g, ' ').trim();
  if (text === '') return { ok: true, value: null };

  switch (column.type) {
    case 'text': {
      const max = column.maxLength ?? DEFAULT_MAX_LENGTH;
      if (text.length > max) return { ok: false, error: `Too long (max ${max} characters)` };
      return { ok: true, value: text };
    }
    case 'number':
    case 'currency': {
      const n = parseNumber(text);
      if (n === null) return { ok: false, error: 'Not a number' };
      return checkNumber(column, n);
    }
    case 'date': {
      const iso = parseDate(text);
      if (iso === null) return { ok: false, error: 'Not a date (use YYYY-MM-DD or DD/MM/YYYY)' };
      return { ok: true, value: iso };
    }
    case 'enum': {
      const match = column.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      if (!match) return { ok: false, error: `Pick one of: ${(column.options ?? []).join(', ')}` };
      return { ok: true, value: match };
    }
    case 'ref': {
      if (!refs || !column.ref) return { ok: true, value: text };
      const id = refs.resolve(column.ref.sheet, text);
      if (!id) return { ok: false, error: `No ${column.label.toLowerCase()} "${text}"` };
      return { ok: true, value: id };
    }
  }
}

export function checkNumber(column: ColumnDef, n: number): ParseResult {
  if (!Number.isFinite(n)) return { ok: false, error: 'Not a number' };
  if (column.integer && !Number.isInteger(n)) return { ok: false, error: 'Must be a whole number' };
  if (column.min !== undefined && n < column.min) return { ok: false, error: `Must be ${column.min} or more` };
  const value = column.type === 'currency' ? roundTo(n, CURRENCY_SCALE) : n;
  return { ok: true, value };
}

/** Parses "1,234.5", "1.234,5", "€ 12", "(40)", "1 234" and plain numbers. Returns null if it isn't one. */
export function parseNumber(input: string): number | null {
  let s = input.replace(/[€$£¥\s']/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: whichever comes last is the decimal separator.
    normalized = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only commas: "1,234,567" is grouping, "12,5" is a European decimal.
    normalized = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    // Only dots: "1.234.567" is European grouping, "12.5" is a decimal.
    normalized = /^\d{1,3}(\.\d{3}){2,}$/.test(s) ? s.replace(/\./g, '') : s;
  } else {
    normalized = s;
  }
  if ((normalized.match(/\./g) ?? []).length > 1) return null;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY (or MM/DD per DATE_ORDER), DD.MM.YYYY and DD-MM-YYYY. Returns YYYY-MM-DD. */
export function parseDate(input: string): string | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(input);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2]);
    y = Number(match[3]);
    if (y < 100) y += 2000;
    [d, m] = DATE_ORDER === 'DMY' ? [a, b] : [b, a];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** How a value reads in the grid. `locale` controls number grouping and decimal marks. */
export function formatCell(column: ColumnDef, value: CellValue, locale = 'en-US', refs?: RefLookup): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'ref') return refText(column, value, refs);
  if (typeof value === 'number') {
    if (column.type === 'currency') {
      return value.toLocaleString(locale, { minimumFractionDigits: CURRENCY_SCALE, maximumFractionDigits: CURRENCY_SCALE });
    }
    return value.toLocaleString(locale, { maximumFractionDigits: 6 });
  }
  return String(value);
}

/** The text copied to the clipboard: no grouping, so Excel reads it back as a number. */
export function copyText(column: ColumnDef, value: CellValue, locale = 'en-US', refs?: RefLookup): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'ref') return refText(column, value, refs);
  if (typeof value === 'number') {
    return value.toLocaleString(locale, {
      useGrouping: false,
      maximumFractionDigits: column.type === 'currency' ? CURRENCY_SCALE : 6,
    });
  }
  return String(value);
}

/** A ref shown as its display value (SKU, code); "?" if the row it points at is gone or not loaded yet. */
function refText(column: ColumnDef, value: CellValue, refs?: RefLookup): string {
  if (!refs || !column.ref) return String(value);
  return refs.display(column.ref.sheet, String(value)) ?? '?';
}

export const roundTo = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
};
