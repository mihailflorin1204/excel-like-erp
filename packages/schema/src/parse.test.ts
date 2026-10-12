import { describe, expect, it } from 'vitest';
import { formatCell, parseCellInput, parseDate, parseNumber } from './parse.ts';
import { itemsSheet } from './sheets/items.ts';
import { validateValues } from './validate.ts';

const col = (key: string) => itemsSheet.columns.find((c) => c.key === key)!;

describe('parseNumber', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    ['12,5', 12.5],
    ['1,234', 1234],
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['1.234.567', 1234567],
    ['1 234,5', 1234.5],
    ['€ 9,99', 9.99],
    ['$1,000', 1000],
    ['(40)', -40],
    ['-3.25', -3.25],
  ])('%s → %s', (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it.each(['abc', '1.2.3,4,5', '12a', '', '--1'])('rejects %s', (input) => {
    expect(parseNumber(input)).toBeNull();
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-10-12', '2026-10-12'],
    ['12/10/2026', '2026-10-12'],
    ['12.10.2026', '2026-10-12'],
    ['1/2/26', '2026-02-01'],
  ])('%s → %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it.each(['31/02/2026', '2026-13-01', 'tomorrow'])('rejects %s', (input) => {
    expect(parseDate(input)).toBeNull();
  });
});

describe('parseCellInput', () => {
  it('matches enum options case-insensitively', () => {
    expect(parseCellInput(col('unit'), 'PCS')).toEqual({ ok: true, value: 'pcs' });
    expect(parseCellInput(col('unit'), 'crate').ok).toBe(false);
  });

  it('rounds currency to cents and enforces min', () => {
    expect(parseCellInput(col('cost'), '12,345')).toEqual({ ok: true, value: 12345 });
    expect(parseCellInput(col('cost'), '12.345')).toEqual({ ok: true, value: 12.35 });
    expect(parseCellInput(col('cost'), '-1').ok).toBe(false);
  });

  it('requires whole numbers where configured', () => {
    expect(parseCellInput(col('reorderPoint'), '2.5')).toEqual({ ok: false, error: 'Must be a whole number' });
  });

  it('treats blank as empty', () => {
    expect(parseCellInput(col('name'), '   ')).toEqual({ ok: true, value: null });
  });
});

describe('validateValues', () => {
  it('needs every required column on insert', () => {
    const r = validateValues(itemsSheet, { sku: 'A-1' }, 'insert');
    expect(r.errors.map((e) => e.column).sort()).toEqual(['name', 'unit']);
  });

  it('only checks sent columns on update, and blocks clearing a required one', () => {
    expect(validateValues(itemsSheet, { cost: 5 }, 'update').errors).toEqual([]);
    expect(validateValues(itemsSheet, { name: '' }, 'update').errors).toEqual([{ column: 'name', message: 'Required' }]);
  });

  it('rejects computed and unknown columns', () => {
    const r = validateValues(itemsSheet, { onHand: 4, colour: 'red' }, 'update');
    expect(r.errors.map((e) => e.message)).toEqual(['Read-only column', 'Unknown column']);
  });
});

describe('formatCell', () => {
  it('formats currency with the locale', () => {
    expect(formatCell(col('cost'), 1234.5, 'en-US')).toBe('1,234.50');
    expect(formatCell(col('cost'), 1234.5, 'de-DE')).toBe('1.234,50');
  });
});
