import { defineSheet } from '../types.ts';

export const itemsSheet = defineSheet({
  key: 'items',
  label: 'Items',
  module: 'inventory',
  description: 'Products you buy and stock. Stock columns are calculated from stock movements.',
  columns: [
    { key: 'sku', label: 'SKU', type: 'text', required: true, unique: true, maxLength: 40, width: 130 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200, width: 240 },
    { key: 'unit', label: 'Unit', type: 'enum', required: true, options: ['pcs', 'box', 'kg', 'g', 'l', 'm'], width: 70 },
    { key: 'category', label: 'Category', type: 'text', maxLength: 80, width: 120 },
    // Used as the unit cost of a receipt when none is typed.
    { key: 'cost', label: 'Default cost', type: 'currency', min: 0, width: 110 },
    { key: 'reorderPoint', label: 'Reorder point', type: 'number', integer: true, min: 0, width: 115 },
    { key: 'onHand', label: 'On hand', type: 'number', computed: true, width: 90 },
    { key: 'avgCost', label: 'Avg cost', type: 'currency', computed: true, width: 95 },
    { key: 'stockValue', label: 'Stock value', type: 'currency', computed: true, width: 110 },
    { key: 'stockStatus', label: 'Status', type: 'text', computed: true, width: 90 },
  ],
});
