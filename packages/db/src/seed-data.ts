import type { CellValue } from '@erp/schema';

/** Starter rows so the grids aren't empty on first run. */
export const seedData: Record<string, Record<string, CellValue>[]> = {
  warehouses: [
    { code: 'MAIN', name: 'Main warehouse', address: 'Industrieweg 12, 2000 Antwerpen' },
    { code: 'BXL', name: 'Brussels depot', address: 'Rue de la Loi 200, 1000 Bruxelles' },
  ],
  items: [
    { sku: 'BOLT-M8', name: 'Hex bolt M8 x 40', unit: 'box', category: 'Fasteners', cost: 6.4, reorderPoint: 20 },
    { sku: 'BOLT-M10', name: 'Hex bolt M10 x 50', unit: 'box', category: 'Fasteners', cost: 8.9, reorderPoint: 15 },
    { sku: 'NUT-M8', name: 'Hex nut M8', unit: 'box', category: 'Fasteners', cost: 3.1, reorderPoint: 25 },
    { sku: 'WASH-M8', name: 'Flat washer M8', unit: 'box', category: 'Fasteners', cost: 2.2, reorderPoint: 25 },
    { sku: 'PIPE-CU-15', name: 'Copper pipe 15 mm', unit: 'm', category: 'Plumbing', cost: 7.75, reorderPoint: 50 },
    { sku: 'PIPE-CU-22', name: 'Copper pipe 22 mm', unit: 'm', category: 'Plumbing', cost: 11.5, reorderPoint: 40 },
    { sku: 'VALVE-BALL-15', name: 'Ball valve 15 mm', unit: 'pcs', category: 'Plumbing', cost: 9.95, reorderPoint: 10 },
    { sku: 'CABLE-3G2.5', name: 'Cable 3G2.5 mm²', unit: 'm', category: 'Electrical', cost: 1.85, reorderPoint: 200 },
    { sku: 'SOCKET-2P', name: 'Wall socket 2P+E', unit: 'pcs', category: 'Electrical', cost: 4.6, reorderPoint: 30 },
    { sku: 'GLUE-PU', name: 'PU construction glue 310 ml', unit: 'pcs', category: 'Chemicals', cost: 5.3, reorderPoint: 12 },
    { sku: 'PAINT-W-10', name: 'Wall paint white 10 l', unit: 'pcs', category: 'Chemicals', cost: 42, reorderPoint: 6 },
    { sku: 'SAND-C', name: 'Construction sand', unit: 'kg', category: 'Bulk', cost: 0.06, reorderPoint: 1000 },
  ],
  // Items and warehouses are referenced by SKU and code; the API resolves them to ids.
  stockMovements: [
    { date: '2026-10-01', type: 'Receipt', item: 'BOLT-M8', warehouse: 'MAIN', qty: 40, unitCost: 6.2, reference: 'Opening stock' },
    { date: '2026-10-01', type: 'Receipt', item: 'NUT-M8', warehouse: 'MAIN', qty: 60, unitCost: 3, reference: 'Opening stock' },
    { date: '2026-10-01', type: 'Receipt', item: 'PIPE-CU-15', warehouse: 'MAIN', qty: 120, unitCost: 7.5, reference: 'Opening stock' },
    { date: '2026-10-01', type: 'Receipt', item: 'CABLE-3G2.5', warehouse: 'BXL', qty: 500, unitCost: 1.8, reference: 'Opening stock' },
    { date: '2026-10-01', type: 'Receipt', item: 'PAINT-W-10', warehouse: 'BXL', qty: 8, unitCost: 41, reference: 'Opening stock' },
    { date: '2026-10-05', type: 'Receipt', item: 'BOLT-M8', warehouse: 'MAIN', qty: 20, unitCost: 6.8, reference: 'Supplier delivery' },
    { date: '2026-10-06', type: 'Issue', item: 'BOLT-M8', warehouse: 'MAIN', qty: 45, reference: 'Job 1042' },
    { date: '2026-10-07', type: 'Transfer', item: 'PIPE-CU-15', warehouse: 'MAIN', toWarehouse: 'BXL', qty: 30, reference: 'Restock Brussels' },
    { date: '2026-10-08', type: 'Adjustment', item: 'PAINT-W-10', warehouse: 'BXL', qty: -1, reason: 'Damaged bucket' },
  ],
  suppliers: [
    { code: 'FAST', name: 'Fastenix BV', contact: 'An Peeters', email: 'orders@fastenix.example', paymentTermsDays: 30 },
    { code: 'PLUMB', name: 'Plumbex SA', contact: 'Marc Dubois', email: 'sales@plumbex.example', paymentTermsDays: 45 },
    { code: 'ELEC', name: 'Elektro Wouters', contact: 'Sofie Wouters', paymentTermsDays: 30 },
  ],
  purchaseOrders: [
    { number: 'PO-00001', supplier: 'FAST', orderDate: '2026-10-09', expectedDate: '2026-10-16', warehouse: 'MAIN', notes: 'Monthly fasteners' },
    { number: 'PO-00002', supplier: 'PLUMB', orderDate: '2026-10-12', warehouse: 'MAIN' },
  ],
  purchaseOrderLines: [
    { po: 'PO-00001', item: 'BOLT-M8', qty: 100, unitPrice: 6.5 },
    { po: 'PO-00001', item: 'NUT-M8', qty: 100, unitPrice: 3.05 },
    { po: 'PO-00001', item: 'WASH-M8', qty: 200, unitPrice: 2.1 },
    { po: 'PO-00002', item: 'VALVE-BALL-15', qty: 20, unitPrice: 9.8 },
    { po: 'PO-00002', item: 'PIPE-CU-22', qty: 60, unitPrice: 11.2 },
  ],
  // Goods receipts and bills need a sent PO; seed.ts sends PO-00001 before adding them.
  goodsReceipts: [
    { date: '2026-10-10', po: 'PO-00001', item: 'BOLT-M8', qty: 100, reference: 'DN-5531' },
    { date: '2026-10-10', po: 'PO-00001', item: 'NUT-M8', qty: 40, reference: 'DN-5531' },
  ],
  supplierBills: [{ billNo: 'F-2026-1187', po: 'PO-00001', date: '2026-10-11', amount: 772 }],
  // seed.ts posts the bill before paying part of it.
  supplierPayments: [{ date: '2026-10-12', supplier: 'FAST', billNo: 'F-2026-1187', amount: 500, reference: 'Bank transfer' }],
  departments: [
    { code: 'OPS', name: 'Operations' },
    { code: 'SALES', name: 'Sales' },
    { code: 'ADM', name: 'Administration' },
  ],
  employees: [
    { code: 'LJ', name: 'Lotte Janssens', email: 'lotte@example.com', department: 'OPS', title: 'Warehouse lead', startDate: '2024-03-01' },
    { code: 'TC', name: 'Tom Claes', email: 'tom@example.com', department: 'SALES', title: 'Account manager', startDate: '2025-01-15' },
    { code: 'SE', name: 'Sara El Amrani', email: 'sara@example.com', department: 'ADM', title: 'Office manager', startDate: '2023-09-04' },
  ],
  // seed.ts submits all three, approves the first two and pays the first.
  expenseClaims: [
    { number: 'EC-00001', employee: 'LJ', date: '2026-10-02', category: 'Travel', description: 'Train to supplier visit, Gent', amount: 84.5 },
    { number: 'EC-00002', employee: 'TC', date: '2026-10-06', category: 'Meals', description: 'Client lunch', amount: 42 },
    { number: 'EC-00003', employee: 'SE', date: '2026-10-09', category: 'Supplies', description: 'Printer paper', amount: 19.99, account: '6400' },
  ],
};

/** Actions run during seeding, before the sheet named in `before` is filled (or after the one in `after`). */
export const seedActions: { before?: string; after?: string; sheet: string; match: { column: string; value: string }; action: string }[] = [
  { before: 'goodsReceipts', sheet: 'purchaseOrders', match: { column: 'number', value: 'PO-00001' }, action: 'send' },
  { before: 'supplierPayments', sheet: 'supplierBills', match: { column: 'billNo', value: 'F-2026-1187' }, action: 'post' },
  ...['EC-00001', 'EC-00002', 'EC-00003'].map((value) => ({ after: 'expenseClaims', sheet: 'expenseClaims', match: { column: 'number', value }, action: 'submit' })),
  ...['EC-00001', 'EC-00002'].map((value) => ({ after: 'expenseClaims', sheet: 'expenseClaims', match: { column: 'number', value }, action: 'approve' })),
  { after: 'expenseClaims', sheet: 'expenseClaims', match: { column: 'number', value: 'EC-00001' }, action: 'pay' },
];
