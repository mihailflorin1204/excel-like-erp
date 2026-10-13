import { defineSheet } from '../types.ts';

export const PO_STATES = ['Draft', 'Sent', 'Closed'] as const;

export const suppliersSheet = defineSheet({
  key: 'suppliers',
  label: 'Suppliers',
  module: 'purchasing',
  description: 'Companies you buy from.',
  columns: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, maxLength: 20, width: 110 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120, width: 220 },
    { key: 'contact', label: 'Contact', type: 'text', maxLength: 80, width: 150 },
    { key: 'email', label: 'Email', type: 'text', maxLength: 120, width: 200 },
    { key: 'phone', label: 'Phone', type: 'text', maxLength: 40, width: 130 },
    { key: 'paymentTermsDays', label: 'Terms (days)', type: 'number', integer: true, min: 0, width: 110 },
    // Value still to be delivered on sent purchase orders.
    { key: 'openOrders', label: 'Open orders', type: 'currency', computed: true, width: 120 },
  ],
});

/**
 * Purchase order headers. Draft → Sent (lines locked, goods can be received) → Closed (no more deliveries).
 * The lines live in their own flat sheet, Purchase order lines.
 */
export const purchaseOrdersSheet = defineSheet({
  key: 'purchaseOrders',
  label: 'Purchase orders',
  module: 'purchasing',
  description: 'Leave PO number blank to number it automatically. Add lines in Purchase order lines, then Send.',
  drillDown: { label: 'Show lines', sheet: 'purchaseOrderLines', column: 'number' },
  actions: [
    { key: 'send', label: 'Send', description: 'Mark the PO as sent to the supplier; its lines are locked and goods can be received' },
    { key: 'receiveAll', label: 'Receive all', description: 'Post a goods receipt for everything still outstanding' },
    { key: 'close', label: 'Close', description: 'No more deliveries expected; whatever is outstanding is cancelled' },
  ],
  lockRule: {
    column: 'state',
    editableWhen: ['Draft'],
    alwaysEditable: ['expectedDate', 'notes'],
    deletableWhen: ['Draft'],
    message: 'This PO has been sent: only Expected date and Notes can change. Use Close to stop further deliveries.',
  },
  columns: [
    { key: 'number', label: 'PO number', type: 'text', unique: true, maxLength: 20, width: 115 },
    { key: 'supplier', label: 'Supplier', type: 'ref', required: true, ref: { sheet: 'suppliers', display: 'code' }, width: 110 },
    { key: 'orderDate', label: 'Order date', type: 'date', defaultToday: true, width: 110 },
    { key: 'expectedDate', label: 'Expected', type: 'date', width: 110 },
    { key: 'warehouse', label: 'Deliver to', type: 'ref', required: true, ref: { sheet: 'warehouses', display: 'code' }, width: 100 },
    { key: 'notes', label: 'Notes', type: 'text', maxLength: 300, width: 200 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 140 },
    { key: 'total', label: 'Total', type: 'currency', computed: true, width: 110 },
    { key: 'received', label: 'Received', type: 'currency', computed: true, width: 110 },
    { key: 'billed', label: 'Billed', type: 'currency', computed: true, width: 110 },
    { key: 'lineCount', label: 'Lines', type: 'number', computed: true, width: 70 },
    { key: 'state', label: 'State', type: 'enum', options: PO_STATES, system: true, hidden: true },
  ],
});

