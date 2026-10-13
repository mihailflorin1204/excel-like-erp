import { itemsSheet, parseCellInput, stockMovementsSheet } from '@erp/schema';
import { describe, expect, it } from 'vitest';
import { RefLookups } from './lookups.ts';

const row = (id: string, sku: string) => ({ id, version: 1, values: { sku, name: `Item ${sku}` }, createdAt: '', updatedAt: '' });

describe('RefLookups', () => {
  const lookups = new RefLookups();
  lookups.set('items', 'sku', [row('id-1', 'BOLT-M8'), row('id-2', 'NUT-M8')]);
  const itemColumn = stockMovementsSheet.columns.find((c) => c.key === 'item')!;

  it('turns a typed SKU (any case) into the item id', () => {
    expect(parseCellInput(itemColumn, 'bolt-m8', lookups)).toEqual({ ok: true, value: 'id-1' });
    expect(parseCellInput(itemColumn, 'id-2', lookups)).toEqual({ ok: true, value: 'id-2' });
  });

  it('reports unknown SKUs', () => {
    expect(parseCellInput(itemColumn, 'NOPE', lookups)).toEqual({ ok: false, error: 'No item "NOPE"' });
  });

  it('shows ids as SKUs and lists choices', () => {
    expect(lookups.display('items', 'id-2')).toBe('NUT-M8');
    expect(lookups.options('items')).toEqual([
      { value: 'BOLT-M8', label: 'Item BOLT-M8' },
      { value: 'NUT-M8', label: 'Item NUT-M8' },
    ]);
    expect(itemsSheet.key).toBe('items');
  });
});
