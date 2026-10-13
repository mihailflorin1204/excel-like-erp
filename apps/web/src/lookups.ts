import { type RefLookup, type Row, uniqueKey } from '@erp/schema';

export interface LookupOption {
  value: string;
  label: string;
}

/**
 * The browser's copy of referenced sheets (items by SKU, warehouses by code), used to show a reference as its
 * SKU, to turn a typed or pasted SKU back into an id, and to offer choices in the cell editor.
 */
export class RefLookups implements RefLookup {
  private sheets = new Map<string, { byId: Map<string, string>; byKey: Map<string, string>; options: LookupOption[] }>();

  /** Loads or replaces one referenced sheet. `display` is the column people type (e.g. sku). */
  set(sheet: string, display: string, rows: readonly Row[]): void {
    const byId = new Map<string, string>();
    const byKey = new Map<string, string>();
    const options: LookupOption[] = [];
    for (const r of rows) {
      const text = r.values[display];
      if (text === null || text === undefined) continue;
      byId.set(r.id, String(text));
      byKey.set(uniqueKey(text)!, r.id);
      options.push({ value: String(text), label: String(r.values.name ?? '') });
    }
    this.sheets.set(sheet, { byId, byKey, options });
  }

  resolve(sheet: string, text: string): string | null {
    const s = this.sheets.get(sheet);
    if (!s) return null;
    return s.byKey.get(uniqueKey(text)!) ?? (s.byId.has(text) ? text : null);
  }

  display(sheet: string, id: string): string | null {
    return this.sheets.get(sheet)?.byId.get(id) ?? null;
  }

  options(sheet: string): LookupOption[] {
    return this.sheets.get(sheet)?.options ?? [];
  }
}
