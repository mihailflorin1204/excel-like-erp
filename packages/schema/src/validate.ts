import { checkNumber, parseCellInput } from './parse.ts';
import type { CellValue, SheetDef } from './types.ts';

export interface CellError {
  column?: string;
  message: string;
}

export interface ValidationResult {
  values: Record<string, CellValue>;
  errors: CellError[];
}

/**
 * Validates the values of one row. The grid and the API both run this, so a red cell in the browser
 * and a rejected cell on the server always agree.
 *
 * - `insert`: every required column must have a value.
 * - `update`: only the columns sent are checked; a required column can't be cleared.
 */
export function validateValues(
  sheet: SheetDef,
  input: Record<string, unknown>,
  mode: 'insert' | 'update',
): ValidationResult {
  const values: Record<string, CellValue> = {};
  const errors: CellError[] = [];

  for (const [key, raw] of Object.entries(input)) {
    const column = sheet.columns.find((c) => c.key === key);
    if (!column) {
      errors.push({ column: key, message: 'Unknown column' });
      continue;
    }
    if (column.computed || column.system) {
      errors.push({ column: key, message: 'Read-only column' });
      continue;
    }

    let value: CellValue;
    if (raw === null || raw === undefined) {
      value = null;
    } else if (typeof raw === 'string') {
      const parsed = parseCellInput(column, raw);
      if (!parsed.ok) {
        errors.push({ column: key, message: parsed.error });
        continue;
      }
      value = parsed.value;
    } else if (typeof raw === 'number' && (column.type === 'number' || column.type === 'currency')) {
      const checked = checkNumber(column, raw);
      if (!checked.ok) {
        errors.push({ column: key, message: checked.error });
        continue;
      }
      value = checked.value;
    } else {
      errors.push({ column: key, message: `Expected ${column.type}` });
      continue;
    }

    if (value === null && column.required) {
      errors.push({ column: key, message: 'Required' });
      continue;
    }
    values[key] = value;
  }

  if (mode === 'insert') {
    for (const column of sheet.columns) {
      if (column.required && !column.computed && !column.system && !(column.key in input)) {
        errors.push({ column: column.key, message: 'Required' });
      }
    }
  }

  return { values, errors };
}

/** Key used to compare values of a unique column: text is matched case-insensitively. */
export const uniqueKey = (value: CellValue): string | null =>
  value === null ? null : typeof value === 'string' ? value.toLowerCase() : String(value);
