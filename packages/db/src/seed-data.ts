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
};