/** Every PO line in one flat sheet. Filter on a PO number to see one order. */
export const purchaseOrderLinesSheet = defineSheet({
  key: 'purchaseOrderLines',
  label: 'Purchase order lines',
  module: 'purchasing',
  description: 'One row per item per PO. Lines can be changed while the PO is a draft. Blank price = the item’s default cost.',
  lockRule: {
    column: 'poState',
    editableWhen: ['Draft'],
    message: 'The PO has been sent, so its lines are locked.',
  },
  columns: [
    { key: 'po', label: 'PO', type: 'ref', required: true, immutable: true, ref: { sheet: 'purchaseOrders', display: 'number' }, width: 115 },
    { key: 'item', label: 'Item', type: 'ref', required: true, ref: { sheet: 'items', display: 'sku' }, width: 140 },
    { key: 'qty', label: 'Qty', type: 'number', required: true, width: 80 },
    { key: 'unitPrice', label: 'Unit price', type: 'currency', min: 0, width: 100 },
    { key: 'lineTotal', label: 'Line total', type: 'currency', computed: true, width: 110 },
    { key: 'received', label: 'Received', type: 'number', computed: true, width: 90 },
    { key: 'outstanding', label: 'Outstanding', type: 'number', computed: true, width: 105 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 130 },
    { key: 'supplier', label: 'Supplier', type: 'ref', ref: { sheet: 'suppliers', display: 'code' }, computed: true, width: 100 },
    { key: 'poState', label: 'PO state', type: 'text', computed: true, hidden: true },
  ],
});

/**
 * Deliveries against sent POs. Each row posts a Receipt in Stock movements at the PO line's price.
 * A ledger like stock movements: rows are locked, mistakes are fixed with Reverse.
 */
export const goodsReceiptsSheet = defineSheet({
  key: 'goodsReceipts',
  label: 'Goods receipts',
  module: 'purchasing',
  description: 'What arrived, per PO and item. Each row adds stock at the PO price. Saved rows are locked; use Reverse.',
  appendOnly: true,
  actions: [
    { key: 'reverse', label: 'Reverse', description: 'Cancel the receipt and take its stock back out' },
  ],
  columns: [
    { key: 'date', label: 'Date', type: 'date', defaultToday: true, width: 110 },
    { key: 'po', label: 'PO', type: 'ref', required: true, ref: { sheet: 'purchaseOrders', display: 'number' }, width: 115 },
    { key: 'item', label: 'Item', type: 'ref', required: true, ref: { sheet: 'items', display: 'sku' }, width: 140 },
    { key: 'qty', label: 'Qty', type: 'number', required: true, width: 80 },
    // Blank = the PO's Deliver to warehouse.
    { key: 'warehouse', label: 'Warehouse', type: 'ref', ref: { sheet: 'warehouses', display: 'code' }, width: 105 },
    { key: 'reference', label: 'Delivery note', type: 'text', maxLength: 80, width: 130 },
    { key: 'unitCost', label: 'Unit cost', type: 'currency', system: true, width: 100 },
    { key: 'value', label: 'Value', type: 'currency', system: true, width: 105 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 90 },
    { key: 'line', label: 'PO line', type: 'text', system: true, hidden: true, indexed: true },
    { key: 'movement', label: 'Stock movement', type: 'text', system: true, hidden: true },
    { key: 'reversalOf', label: 'Reversal of', type: 'text', system: true, hidden: true },
    { key: 'reversedBy', label: 'Reversed by', type: 'text', system: true, hidden: true },
  ],
});

export const BILL_STATES = ['Draft', 'Posted', 'Reversed'] as const;

/**
 * Supplier invoices, matched against what was received on the PO. A draft can be corrected; Post books it
 * (Dr Goods received not invoiced / Cr Accounts payable) and locks it. Pay it in Supplier payments.
 */
