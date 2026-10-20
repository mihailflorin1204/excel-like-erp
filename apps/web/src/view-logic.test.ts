import { itemsSheet } from '@erp/schema';
import { describe, expect, it } from 'vitest';
import {
  columnLetter,
  computeFormulas,
  DEFAULT_VIEW,
  formatResult,
  nextFormulaKey,
  shownColumns,
  sortIndices,
  translateFormula,
} from './view-logic.ts';

describe('formula columns', () => {
  it('numbers spreadsheet columns like Excel', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('turns [Column] names into cells of the same row, leaving text in quotes alone', () => {
    const letters = new Map([['qty', 'D'], ['unit price', 'E']]);
    expect(translateFormula('=[Qty]*[unit price]', letters, 5)).toEqual({ ok: true, text: '=D5*E5' });
    expect(translateFormula('[Qty] + 1', letters, 2)).toEqual({ ok: true, text: '=D2 + 1' });
    expect(translateFormula('=IF([Qty]>0,"[Qty] ok","none")', letters, 3)).toEqual({ ok: true, text: '=IF(D3>0,"[Qty] ok","none")' });
    expect(translateFormula('=[Price]*2', letters, 1)).toEqual({ ok: false, error: 'No column [Price]' });
  });

  it('calculates per row, lets formulas use each other, and shows errors', async () => {
    const columns = itemsSheet.columns.filter((c) => ['sku', 'cost', 'reorderPoint'].includes(c.key));
    const rows = [
      { sku: 'A', cost: 2.5, reorderPoint: 4 },
      { sku: 'B', cost: 10, reorderPoint: 0 },
      { sku: '=evil', cost: null, reorderPoint: 1 },
    ];
    const formulas = [
      { key: 'f1', label: 'Double', formula: '=[Cost]*2' },
      { key: 'f2', label: 'Ratio', formula: '=[Double]/[Reorder point]' },
      { key: 'f3', label: 'Code', formula: '=LOWER([SKU])&"-"&ROUND([cost],0)' },
      { key: 'f4', label: 'Bad', formula: '=[Nope]+1' },
    ];
    const out = await computeFormulas(columns, rows, formulas, 'en-US');
    expect(out.get('f1')).toEqual([5, 20, 0]);
    expect(out.get('f2')).toEqual([1.25, '#DIV/0!', 0]);
    expect(out.get('f3')).toEqual(['a-3', 'b-10', '=evil-0']);
    expect(out.get('f4')).toEqual(['No column [Nope]', 'No column [Nope]', 'No column [Nope]']);
    expect(formatResult(1234.56789, 'en-US')).toBe('1,234.5679');
  });

  it('adds formula columns after the visible sheet columns', () => {
    const shown = shownColumns(itemsSheet.columns, { ...DEFAULT_VIEW, hidden: ['category', 'unit'], formulas: [{ key: 'f1', label: 'X', formula: '=1' }] });
    expect(shown.map((s) => s.column.key)).not.toContain('category');
    expect(shown.at(-1)).toMatchObject({ kind: 'formula', column: { key: 'f1', label: 'X', computed: true } });
    expect(nextFormulaKey([{ key: 'f1', label: 'a', formula: '=1' }, { key: 'f7', label: 'b', formula: '=1' }])).toBe('f8');
  });
});

describe('sorting', () => {
  it('sorts numbers as numbers and text naturally, with blanks last and ties stable', () => {
    const keys = [10, 9, null, 100, 9];
    expect(sortIndices([0, 1, 2, 3, 4], (i) => keys[i]!, 'asc')).toEqual([1, 4, 0, 3, 2]);
    expect(sortIndices([0, 1, 2, 3, 4], (i) => keys[i]!, 'desc')).toEqual([3, 0, 1, 4, 2]);
    const text = ['PO-10', 'po-2', '', 'PO-1'];
    expect(sortIndices([0, 1, 2, 3], (i) => text[i]!, 'asc')).toEqual([3, 1, 0, 2]);
  });
});
