import { defineSheet } from '../types.ts';

export const warehousesSheet = defineSheet({
  key: 'warehouses',
  label: 'Warehouses',
  module: 'inventory',
  description: 'Places where stock is kept.',
  columns: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, maxLength: 10, width: 100 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120, width: 220 },
    { key: 'address', label: 'Address', type: 'text', maxLength: 300, width: 340 },
  ],
});
