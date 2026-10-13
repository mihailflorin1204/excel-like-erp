import { defineSheet } from '../types.ts';

export const MOVEMENT_TYPES = ['Receipt', 'Issue', 'Adjustment', 'Transfer'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * The stock ledger. Every change in stock is one row here, and on-hand quantities and values are
 * always sums over this sheet. Saved rows can't be edited: a mistake is fixed with Reverse.
 */
export const stockMovementsSheet = defineSheet({
  key: 'stockMovements',
  label: 'Stock movements',
  module: 'inventory',
  description: 'Every stock change, in order. Saved rows are locked; select a row and Reverse it to undo.',
  appendOnly: true,
  actions: [
    { key: 'reverse', label: 'Reverse', description: 'Post an opposite movement that cancels the selected one' },
  ],
  columns: [
    { key: 'date', label: 'Date', type: 'date', defaultToday: true, width: 110 },
    { key: 'type', label: 'Type', type: 'enum', required: true, options: MOVEMENT_TYPES, width: 110 },
    { key: 'item', label: 'Item', type: 'ref', required: true, ref: { sheet: 'items', display: 'sku' }, width: 140 },
    { key: 'warehouse', label: 'Warehouse', type: 'ref', required: true, ref: { sheet: 'warehouses', display: 'code' }, width: 105 },
    { key: 'toWarehouse', label: 'To warehouse', type: 'ref', ref: { sheet: 'warehouses', display: 'code' }, width: 115 },
    { key: 'qty', label: 'Qty', type: 'number', required: true, width: 80 },
    // Typed for receipts (defaults to the item's default cost); filled with the moving average otherwise.
    { key: 'unitCost', label: 'Unit cost', type: 'currency', min: 0, width: 100 },
    { key: 'reason', label: 'Reason', type: 'text', maxLength: 200, width: 180 },
    { key: 'reference', label: 'Reference', type: 'text', maxLength: 80, width: 120 },
    { key: 'value', label: 'Value', type: 'currency', system: true, width: 105 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 90 },
    // Bookkeeping: effect on `warehouse` (+ in, − out), and links between a movement and its reversal.
    { key: 'signedQty', label: 'Signed qty', type: 'number', system: true, hidden: true },
    { key: 'reversalOf', label: 'Reversal of', type: 'text', system: true, hidden: true },
    { key: 'reversedBy', label: 'Reversed by', type: 'text', system: true, hidden: true },
  ],
});
