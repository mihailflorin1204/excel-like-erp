import { defineSheet } from '../types.ts';

export const itemsSheet = defineSheet({
  key: 'items',
  label: 'Items',
  module: 'inventory',
  description: 'Products you buy and stock.',
  columns: [
    { key: 'sku', label: 'SKU', type: 'text', required: true, unique: true, maxLength: 40, width: 130 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200, width: 260 },
    { key: 'unit', label: 'Unit', type: 'enum', required: true, options: ['pcs', 'box', 'kg', 'g', 'l', 'm'], width: 80 },
    { key: 'category', label: 'Category', type: 'text', maxLength: 80, width: 150 },
    { key: 'cost', label: 'Cost', type: 'currency', min: 0, width: 110 },
    { key: 'reorderPoint', label: 'Reorder point', type: 'number', integer: true, min: 0, width: 120 },
    // Sum of stock movements for the item. Movements arrive in Phase 2, so this reads 0 until then.
    { key: 'onHand', label: 'On hand', type: 'number', computed: true, width: 100 },
  ],
});