export const supplierBillsSheet = defineSheet({
  key: 'supplierBills',
  label: 'Supplier bills',
  module: 'purchasing',
  description: 'Invoices from suppliers, per PO. Enter as draft, then Post to book it. Difference compares billed with received on the PO.',
  refreshAfterSave: true,
  actions: [
    { key: 'post', label: 'Post', description: 'Book the bill in the ledger (it is locked afterwards)' },
    { key: 'payInFull', label: 'Pay in full', description: 'Record a payment, dated today, for what is still open on the bill' },
    { key: 'reverse', label: 'Reverse', description: 'Cancel a posted bill that has no payments' },
  ],
  lockRule: {
    column: 'state',
    editableWhen: ['Draft'],
    alwaysEditable: ['notes'],
    deletableWhen: ['Draft'],
    message: 'This bill is posted: only Notes can change. Use Reverse to cancel it.',
  },
  columns: [
    { key: 'billNo', label: 'Bill no.', type: 'text', required: true, immutable: true, maxLength: 40, width: 120 },
    { key: 'po', label: 'PO', type: 'ref', required: true, immutable: true, ref: { sheet: 'purchaseOrders', display: 'number' }, width: 115 },
    { key: 'supplier', label: 'Supplier', type: 'ref', ref: { sheet: 'suppliers', display: 'code' }, computed: true, width: 100 },
    { key: 'date', label: 'Bill date', type: 'date', defaultToday: true, width: 110 },
    { key: 'dueDate', label: 'Due', type: 'date', computed: true, width: 110 },
    { key: 'amount', label: 'Amount', type: 'currency', required: true, min: 0, width: 110 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 100 },
    { key: 'paid', label: 'Paid', type: 'currency', computed: true, width: 105 },
    { key: 'open', label: 'Open', type: 'currency', computed: true, width: 105 },
    { key: 'notes', label: 'Notes', type: 'text', maxLength: 300, width: 180 },
    { key: 'poReceived', label: 'PO received', type: 'currency', computed: true, width: 115 },
    { key: 'poBilled', label: 'PO billed', type: 'currency', computed: true, width: 110 },
    { key: 'difference', label: 'Difference', type: 'currency', computed: true, width: 110 },
    { key: 'match', label: 'Match', type: 'text', computed: true, width: 140 },
    // Set when posted: how much cleared Goods received not invoiced, and the rest booked as price variance.
    { key: 'variance', label: 'Price variance', type: 'currency', system: true, width: 115 },
    { key: 'grniCleared', label: 'GRNI cleared', type: 'currency', system: true, hidden: true },
    { key: 'state', label: 'State', type: 'enum', options: BILL_STATES, system: true, hidden: true },
    { key: 'journalEntry', label: 'Journal entry', type: 'text', system: true, hidden: true },
    { key: 'reversalEntry', label: 'Reversal entry', type: 'text', system: true, hidden: true },
  ],
});

/**
 * Payments to suppliers against posted bills (Dr Accounts payable / Cr Bank). A ledger: saved rows are
 * locked, mistakes are fixed with Reverse.
 */
export const supplierPaymentsSheet = defineSheet({
  key: 'supplierPayments',
  label: 'Supplier payments',
  module: 'purchasing',
  description: 'Money paid against posted bills. Type the supplier and its bill no. Saved rows are locked; use Reverse.',
  appendOnly: true,
  actions: [{ key: 'reverse', label: 'Reverse', description: 'Cancel the payment; the bill is open again' }],
  columns: [
    { key: 'date', label: 'Date', type: 'date', defaultToday: true, width: 110 },
    { key: 'supplier', label: 'Supplier', type: 'ref', required: true, ref: { sheet: 'suppliers', display: 'code' }, width: 100 },
    { key: 'billNo', label: 'Bill no.', type: 'text', required: true, maxLength: 40, width: 120 },
    { key: 'amount', label: 'Amount', type: 'currency', required: true, width: 110 },
    { key: 'reference', label: 'Reference', type: 'text', maxLength: 80, width: 160 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 90 },
    { key: 'bill', label: 'Bill', type: 'text', system: true, hidden: true, indexed: true },
    { key: 'journalEntry', label: 'Journal entry', type: 'text', system: true, hidden: true },
    { key: 'reversalOf', label: 'Reversal of', type: 'text', system: true, hidden: true },
    { key: 'reversedBy', label: 'Reversed by', type: 'text', system: true, hidden: true },
  ],
});
