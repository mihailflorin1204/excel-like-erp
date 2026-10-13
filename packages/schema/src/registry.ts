import type { SheetDef } from './types.ts';
import { itemsSheet } from './sheets/items.ts';
import { stockLevelsSheet } from './sheets/stock-levels.ts';
import { stockMovementsSheet } from './sheets/stock-movements.ts';
import { warehousesSheet } from './sheets/warehouses.ts';

/** Every sheet the app knows about, in sidebar order. Add a module = add its sheet definitions here. */
export const sheets: readonly SheetDef[] = [itemsSheet, warehousesSheet, stockMovementsSheet, stockLevelsSheet];

export const getSheet = (key: string): SheetDef | undefined => sheets.find((s) => s.key === key);
