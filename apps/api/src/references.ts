import type { SheetStore } from '@erp/db';
import { type BatchError, type CellValue, getSheet, type SheetDef, sheets, uniqueKey } from '@erp/schema';

/**
 * Turns what was typed in `ref` columns (an id, or a display value such as a SKU) into row ids.
 * Unknown values become errors: an insert is rejected, an update keeps its other cells.
 * Returns the tempIds of inserts that must be dropped.
 */
export async function resolveRefs(
  store: SheetStore,
  sheet: SheetDef,
  rows: { kind: 'insert' | 'update'; ref: string; values: Record<string, CellValue> }[],
  errors: BatchError[],
): Promise<Set<string>> {
  const rejected = new Set<string>();
  for (const column of sheet.columns.filter((c) => c.type === 'ref' && c.ref && !c.computed && !c.system)) {
    const target = column.ref!;
    const typed = [
      ...new Set(rows.map((r) => r.values[column.key]).filter((v): v is string => typeof v === 'string')),
    ];
    if (typed.length === 0) continue;

    const resolved = new Map<string, string>();
    for (const r of await store.getRows(target.sheet, typed)) resolved.set(r.id, r.id);
    const byDisplay = typed.filter((t) => !resolved.has(t));
    if (byDisplay.length > 0) {
      const keys = byDisplay.map((t) => uniqueKey(t)!);
      const matches = await store.findByUnique(target.sheet, target.display, keys);
      const idByKey = new Map(matches.map((m) => [uniqueKey(m.values[target.display] ?? null), m.id]));
      for (const t of byDisplay) {
        const id = idByKey.get(uniqueKey(t));
        if (id) resolved.set(t, id);
      }
    }

    for (const r of rows) {
      const v = r.values[column.key];
      if (typeof v !== 'string') continue;
      const id = resolved.get(v);
      if (id) {
        r.values[column.key] = id;
        continue;
      }
      errors.push({ op: r.kind, ref: r.ref, column: column.key, message: `No ${column.label.toLowerCase()} "${v}"` });
      if (r.kind === 'insert') rejected.add(r.ref);
      else delete r.values[column.key];
    }
  }
  return rejected;
}

/** For rows about to be deleted: the label of a sheet that still points at each one (so it can't be deleted). */
export async function findReferences(store: SheetStore, sheetKey: string, ids: readonly string[]): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  if (ids.length === 0) return used;
  for (const other of sheets) {
    if (other.virtual) continue;
    for (const column of other.columns.filter((c) => c.type === 'ref' && c.ref?.sheet === sheetKey && !c.computed)) {
      for (const row of await store.listWhere(other.key, column.key, ids)) {
        const id = String(row.values[column.key]);
        if (!used.has(id)) used.set(id, getSheet(other.key)!.label);
      }
    }
  }
  return used;
}
