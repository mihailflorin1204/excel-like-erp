import type { SheetDef } from './types.ts';
import { itemsSheet } from './sheets/items.ts';
import { warehousesSheet } from './sheets/warehouses.ts';

/** Every sheet the app knows about. Add a module = add its sheet definitions here. */
export const sheets: readonly SheetDef[] = [itemsSheet, warehousesSheet];

export const getSheet = (key: string): SheetDef | undefined => sheets.find((s) => s.key === key);
