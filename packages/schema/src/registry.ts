import type { SheetDef } from './types.ts';
import { accountsSheet, journalEntriesSheet, journalLinesSheet, trialBalanceSheet } from './sheets/accounting.ts';
import { itemsSheet } from './sheets/items.ts';
import {
  goodsReceiptsSheet,
  purchaseOrderLinesSheet,
  purchaseOrdersSheet,
  supplierBillsSheet,
  supplierPaymentsSheet,
  suppliersSheet,
} from './sheets/purchasing.ts';
import { stockLevelsSheet } from './sheets/stock-levels.ts';
import { stockMovementsSheet } from './sheets/stock-movements.ts';
import { warehousesSheet } from './sheets/warehouses.ts';

/** Every sheet the app knows about, in sidebar order. Add a module = add its sheet definitions here. */
export const sheets: readonly SheetDef[] = [
  itemsSheet,
  warehousesSheet,
  stockMovementsSheet,
  stockLevelsSheet,
  suppliersSheet,
  purchaseOrdersSheet,
  purchaseOrderLinesSheet,
  goodsReceiptsSheet,
  supplierBillsSheet,
  supplierPaymentsSheet,
  accountsSheet,
  journalEntriesSheet,
  journalLinesSheet,
  trialBalanceSheet,
];

export const getSheet = (key: string): SheetDef | undefined => sheets.find((s) => s.key === key);
