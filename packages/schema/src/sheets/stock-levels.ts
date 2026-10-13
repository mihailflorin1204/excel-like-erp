import { defineSheet } from '../types.ts';

/** Report: quantity of each item in each warehouse, calculated from stock movements. */
export const stockLevelsSheet = defineSheet({
  key: 'stockLevels',
  label: 'Stock levels',
  module: 'inventory',
  description: 'On hand per item and warehouse, calculated from stock movements. Read-only.',
  virtual: true,
  columns: [
    { key: 'item', label: 'Item', type: 'ref', ref: { sheet: 'items', display: 'sku' }, computed: true, width: 140 },
    { key: 'itemName', label: 'Name', type: 'text', computed: true, width: 240 },
    { key: 'warehouse', label: 'Warehouse', type: 'ref', ref: { sheet: 'warehouses', display: 'code' }, computed: true, width: 105 },
    { key: 'onHand', label: 'On hand', type: 'number', computed: true, width: 95 },
    { key: 'unit', label: 'Unit', type: 'text', computed: true, width: 70 },
    { key: 'avgCost', label: 'Avg cost', type: 'currency', computed: true, width: 95 },
    { key: 'value', label: 'Value', type: 'currency', computed: true, width: 110 },
    { key: 'itemOnHand', label: 'Item total', type: 'number', computed: true, width: 95 },
    { key: 'reorderPoint', label: 'Reorder point', type: 'number', computed: true, width: 115 },
    { key: 'stockStatus', label: 'Status', type: 'text', computed: true, width: 90 },
  ],
});
